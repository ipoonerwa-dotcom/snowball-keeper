# Snowball 签约 keeper

每天把 Snowball 签约(SnowballStaking)的**当日金本位奖励**按 5 分钟 TWAP 结算入账。

## 做什么

一次运行里完成「双 poke」:
1. `oracle.refreshBaseline()` —— 记录当前价格累计快照;
2. 等 ~6 分钟(> 预言机 `minWindow` 5 分钟、< `maxWindow` 30 分钟);
3. `staking.poke()` —— 用这段窗口的平均价把当天的 USD 奖励额度折成 SNOWBALL,追加一格累加器。

> 为什么放一个进程里 sleep,而不是两个 cron:GitHub 定时是尽力而为、常延迟几分钟,两个独立 cron 难稳定卡在 5–30 分钟窗口里;单进程 sleep 与 cron 抖动无关。

**全部 permissionless** —— 热钱包只付 gas、无任何权限。漏跑只是当天少记一格(本金按时间解锁、不受影响;已累计奖励也不丢),下轮补上即可。

## 安全

- **绝不**用 owner / 部署 / guardian 私钥。生成一个**全新钱包**,只充少量 BNB 付 gas。
- 合约的 20 小时冷却(`pokeInterval`)保证每天至多结算一次;备份时段的多次触发会自动早退空跑。

## 部署到 GitHub Actions

1. 新建仓库(**建议公开** → Actions 分钟免费),把本目录推上去。
2. Settings → Secrets and variables → Actions:
   - **Secret** `KEEPER_PK` = 新热钱包私钥(`0x…`)
   - **Variable** `SNOWBALL_STAKING` = `0xe04ca7Abe8B8FA905E12678e7Df1F506f88BBc55`(BSC 主网 v2,支持直接转账注资;预言机 `0x66A3266017446b5F4aACEaC60de7b29eb5508500` 脚本自动从 `staking.oracle()` 读)
   - **Variable** `SNOWBALL_BUY_ROUTER` = `0x3f2fdAc1D415436947D8294D833Ee9379a37d518`
     (SnowballBuyRecorder。rank keeper 用它推送**展示用**的等级/团队业绩 —— 新合约不发钱、
      没有奖励池,返佣由项目方按 DApp 后台 `/admin` 的清单人工打款,所以 setStats 推错也不会有资金损失。
      旧的 `0x3B9C…87ff` 按毛买入量自动计佣、已被刷单薅空,现已 setBuyOpen(false) 弃用,**永远不要再给它注资**。)
   - 可选 Variable:`RPC_URL`、`WINDOW_WAIT_MS`、`LOW_RESERVE_ALERT`(奖励池低于此值且已有签约本金 → Actions 报 warning 提醒补币,默认 4000)
3. 时间表见 `.github/workflows/keeper.yml`:北京 00:00 / 00:20 / 01:00 三次冗余,首次成功后其余自动早退。也可在 Actions 页手动 Run。

## 本地试跑

```bash
npm install
KEEPER_PK=0x... SNOWBALL_STAKING=0x... node snowball-poke.mjs
```

（合约还没部署时,不填 `SNOWBALL_STAKING` 直接跑会打印「未设 → 跳过」并正常退出。）
