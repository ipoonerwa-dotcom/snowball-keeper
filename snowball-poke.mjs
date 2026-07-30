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
//   RPC_URL           BSC RPC;留空用自带候选列表,支持逗号分隔多个(逐个尝试)
//   KEEPER_PK         热钱包私钥(只放少量 BNB 付 gas;绝不用 owner/部署私钥)
//   SNOWBALL_STAKING  签约合约地址(oracle 地址会自动从 staking.oracle() 读)
//   WINDOW_WAIT_MS    refreshBaseline 后等待毫秒数(默认按合约 minWindow + 90s,自动算)

import { ethers } from "ethers";

/**
 * 候选 RPC(RPC_URL 支持逗号分隔多个;不设就用这份默认)。
 *
 * 【为什么要一组而不是一个】
 * 2026-07-29 连挂 4 次的真因:publicnode 对 GitHub runner 的机房 IP【只封写不封读】——
 * 所有 view 调用都正常,一到 refreshBaseline() 发交易就 `server response 403 Forbidden`,
 * 脚本 20 多秒就退出、当天奖励没结算。而且这个故障【在本地复现不出来】:同一个节点从家里
 * 发交易完全正常,是按来源 IP 封的。
 * 怎么用见 sendWithFallback —— 不预测、拿真交易挨个试。
 */
