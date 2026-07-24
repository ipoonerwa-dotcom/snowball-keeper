// Snowball 签约 keeper —— 每日「双 poke」把当天奖励按 5 分钟 TWAP 结算入账。
//
// 为什么一次跑里做完两步(refreshBaseline → 等 ~6 分钟 → poke),而不是分两个 cron:
//   预言机要求 observeAndUpdate 的窗口在 [minWindow, maxWindow]=[5min,30min]。GitHub 的 cron 是
//   「尽力而为」、经常延迟几分钟,两个独立 cron 很难稳定卡在 5–30 分钟间隔里。放一个进程里 sleep
//   就与 cron 抖动无关:整体延迟多少都行,反正日结奖励不在乎精确到分钟。
//
// 权限:refreshBaseline / poke 都是 permissionless —— 热钱包只付 gas、无任何角色。漏跑只是当天
//   那一格累加器没记上,不影响本金(本金按时间解锁)、也不影响已累计奖励,补跑即恢复。
//
// 运行:  node snowball-poke.mjs           (跑一轮就退出,适合 cron / GitHub Actions)
// 需要 ethers v6:  npm i ethers
// 环境变量:
//   RPC_URL           BSC RPC(默认公共节点)
//   KEEPER_PK         热钱包私钥(只放少量 BNB 付 gas;绝不用 owner/部署私钥)
//   SNOWBALL_STAKING  签约合约地址(oracle 地址会自动从 staking.oracle() 读)
//   WINDOW_WAIT_MS    refreshBaseline 后等待毫秒数(默认按合约 minWindow + 90s,自动算)

import { ethers } from "ethers";

const RPC = process.env.RPC_URL || "https://bsc-rpc.publicnode.com";
const PK = (() => {
  const k = (process.env.KEEPER_PK || "").trim();
  return k ? (k.startsWith("0x") ? k : "0x" + k) : k;
})();
const STAKING = (process.env.SNOWBALL_STAKING || "").trim();
const OVERRIDE_WAIT = Number(process.env.WINDOW_WAIT_MS || 0);
// 奖励池低余额告警阈值(整枚 SNOWBALL)。低于它且已有签约本金 → 报警,提醒社区 fundReward 补充,
// 避免用户领奖时撞上"发完即止"作废。默认 4000(4 万目标的 10%,留足补币时间)。
const LOW_RESERVE_ALERT = Number(process.env.LOW_RESERVE_ALERT || 4000);

