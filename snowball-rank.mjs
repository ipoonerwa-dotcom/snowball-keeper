// Snowball 邀请 keeper —— 索引 buy-router 的买入/绑定事件,算每个人的团队 U 业绩 + 等级,批量推上链。
//
// 流程:
//   1) getLogs 拉全 ReferrerBound + Bought 事件(从部署块起,分块)
//   2) referrerOf[user] = 绑定事件里的邀请人;selfBuyUsd[buyer] = 该人自身买入 USD 累计
//   3) teamUsd[user] = 整条下线(所有层级后代)的 selfBuyUsd 之和(不含自己)
//   4) rank[user] = 按门槛 TIER_THRESHOLDS 定 V0..V5
//   5) 读链上现值,只对变化的用户 setStats 批量推上链(省 gas)
//
// 权限:热钱包必须是合约的 rankUpdater(owner 部署后 setRankUpdater(该热钱包))。它只推 rank/teamUsd,
//       碰不到任何资金。
//
// 需要 ethers v6:  npm i ethers
// 环境变量:
//   RPC_URL               BSC RPC(推交易 + 读)
//   LOGS_RPC_URL          支持 getLogs 的端点(Alchemy BSC;免费公共节点常封 getLogs)。缺省回退 RPC_URL
//   KEEPER_PK             rankUpdater 热钱包私钥(只推等级,无资金权限)
//   SNOWBALL_BUY_ROUTER   buy-router 地址
//   START_BLOCK           buy-router 部署块(从这块起扫;不填=0,慢)
//   LOG_CHUNK             单次 getLogs 块范围(默认 5000,按端点上限调)
//   TIER_THRESHOLDS       V1..V5 门槛(USD,逗号分隔),默认 5000,10000,20000,35000,50000
//   PUSH_BATCH            单笔 setStats 推多少人(默认 120)

import { ethers } from "ethers";

const RPC = process.env.RPC_URL || "https://bsc-rpc.publicnode.com";
const LOGS_RPC = process.env.LOGS_RPC_URL || RPC;
const PK = (() => { const k = (process.env.KEEPER_PK || "").trim(); return k ? (k.startsWith("0x") ? k : "0x" + k) : k; })();
const ROUTER = (process.env.SNOWBALL_BUY_ROUTER || "").trim();
const START_BLOCK = Number(process.env.START_BLOCK || 0);
const LOG_CHUNK = Number(process.env.LOG_CHUNK || 5000);
const THRESHOLDS = (process.env.TIER_THRESHOLDS || "5000,10000,20000,35000,50000").split(",").map((s) => Number(s.trim()));
const PUSH_BATCH = Number(process.env.PUSH_BATCH || 120);

const ROUTER_ABI = [
  "event ReferrerBound(address indexed user, address indexed referrer)",
  "event Bought(address indexed buyer, address indexed referrer, uint256 bnbIn, uint256 tokensOut, uint256 usdValue, uint256 commission)",
  "function rank(address) view returns (uint8)",
  "function teamUsd(address) view returns (uint256)",
  "function rankUpdater() view returns (address)",
  "function setStats(address[] users, uint8[] ranks, uint256[] teamUsds)",
];

function rankOf(teamUsdNum) {
  let r = 0;
  for (const t of THRESHOLDS) { if (teamUsdNum >= t) r++; else break; }
  return Math.min(r, 5);
}