const RPC_CANDIDATES = (process.env.RPC_URL || [
  "https://bsc-dataseed.bnbchain.org",
  "https://rpc-bsc.48.club",
  "https://bsc-dataseed1.defibit.io",
  "https://bsc-rpc.publicnode.com",
].join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * 发交易 + 节点故障自动换台。
 *
 * 【为什么不能靠"开跑前探测"】
 * 第一版我用一笔格式错误的假交易去问 eth_sendRawTransaction,想靠"回 JSON-RPC 错误 = 可用"
 * 提前挑节点 —— 线上直接被打脸:publicnode 对畸形假交易正常回错误(判定为可用),
 * 对【真实签名交易】照样 403。也就是说封禁只在真交易上触发,任何代理信号都测不出来。
 * 所以不预测了:直接拿真交易挨个试,某个节点抛错就换下一个。
 *
 * 节点级失败(403/超时/连接断)时交易【根本没广播出去】,nonce 不受影响,换台重发是安全的。
 * @param label 日志用名字
 * @param send  (wallet, provider) => 交易响应;拿到就等 1 个确认
 */
async function sendWithFallback(label, send) {
  let lastErr = null;
  for (const url of RPC_CANDIDATES) {
    try {
      const provider = new ethers.JsonRpcProvider(url, 56, { staticNetwork: true });
      const wallet = new ethers.Wallet(PK, provider);
      const tx = await send(wallet, provider);
      await tx.wait(1);
      console.log(`   ✓ ${label} ${tx.hash}   (${url})`);
      return { tx, url, provider, wallet };
    } catch (e) {
      lastErr = e;
      const msg = revertReason(e);
      console.log(`   ${label} 在 ${url} 失败:${String(msg).slice(0, 90)} —— 换下一个节点`);
    }
  }
  throw lastErr || new Error(`${label}: 所有候选 RPC 都失败`);
}

let RPC = RPC_CANDIDATES[0];
const PK = (() => {
  const k = (process.env.KEEPER_PK || "").trim();
  return k ? (k.startsWith("0x") ? k : "0x" + k) : k;
})();
const STAKING = (process.env.SNOWBALL_STAKING || "").trim();
const OVERRIDE_WAIT = Number(process.env.WINDOW_WAIT_MS || 0);
// 奖励池低余额告警阈值(整枚 SNOWBALL)。低于它且已有签约本金 → 报警,提醒社区 fundReward 补充,
// 避免用户领奖时撞上"发完即止"作废。默认 4000(4 万目标的 10%,留足补币时间)。
const LOW_RESERVE_ALERT = Number(process.env.LOW_RESERVE_ALERT || 4000);
/**
 * 逾期告警阈值(小时):距上次结算超过这么久还没成功结算 → 整个 Action 标红。
 *
 * 为什么必须有:脚本所有早退路径都是 exit 0 = 绿色。7/29~7/30 连着两天没结算,
 * Actions 列表里全是绿勾 + 19 秒,看起来风平浪静 —— 只能等社区来问才发现。
 * 标红之后 GitHub 会自动发邮件,不用再拿社区当监控。
 * 26 小时 = 正常 24 小时 + 2 小时容差(容忍 GitHub 调度抖动)。
 */
const OVERDUE_ALERT_H = Number(process.env.OVERDUE_ALERT_H || 26);

const STAKING_ABI = [
  "function oracle() view returns (address)",
  "function snowball() view returns (address)",
  "function poke() returns (uint256)",
  "function currentDayIdx() view returns (uint256)",
  "function lastPokeTime() view returns (uint256)",
  "function pokeInterval() view returns (uint256)",
  "function rewardReserve() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const ORACLE_ABI = [
  "function refreshBaseline()",
  "function minWindow() view returns (uint256)",
  "function maxWindow() view returns (uint256)",
  "function snowballUsdPrice() view returns (uint256)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本轮有没有真的把当天结算入账(给最后的逾期判断用) */
let pokedThisRun = false;
/** 上次结算时间(秒),读到就填,给最后的逾期判断用 */
let lastPokeSeen = 0;

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

  const [bal, oracleAddr, reserve, principal, snowAddr] = await Promise.all([
    provider.getBalance(wallet.address),
    staking.oracle(),
    staking.rewardReserve(),
    staking.totalPrincipal(),
    staking.snowball(),
  ]);
  // 有效奖励池按【合约代币余额 - 本金】算:社区直接转账的币未 sync 前 rewardReserve 账面偏低,
  // 但合约领取时会自动 sync,所以余额口径才是真实可发量(避免转完账就误报"池空")。
  const snow = new ethers.Contract(snowAddr, ERC20_ABI, provider);
  const tokenBal = await snow.balanceOf(STAKING);
  const effectiveReserve = tokenBal > principal ? tokenBal - principal : reserve;
  console.log(`keeper 钱包 ${wallet.address}  余额 ${ethers.formatEther(bal)} BNB`);
  console.log(`签约合约 ${STAKING}  预言机 ${oracleAddr}`);
  if (bal > 0n && bal < ethers.parseEther("0.005")) {
    console.log("::warning::keeper 热钱包 BNB 低于 0.005,撑不了几天了 —— 请尽快充值。");
  }

  // 奖励池低余额告警(与 gas / poke 冷却都无关,每轮先查)。目的:快见底前就提醒社区补充,
  // 别等归零 —— 一旦池空时有人领奖,那几天会"发完即止"作废、补币也不追补。
  const reserveTokens = Number(ethers.formatUnits(effectiveReserve, 18));
  console.log(`奖励池剩余(余额口径) ${reserveTokens.toFixed(2)} SNOWBALL  |  签约本金 ${Number(ethers.formatUnits(principal, 18)).toFixed(2)}`);
  if (reserveTokens < LOW_RESERVE_ALERT) {
    if (principal === 0n) {
      console.log(`::notice::奖励池 ${reserveTokens.toFixed(0)} < ${LOW_RESERVE_ALERT},但暂无签约本金;上线前把 SNOWBALL 直接转到签约合约地址即可注资。`);
    } else {
      console.log(`::warning::⚠️ 奖励池仅剩 ${reserveTokens.toFixed(2)} SNOWBALL(< ${LOW_RESERVE_ALERT} 阈值),已有签约本金 ${Number(ethers.formatUnits(principal, 18)).toFixed(2)} —— 请尽快补充(直接转 SNOWBALL 到签约合约地址即可),避免用户领奖撞上"发完即止"作废。`);
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
  lastPokeSeen = Number(lastPoke);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const nextOk = lastPoke + interval;
  if (now < nextOk) {
    const mins = Number(nextOk - now) / 60;
    console.log(`距离下次可 poke 还有约 ${mins.toFixed(0)} 分钟(20h 冷却未到)—— 本轮跳过。`);
    return;
  }

  // ── 每个自然日只结算一次(北京时间)──────────────────────────────────
  //
  // 【为什么必须有这条】
  // 合约冷却是 20 小时,比一天短。光靠"冷却到了就 poke"会让结算时间一路往前漂:
  // 今天 00:07 结算 → 冷却 20:07 解除 → 当天 21:00 那个追赶点就会去 poke →
  // 明天变 21 点 → 后天 18 点…… 永远稳不在 0 点,社区每天都要问"怎么时间又变了"。
  //
  // 加上这条之后:正常日子里凌晨那次做完,当天后面所有追赶点都空转;
  // 只有"今天还没结算过"时白天的追赶点才动手 —— 既能追上被故障延后的那天,
  // 又不会把时间往前拽。冷却 20h < 24h 保证了漂移是往 0 点收敛的。
  //
  // 用北京时间切日,因为对社区公示的口径就是"每天 0 点后结算"。
  const bjDay = (epochSec) => Math.floor((Number(epochSec) + 8 * 3600) / 86400); // UTC+8 的日序号
  if (Number(lastPoke) > 0 && bjDay(lastPoke) === bjDay(now)) {
    console.log(
      `今天(北京 ${new Date(Number(now) * 1000).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })})` +
        ` 已经结算过了(${new Date(Number(lastPoke) * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })})—— 本轮跳过。`,
    );
    return;
  }

  const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, wallet);
  const minWindow = await oracle.minWindow(); // 秒
  // 等待 = minWindow + 90s 缓冲(既过 minWindow,又远小于 maxWindow=30min)。可被 WINDOW_WAIT_MS 覆盖。
  const waitMs = OVERRIDE_WAIT > 0 ? OVERRIDE_WAIT : (Number(minWindow) + 90) * 1000;

  // 步骤 1:刷新基线快照
  console.log("① refreshBaseline() …");
  const r1 = await sendWithFallback("refreshBaseline", (w) =>
    new ethers.Contract(oracleAddr, ORACLE_ABI, w).refreshBaseline({ gasLimit: 200000n }),
  );
  // 这台节点刚证明了自己能发交易,后面 poke 优先用它
  const okUrl = r1.url;

  // 等窗口成熟
  console.log(`② 等待 ${(waitMs / 60000).toFixed(1)} 分钟让 TWAP 窗口成熟 …`);
  await sleep(waitMs);

  // 步骤 2:结算当天并累加
  console.log("③ poke() …");
  try {
    const r2 = await sendWithFallback("poke", (w) =>
      new ethers.Contract(STAKING, STAKING_ABI, w).poke({ gasLimit: 400000n }),
    );
    const st2 = new ethers.Contract(STAKING, STAKING_ABI, r2.provider);
    const oc2 = new ethers.Contract(oracleAddr, ORACLE_ABI, r2.provider);
    const [dayAfter, price] = await Promise.all([st2.currentDayIdx(), oc2.snowballUsdPrice()]);
    console.log(`   dayIdx ${dayBefore} → ${dayAfter}  |  结算价 $${ethers.formatUnits(price, 18)}  (发起节点 ${okUrl})`);
    if (dayAfter > dayBefore) pokedThisRun = true;
    else console.log("::warning::dayIdx 未增长,请人工核对。");
  } catch (e) {
    const reason = revertReason(e);
    // too soon / window too short / baseline stale：都不是致命,记一笔下轮再来。
    console.log(`   poke 未成功:${reason}`);
    console.log("::warning::本轮 poke 未入账(非致命,下个周期会重试)。");
  }
}

main()
  .then(() => {
    // 本轮没结算成功、而且距上次结算已经超过阈值 → 标红,让 GitHub 发邮件。
    // 注意不能因为"本轮跳过"就标红:正常日子里一天有 8 个触发点,7 个都该安静跳过。
    if (pokedThisRun || !lastPokeSeen) return;
    const hrs = (Date.now() / 1000 - lastPokeSeen) / 3600;
    if (hrs > OVERDUE_ALERT_H) {
      const when = new Date(lastPokeSeen * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
      console.log(
        `::error::⚠️ 收益已逾期未结算:上次结算是 ${when},距今 ${hrs.toFixed(1)} 小时(阈值 ${OVERDUE_ALERT_H}h)。` +
          `本轮也没能补上 —— 请人工检查(常见原因:RPC 全被封 / 热钱包没 gas / 预言机窗口异常)。`,
      );
      process.exitCode = 1;
    }
  })
  .catch((e) => {
    console.error("keeper 异常:", revertReason(e));
    process.exit(1);
  });