const STAKING_ABI = [
  "function oracle() view returns (address)",
  "function poke() returns (uint256)",
  "function currentDayIdx() view returns (uint256)",
  "function lastPokeTime() view returns (uint256)",
  "function pokeInterval() view returns (uint256)",
  "function rewardReserve() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
];
const ORACLE_ABI = [
  "function refreshBaseline()",
  "function minWindow() view returns (uint256)",
  "function maxWindow() view returns (uint256)",
  "function snowballUsdPrice() view returns (uint256)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 从 ethers 错误里抠出合约 revert 原因(too soon / window too short / baseline stale …)。
function revertReason(e) {
  return (
    e?.reason ||
    e?.shortMessage ||
    e?.info?.error?.message ||
    e?.error?.message ||
    e?.message ||
    String(e)
  );
}

async function main() {
  if (!PK) {
    console.log("KEEPER_PK 未设 —— 跳过(在仓库 Secrets 里加 KEEPER_PK 才会真正运行)。");
    return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(STAKING)) {
    console.log("SNOWBALL_STAKING 未设或非法 —— 跳过(合约部署后把地址填进环境变量)。");
    return;
  }

  const provider = new ethers.JsonRpcProvider(RPC, 56, { staticNetwork: true });
  const wallet = new ethers.Wallet(PK, provider);
  const staking = new ethers.Contract(STAKING, STAKING_ABI, wallet);

  const [bal, oracleAddr, reserve, principal] = await Promise.all([
    provider.getBalance(wallet.address),
    staking.oracle(),
    staking.rewardReserve(),
    staking.totalPrincipal(),
  ]);
  console.log(`keeper 钱包 ${wallet.address}  余额 ${ethers.formatEther(bal)} BNB`);
  console.log(`签约合约 ${STAKING}  预言机 ${oracleAddr}`);

  // 奖励池低余额告警(与 gas / poke 冷却都无关,每轮先查)。目的:快见底前就提醒社区 fundReward 补充,
  // 别等归零 —— 一旦池空时有人领奖,那几天会"发完即止"作废、补币也不追补。
  const reserveTokens = Number(ethers.formatUnits(reserve, 18));
  console.log(`奖励池剩余 ${reserveTokens.toFixed(2)} SNOWBALL  |  签约本金 ${Number(ethers.formatUnits(principal, 18)).toFixed(2)}`);
  if (reserveTokens < LOW_RESERVE_ALERT) {
    if (principal === 0n) {
      console.log(`::notice::奖励池 ${reserveTokens.toFixed(0)} < ${LOW_RESERVE_ALERT},但暂无签约本金;上线前记得 fundReward 注资即可。`);
    } else {
      console.log(`::warning::⚠️ 奖励池仅剩 ${reserveTokens.toFixed(2)} SNOWBALL(< ${LOW_RESERVE_ALERT} 阈值),已有签约本金 ${Number(ethers.formatUnits(principal, 18)).toFixed(2)} —— 请尽快 fundReward 补充,避免用户领奖撞上"发完即止"作废。`);
    }
  }

  if (bal === 0n) {
    console.log("::warning::热钱包 BNB 为 0 —— 无法付 gas,请先充一点 BNB。");
    return;
  }

  // 先看 20 小时冷却:没到就早退,别白做 refreshBaseline + 等 6 分钟。
  const [lastPoke, interval, dayBefore] = await Promise.all([
    staking.lastPokeTime(),
    staking.pokeInterval(),
    staking.currentDayIdx(),
  ]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const nextOk = lastPoke + interval;
  if (now < nextOk) {
    const mins = Number(nextOk - now) / 60;
    console.log(`距离下次可 poke 还有约 ${mins.toFixed(0)} 分钟(20h 冷却未到)—— 本轮跳过。`);
    return;
  }

  const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, wallet);
  const minWindow = await oracle.minWindow(); // 秒
  // 等待 = minWindow + 90s 缓冲(既过 minWindow,又远小于 maxWindow=30min)。可被 WINDOW_WAIT_MS 覆盖。
  const waitMs = OVERRIDE_WAIT > 0 ? OVERRIDE_WAIT : (Number(minWindow) + 90) * 1000;

  // 步骤 1:刷新基线快照
  console.log("① refreshBaseline() …");
  const t1 = await oracle.refreshBaseline({ gasLimit: 200000n });
  await t1.wait(1);
  console.log(`   ✓ ${t1.hash}`);

  // 等窗口成熟
  console.log(`② 等待 ${(waitMs / 60000).toFixed(1)} 分钟让 TWAP 窗口成熟 …`);
  await sleep(waitMs);

  // 步骤 2:结算当天并累加
  console.log("③ poke() …");
  try {
    const t2 = await staking.poke({ gasLimit: 400000n });
    await t2.wait(1);
    const [dayAfter, price] = await Promise.all([staking.currentDayIdx(), oracle.snowballUsdPrice()]);
    console.log(`   ✓ ${t2.hash}`);
    console.log(`   dayIdx ${dayBefore} → ${dayAfter}  |  结算价 $${ethers.formatUnits(price, 18)}`);
    if (dayAfter <= dayBefore) console.log("::warning::dayIdx 未增长,请人工核对。");
  } catch (e) {
    const reason = revertReason(e);
    // too soon / window too short / baseline stale：都不是致命,记一笔下轮再来。
    console.log(`   poke 未成功:${reason}`);
    console.log("::warning::本轮 poke 未入账(非致命,下个周期会重试)。");
  }
}

main().catch((e) => {
  console.error("keeper 异常:", revertReason(e));
  process.exit(1);
});
