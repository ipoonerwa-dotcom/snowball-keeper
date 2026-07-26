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

// SnowballBuyRecorder(0x3f2fdAc1…):只记录不发钱,setStats 推的等级/团队业绩【仅供前端展示】,
// 不挂钩任何链上打款(返佣由项目方按 DApp /admin 后台清单人工发放),所以推错不会造成资金损失。
const ROUTER_ABI = [
  "function usersLength() view returns (uint256)",
  "function users(uint256) view returns (address)",
  "function referrerOf(address) view returns (address)",
  "function totalUsdOf(address) view returns (uint256)",
  "function totalTokensOf(address) view returns (uint256)",
  "function rank(address) view returns (uint8)",
  "function teamUsd(address) view returns (uint256)",
  "function statsUpdater() view returns (address)",
  "function snowball() view returns (address)",
  "function setStats(address[] accounts, uint8[] ranks, uint256[] teamUsds)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
// 质押也算持有(买了去签约是最强的留存证明,不能因为币离开钱包就judge成卖出)
const STAKING_ABI = [
  "function positionCount(address) view returns (uint256)",
  "function positions(address,uint256) view returns (uint256,uint256,uint256,uint256,uint256,uint256,bool)",
];
const STAKING = process.env.SNOWBALL_STAKING || "0xe04ca7Abe8B8FA905E12678e7Df1F506f88BBc55";

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

  const updater = await router.statsUpdater();
  if (updater.toLowerCase() !== wallet.address.toLowerCase()) {
    console.log(`::warning::热钱包 ${wallet.address} 不是 statsUpdater(当前 ${updater})。owner 需 setStatsUpdater(该热钱包)。`);
    return;
  }

  const snowAddr = await router.snowball();
  const snow = new ethers.Contract(snowAddr, ERC20_ABI, provider);
  const staking = new ethers.Contract(STAKING, STAKING_ABI, provider);
  // 新合约不托管任何资金,没有邀请池,也没有链上欠佣 —— 返佣走后台清单人工发放,
  // 所以这里不再做"池子够不够"的检查(那是旧的自动发放模式才需要的)。
  const n = Number(await router.usersLength());
  console.log(`recorder ${ROUTER}  参与者 ${n} 人`);
  if (n === 0) { console.log("暂无参与者,收工。"); return; }

  const idx = Array.from({ length: n }, (_, i) => i);
  const users = (await mapChunked(idx, (i) => router.users(i), READ_CHUNK)).map((a) => a.toLowerCase());

  // 社区规则「卖出就不算团队业绩」:每人的有效业绩 = 累计买入USD × 留存比例。
  //   留存 = (钱包余额 + 未取回的质押本金),按【经本 DApp 累计买到的量】封顶
  //   —— 封顶是必须的,否则场外转进来的币会把业绩刷高。
  // 全卖 → 留存 0 → 有效业绩 0;卖一半 → 折半。与 /admin 后台口径完全一致。
  const info = await mapChunked(
    users,
    async (u) => {
      const [ref, boughtUsd, boughtTok, held, posCnt] = await Promise.all([
        router.referrerOf(u), router.totalUsdOf(u), router.totalTokensOf(u),
        snow.balanceOf(u), staking.positionCount(u),
      ]);
      let staked = 0n;
      for (let i = 0; i < Number(posCnt); i++) {
        const p = await staking.positions(u, i);
        if (!p[6]) staked += p[0]; // 未取回的本金
      }
      const kept = held + staked;
      const retained = boughtTok > 0n ? (kept < boughtTok ? kept : boughtTok) : 0n;
      const self = boughtTok > 0n ? (boughtUsd * retained) / boughtTok : 0n;
      return { u, ref: ref.toLowerCase(), self, gross: boughtUsd };
    },
    READ_CHUNK,
  );

  const selfBuyUsd = new Map();
  const children = new Map();
  let grossAll = 0n, netAll = 0n;
  for (const { u, ref, self, gross } of info) {
    selfBuyUsd.set(u, self);
    grossAll += gross; netAll += self;
    if (ref !== "0x0000000000000000000000000000000000000000") {
      if (!children.has(ref)) children.set(ref, []);
      children.get(ref).push(u);
    }
  }
  console.log(`累计买入 $${ethers.formatUnits(grossAll, 18)} → 扣除已卖出后有效 $${ethers.formatUnits(netAll, 18)}`);

  // teamUsd = 整条下线【有效业绩】之和。环保护:合约不禁互绑(A↔B 可成环),若把环上祖先当子节点
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
