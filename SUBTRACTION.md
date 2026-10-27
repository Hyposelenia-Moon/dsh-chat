# QQ 后端组合记录

参考来源：`Hyposelenia-Moon/deepseek-harness@22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，包版本 `0.2.1-rc.3`。后端可以在此基础上自行裁剪，插件只校验可运行性。

当前实施 L1+：独立 DSH_HOME 的 qq profile 组合 base + acp-app，再应用 `backend/qq.patch.yml`。已禁用本地文件/终端/web/subagent/workflow/goal/插件管理等模型工具，并额外禁用只服务界面的 `jobs`、`session-title`、`user-questions`、`remote-access`、`typert-gateway`、`plugin-package-inventory-deepseek`、`session-query-sqlite`（组合由 99 行降到 99 行中 52 行启用）。WebUI 已从插件移除，状态与会话摘要改由命令与锅巴承担。

静态组合和 ACP 实测（initialize → new → close → resume → close，以及一次真实 prompt）已验证裁剪后的组合可启动；QQ 发送仍需在真实网关下验收。

构建层（2026-10-27，本机实测）：

- 依赖裁剪：从 `node_modules/.pnpm` 移除了 33 个与 QQ 闭环无关的重包（codex、claude-agent-sdk、libreoffice-kit、mermaid、chrome-devtools-frontend、canvas、pdfjs、rolldown、electron、playwright、typescript、vite 等），**释放 1,223.7 MB**；`node_modules` 从 2,008 MB 降到 795.5 MB。清理清单在 `D:\dsh-qq-trim\prune-*.json`。
- 源码裁剪：把 `apps/desktop`、`apps/desktop-host`、`apps/plugin-market-generator`、`apps/web`、`packages/bundle/web-app`、`packages/client` 移出 fork（合计约 125 MB），存于 `D:\dsh-qq-trim\src-*\`。QQ 闭环对这些包没有依赖（组合里 0 个 client 行）。
- 结果：fork 从 **2,381.3 MB / 141,913 文件** 降到 **1,032.8 MB / 123,318 文件**。
- 裁剪后验证：`backend-smoke` 47 个模型、生命周期通过；`our-free-model/kilo-auto/free` 真实 prompt 8.2 s、单条回复。
- **重建前需还原**：`D:\dsh-qq-trim\src-*\` 的目录移回 fork，并 `pnpm install` 恢复被移除的依赖（`build:artifacts` 的构建图仍包含 client/web/desktop 项目）。当前版本是"预构建产物 + 已裁剪安装"，不是可重复构建的最小构建图；如需长期维护，应单独改 `scripts/build.ts`/`tsconfig.host.json` 的构建图。

`dsh-our-free-model@2.1.0`（MIT）已内置：源码在 `backend/vendor/dsh-our-free-model/`，`backend-prepare` 复制进 `qq` profile 的 `node_modules` 并写入 `dsh.profile.bundles`。再分发副本做了隐私裁剪：整份移除 `vendor/channel-pack/`（13 个第三方账号渠道，含硬编码的 `RACCOON_PHONE_CIPHER_SECRET` 与 Google OAuth 默认凭据代码），并把 EAC 封条材料 `src/vault-data.js`、`src/vault-anchor.js` 置空（`unlockSealedLane()` 返回 null）。裁剪后 `session/new` 返回 26 个模型（`our-free-model` 23、`our-free-model-region` 1、`deepseek-account` 2），`our-free-model/kilo-auto/free` 真实 prompt 9.3 s 通过。它不再作为外部插件安装，也不依赖 web/desktop 前端；`models.allowFree` 默认仍为 `false`，需要时在锅巴打开。
