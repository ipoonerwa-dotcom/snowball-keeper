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
   - **Variable** `SNOWBALL_STAKING` = `0xD01870FFD8Af16FEB1Cd282e0878e8B32B93Fb64`(BSC 主网已部署;预言机 `0x66A3266017446b5F4aACEaC60de7b29eb5508500` 脚本自动从 `staking.oracle()` 读)
   - 可选 Variable:`RPC_URL`、`WINDOW_WAIT_MS`
3. 时间表见 `.github/workflows/keeper.yml`:北京 00:00 / 00:20 / 01:00 三次冗余,首次成功后其余自动早退。也可在 Actions 页手动 Run。

## 本地试跑

```bash
npm install
KEEPER_PK=0x... SNOWBALL_STAKING=0x... node snowball-poke.mjs
```

（合约还没部署时,不填 `SNOWBALL_STAKING` 直接跑会打印「未设 → 跳过」并正常退出。）
