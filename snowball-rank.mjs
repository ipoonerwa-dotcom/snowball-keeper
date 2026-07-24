// Snowball 邀请 keeper —— 算每个人的团队 U 业绩 + 等级,批量推上链。
//
// ★ 纯链上读,不用 getLogs/Alchemy ★:合约把用户 + 各人买入额存成可枚举的(users[] / selfBuyUsd /
//   referrerOf),这里直接 view 读取(普通 BSC RPC 就行,不受免费档 getLogs 块范围限制)。
//
// 流程:
//   1) usersLength + 遍历 users[] 拿到全部参与者
//   2) 读各人 referrerOf + selfBuyUsd
//   3) teamUsd[user] = 整条下线(所有后代)的 selfBuyUsd 之和(带环保护)
//   4) rank[user] = 按门槛 TIER_THRESHOLDS 定 V0..V5
//   5) 读链上现值,只对变化的用户 setStats 批量推(省 gas)
//
// 权限:热钱包必须是合约的 rankUpdater(owner 部署时已设)。只推 rank/teamUsd,无资金权限。
//
// 环境变量:
//   RPC_URL               BSC RPC(读 + 推交易;公共节点即可,不需要 Alchemy)
//   KEEPER_PK             rankUpdater 热钱包私钥
//   SNOWBALL_BUY_ROUTER   buy-router 地址
//   TIER_THRESHOLDS       V1..V5 门槛(USD,逗号分隔),默认 5000,10000,20000,35000,50000
//   PUSH_BATCH            单笔 setStats 推多少人(默认 120)
//   READ_CHUNK            单批并发读多少个地址(默认 40)

import { ethers } from "ethers";

const RPC = process.env.RPC_URL || "https://bsc-rpc.publicnode.com";
const PK = (() => { const k = (process.env.KEEPER_PK || "").trim(); return k ? (k.startsWith("0x") ? k : "0x" + k) : k; })();
const ROUTER = (process.env.SNOWBALL_BUY_ROUTER || "").trim();
const THRESHOLDS = (process.env.TIER_THRESHOLDS || "5000,10000,20000,35000,50000").split(",").map((s) => Number(s.trim()));
const PUSH_BATCH = Number(process.env.PUSH_BATCH || 120);
const READ_CHUNK = Number(process.env.READ_CHUNK || 40);

const ROUTER_ABI = [
  "function usersLength() view returns (uint256)",
  "function users(uint256) view returns (address)",
  "function referrerOf(address) view returns (address)",
  "function selfBuyUsd(address) view returns (uint256)",
  "function rank(address) view returns (uint8)",
  "function teamUsd(address) view returns (uint256)",
  "function rankUpdater() view returns (address)",
  "function referralPool() view returns (uint256)",
  "function totalOwed() view returns (uint256)",
  "function snowball() view returns (address)",
  "function setStats(address[] users, uint8[] ranks, uint256[] teamUsds)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

function rankOf(teamUsdNum) {
  let r = 0;
  for (const t of THRESHOLDS) { if (teamUsdNum >= t) r++; else break; }
  return Math.min(r, 5);
}

// 分批并发跑,避免一次几百个 eth_call 打爆 RPC
async function mapChunked(items, fn, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const part = await Promise.all(items.slice(i, i + size).map(fn));
    out.push(...part);
  }
  return out;
}

