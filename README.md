# Robinhood 手续费榜 · 独立推送（GitHub Actions）

完全独立于 Surf 沙盒运行：直接扫链（公共 RPC，无需 API key），每 30 分钟把两个榜单推送到你的 Telegram 机器人。**沙盒休眠也不影响它。**

## 文件

- `push.js` — 主程序：扫链 → 生成「手续费榜」+「手续费/TVL 榜」→ 推给所有机器人
- `lib/onchainFees.js`、`lib/onchainV4.js` — 链上数据（v3 + v4，零依赖）
- `.github/workflows/push.yml` — 每 30 分钟定时任务（`3,33 * * * *`）
- `package.json` — 仅需 Node 18+，无第三方依赖

Telegram 机器人和收件人通过 GitHub Actions Secret `BOT_TOKENS` 配置，不写入代码仓库。

## 部署步骤（约 3 分钟）

1. 在 GitHub 新建一个仓库（**Private 私有**即可，隐私更好）。
2. 把本文件夹 `external-push/` 里的**全部内容**放到仓库根目录（保持目录结构，尤其是 `.github/workflows/push.yml` 的路径）。
   - 可以网页端 “Add file → Upload files” 直接拖拽，或用 git：
     ```bash
     git init && git add . && git commit -m "init"
     git branch -M main
     git remote add origin https://github.com/<你>/<仓库>.git
     git push -u origin main
     ```
3. 打开仓库的 **Actions** 标签页。首次会提示 “I understand my workflows, enable them” → 点击启用。
4. 手动测试一次：Actions → 左侧选 **push-telegram** → 右上 **Run workflow** → 跑完看日志出现 `-> 小白: ok` 等，机器人应立即收到两条榜单。
5. 之后它会**每 30 分钟自动运行**（`:03` 和 `:33`），无需你做任何事。

> ⚠️ GitHub 定时任务是“尽力而为”，高峰时可能延迟几分钟，属正常现象。
> ⚠️ **公共仓库** Actions 分钟数无限；**私有仓库**每月有免费额度（个人账号约 2000 分钟/月，本任务每次约 1–3 分钟，一天 48 次 ≈ 每天 50–150 分钟，可能超免费额度）。如果用私有仓库担心超额，可把频率改成每小时（把 `push.yml` 里 cron 改成 `3 * * * *`），或改用公共仓库。

## 配置 Telegram Secret

在仓库 Settings → Secrets and variables → Actions → New repository secret：
- 名称 `BOT_TOKENS`
- 值：`token1@chatId1:标题1,token2@chatId2:标题2,...`
  例如：`8887817165:AAG...@7574351365:小白,8856114510:AAE...@8251138516:財神`

这是必填配置；未设置时程序会直接失败，不会静默跳过推送。

可选环境变量：
- `WINDOW_MIN`：统计窗口，单位为分钟，范围 1–1440，默认 30。

## 本地测试

```bash
BOT_TOKENS='token@chatId:标题' node push.js
```
会立即扫链并推送一次（用于验证）。