async function getLogsChunked(provider, address, topics, fromBlock, toBlock) {
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += LOG_CHUNK) {
    const to = Math.min(from + LOG_CHUNK - 1, toBlock);
    let tries = 0;
    while (true) {
      try {
        const logs = await provider.getLogs({ address, topics, fromBlock: from, toBlock: to });
        out.push(...logs);
        break;
      } catch (e) {
        if (++tries >= 3) { console.log(`  getLogs ${from}-${to} 失败(跳过):`, e.shortMessage || e.message); break; }
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }
  return out;
}

async function main() {
  if (!PK) { console.log("KEEPER_PK 未设 —— 跳过。"); return; }
  if (!/^0x[0-9a-fA-F]{40}$/.test(ROUTER)) { console.log("SNOWBALL_BUY_ROUTER 未设或非法 —— 跳过(部署后填)。"); return; }

  const provider = new ethers.JsonRpcProvider(RPC, 56, { staticNetwork: true });
  const logsProvider = new ethers.JsonRpcProvider(LOGS_RPC, 56, { staticNetwork: true });
  const wallet = new ethers.Wallet(PK, provider);
  const iface = new ethers.Interface(ROUTER_ABI);
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);

  const updater = await router.rankUpdater();
  if (updater.toLowerCase() !== wallet.address.toLowerCase()) {
    console.log(`::warning::热钱包 ${wallet.address} 不是 rankUpdater(当前 ${updater})。owner 需 setRankUpdater(该热钱包)。`);
    return;
  }

  const latest = await provider.getBlockNumber();
  console.log(`扫块 ${START_BLOCK}..${latest}  router ${ROUTER}`);

  const boundTopic = iface.getEvent("ReferrerBound").topicHash;
  const boughtTopic = iface.getEvent("Bought").topicHash;
  const rawBound = await getLogsChunked(logsProvider, ROUTER, [boundTopic], START_BLOCK, latest);
  const rawBought = await getLogsChunked(logsProvider, ROUTER, [boughtTopic], START_BLOCK, latest);
  console.log(`ReferrerBound: ${rawBound.length}  Bought: ${rawBought.length}`);

  const referrerOf = new Map(); // user -> referrer
  for (const lg of rawBound) {
    const p = iface.parseLog(lg);
    const user = p.args.user.toLowerCase();
    if (!referrerOf.has(user)) referrerOf.set(user, p.args.referrer.toLowerCase());
  }
  const selfBuyUsd = new Map(); // addr -> bigint(1e18)
  for (const lg of rawBought) {
    const p = iface.parseLog(lg);
    const buyer = p.args.buyer.toLowerCase();
    selfBuyUsd.set(buyer, (selfBuyUsd.get(buyer) || 0n) + p.args.usdValue);
  }

  // children map + full universe of addresses
  const children = new Map();
  const universe = new Set();
  for (const [user, ref] of referrerOf) {
    universe.add(user); universe.add(ref);
    if (!children.has(ref)) children.set(ref, []);
    children.get(ref).push(user);
  }
  for (const a of selfBuyUsd.keys()) universe.add(a);

  // teamUsd = 整条下线 selfBuy 之和(带环保护)
  const memo = new Map(), inProg = new Set();
  function teamSum(u) {
    if (memo.has(u)) return memo.get(u);
    if (inProg.has(u)) return 0n; // cycle guard
    inProg.add(u);
    let s = 0n;
    for (const c of children.get(u) || []) s += (selfBuyUsd.get(c) || 0n) + teamSum(c);
    inProg.delete(u);
    memo.set(u, s);
    return s;
  }

  // compute desired (rank, teamUsd) for everyone, diff vs on-chain
  const users = [...universe];
  const desired = users.map((u) => {
    const tuWei = teamSum(u);
    const tuNum = Number(ethers.formatUnits(tuWei, 18));
    return { u, rank: rankOf(tuNum), teamUsdWei: tuWei };
  });

  // read current on-chain values (chunked Promise.all)
  const changed = [];
  for (let i = 0; i < desired.length; i += 50) {
    const slice = desired.slice(i, i + 50);
    const cur = await Promise.all(
      slice.map(async (d) => {
        const [r, t] = await Promise.all([router.rank(d.u), router.teamUsd(d.u)]);
        return { r: Number(r), t };
      }),
    );
    slice.forEach((d, j) => {
      if (cur[j].r !== d.rank || cur[j].t !== d.teamUsdWei) changed.push(d);
    });
  }
  console.log(`需更新 ${changed.length}/${users.length} 人`);
  if (changed.length === 0) { console.log("无变化,收工。"); return; }

  // push in batches
  for (let i = 0; i < changed.length; i += PUSH_BATCH) {
    const b = changed.slice(i, i + PUSH_BATCH);
    const addrs = b.map((d) => d.u);
    const ranks = b.map((d) => d.rank);
    const tus = b.map((d) => d.teamUsdWei);
    const tx = await router.setStats(addrs, ranks, tus, { gasLimit: 300000n + BigInt(b.length) * 45000n });
    await tx.wait(1);
    console.log(`  setStats ${i}..${i + b.length}  ${tx.hash}`);
  }
  console.log("完成。");
}

main().catch((e) => { console.error("rank keeper 异常:", e.shortMessage || e.message); process.exit(1); });