async function main() {
  if (!PK) { console.log("KEEPER_PK 未设 —— 跳过。"); return; }
  if (!/^0x[0-9a-fA-F]{40}$/.test(ROUTER)) { console.log("SNOWBALL_BUY_ROUTER 未设或非法 —— 跳过(部署后填)。"); return; }

  const provider = new ethers.JsonRpcProvider(RPC, 56, { staticNetwork: true });
  const wallet = new ethers.Wallet(PK, provider);
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);

  const updater = await router.rankUpdater();
  if (updater.toLowerCase() !== wallet.address.toLowerCase()) {
    console.log(`::warning::热钱包 ${wallet.address} 不是 rankUpdater(当前 ${updater})。owner 需 setRankUpdater(该热钱包)。`);
    return;
  }

  // 邀请池健康检查(每轮都做,与人数无关):欠佣挂账不作废,但池不够时用户领不全,提醒社区补。
  // 按【合约代币余额】口径算(直接转账的注资未 sync 前 referralPool 账面偏低,余额才是真实可发量)。
  const [poolBooked, owedTotal, snowAddr] = await Promise.all([
    router.referralPool(),
    router.totalOwed(),
    router.snowball(),
  ]);
  const snow = new ethers.Contract(snowAddr, ERC20_ABI, provider);
  const poolBal = await snow.balanceOf(ROUTER);
  const pool = poolBal > poolBooked ? poolBal : poolBooked;
  console.log(`邀请池(余额口径) ${ethers.formatUnits(pool, 18)} SNOWBALL  |  未领返佣 ${ethers.formatUnits(owedTotal, 18)}`);
  if (owedTotal > pool) {
    console.log(`::warning::邀请池缺口 ${ethers.formatUnits(owedTotal - pool, 18)} SNOWBALL —— 直接转 SNOWBALL 到买入合约地址即可补充(欠佣挂账不作废,但补上前用户领不全)。`);
  }

  const n = Number(await router.usersLength());
  console.log(`router ${ROUTER}  参与者 ${n} 人`);
  if (n === 0) { console.log("暂无参与者,收工。"); return; }

  const idx = Array.from({ length: n }, (_, i) => i);
  const users = (await mapChunked(idx, (i) => router.users(i), READ_CHUNK)).map((a) => a.toLowerCase());
  const info = await mapChunked(
    users,
    async (u) => {
      const [ref, self] = await Promise.all([router.referrerOf(u), router.selfBuyUsd(u)]);
      return { u, ref: ref.toLowerCase(), self };
    },
    READ_CHUNK,
  );

  const selfBuyUsd = new Map();
  const children = new Map();
  for (const { u, ref, self } of info) {
    selfBuyUsd.set(u, self);
    if (ref !== "0x0000000000000000000000000000000000000000") {
      if (!children.has(ref)) children.set(ref, []);
      children.get(ref).push(u);
    }
  }

  // teamUsd = 整条下线 selfBuy 之和。环保护:合约不禁互绑(A↔B 可成环),若把环上祖先当子节点
  // 累加,会把"自己的买入"算进自己的团队业绩(左右互绑刷量)。这里遇到祖先(inProg)整个跳过——
  // 环边不计入,自己的买入永远进不了自己的 teamUsd。
  const memo = new Map(), inProg = new Set();
  function teamSum(u) {
    if (memo.has(u)) return memo.get(u);
    if (inProg.has(u)) return 0n;
    inProg.add(u);
    let s = 0n;
    for (const c of children.get(u) || []) {
      if (inProg.has(c)) continue; // back-edge (cycle): skip the ancestor entirely
      s += (selfBuyUsd.get(c) || 0n) + teamSum(c);
    }
    inProg.delete(u);
    memo.set(u, s);
    return s;
  }

  const desired = users.map((u) => {
    const tuWei = teamSum(u);
    return { u, rank: rankOf(Number(ethers.formatUnits(tuWei, 18))), teamUsdWei: tuWei };
  });

  // diff vs 链上现值
  const changed = [];
  await mapChunked(
    desired,
    async (d) => {
      const [r, t] = await Promise.all([router.rank(d.u), router.teamUsd(d.u)]);
      if (Number(r) !== d.rank || t !== d.teamUsdWei) changed.push(d);
    },
    READ_CHUNK,
  );
  console.log(`需更新 ${changed.length}/${n} 人`);
  if (changed.length === 0) { console.log("无变化,收工。"); return; }

  for (let i = 0; i < changed.length; i += PUSH_BATCH) {
    const b = changed.slice(i, i + PUSH_BATCH);
    const tx = await router.setStats(
      b.map((d) => d.u),
      b.map((d) => d.rank),
      b.map((d) => d.teamUsdWei),
      { gasLimit: 300000n + BigInt(b.length) * 45000n },
    );
    await tx.wait(1);
    console.log(`  setStats ${i}..${i + b.length}  ${tx.hash}`);
  }
  console.log("完成。");
}

main().catch((e) => { console.error("rank keeper 异常:", e.shortMessage || e.message); process.exit(1); });
