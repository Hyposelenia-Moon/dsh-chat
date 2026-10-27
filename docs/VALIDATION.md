# 验证记录

日期：2026-10-27。环境：Windows，Node.js 24.22.1，npm 11.19.1。

## 自动检查

- `npm test`：**84 项通过**，0 失败，0 跳过。
- `npm run check`：**105** 个 JavaScript/ESM 文件语法检查通过（含 `backend/vendor`）。
- `npm audit --omit=dev`：0 个已知漏洞。直接依赖为 MCP SDK 1.32.2、undici 7.30.1、yaml 2.9.1。
- Yunzai 目录结构加载：在临时 `Yunzai/plugins/dsh-chat` 中加载真实插件入口、三类 apps 和锅巴接口；验证本地服务启动且未 spawn ACP。
- MCP：官方 SDK 客户端连接真实本机 HTTP 服务，验证 initialize、tools/list、tools/call、身份绑定、跨 chat 隔离、轮次失效、输入约束、Origin 拒绝。
- ACP：真实 Node 模拟后端子进程，验证 NDJSON、并发 ID、超时、降级重建、权限、取消与 close drain、异常退出、stderr 分块脱敏、路径含空格。
- 持久化：SQLite v3 迁移、会话恢复、重复消息、人格卡增删改查与按会话绑定、锅巴批量同步、记忆与来源隔离、人格审批/回滚/暂停、任务租约与重试。
- QQ：模拟 OneBot/Yunzai 事件及网关接口，验证从消息到回复的完整插件路径、格式转换、白名单、群管/主人、媒体授权、异步取消、TTS 降级。
- 自动处理：模拟账号模型返回，验证 JSON 流、敏感内容跳过、免费/未知模型拒绝、日限额、取消、候选不自动生效及资源清理。
- 锅巴：schema 包含 `status.*` 只读状态与 `persona.cards` 批量入口；`status` 不会被写回配置。

## 本机后端实测（2026-10-27）

- qq 组合：99 行，启用 **52** 行；`backend-smoke` initialize → new → close → resume → close 通过。
- 模型列表：`session/new` 返回 **26** 个模型（`our-free-model` 23、`our-free-model-region` 1、`deepseek-account` 2）；移除内置渠道包后 `buddy` 渠道不再出现。
- 真实 prompt：`deepseek-account/deepseek-flash` 3.5 s；`our-free-model/kilo-auto/free` 6.9–9.4 s，均为单条回复、turn completed。
- 裁剪：移除 33 个无关重依赖（-1,223.7 MB）与 desktop/web/client 源码（约 125 MB），fork 2,381.3 MB → **1,032.8 MB**；裁剪后上述 smoke 与 prompt 仍通过。
- 隐私：内置 OFM 副本移除 `vendor/channel-pack/`（含 `RACCOON_PHONE_CIPHER_SECRET` 等第三方硬编码凭据）与 EAC 封条材料；移除后 smoke 与真实 prompt 仍通过。
- `dsh-our-free-model` 的 OpenCode/beam 条目在 2026-10-27 21:47 的自检中全部地区受限或额度用尽；Kilo 池可用。

## 尚需部署环境验收

- **最小构建图尚未落地**：当前是"预构建产物 + 裁剪后的安装"，`pnpm build:artifacts` 的构建图仍包含 client/web/desktop；重建需先还原 `D:\dsh-qq-trim\src-*` 并 `pnpm install`。
- 未连接真实 QQ/NapCat 完成收发验收（插件路径已用真实后端 + 假适配器验证到回复）。
- 未取得运行内存、首字延迟分布、模型每轮 token/费用数据；固定 ACP 只报告上下文 `used/size`。

部署顺序：构建/准备后端 → backend-prepare（会装入内置 OFM）→ 独立账号登录 → doctor → backend-smoke → 白名单测试群文本 → MCP 文本工具 → 模型切换 → 重启恢复 → 取消/超时 → 按需逐项启用扩展。真实发送验收由部署者在自己的账号环境执行。

本源码包包含每文件 `SHA256SUMS.txt`。打包排除 node_modules、data、用户配置、登录态和临时文件；交付前检查 ZIP 条目及每文件摘要。
