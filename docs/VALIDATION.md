# 验证记录

历史记录日期：2026-10-27。环境：Windows，Node.js 24.22.1，npm 11.19.1。本轮严格安全修复的完整检查结果与最终用例数由主代理汇总，以下历史后端结果不代表新策略已验收。

## 历史自动检查（2026-10-27）

- `npm test`：历史检查通过；本轮最终通过/失败/跳过数量以主代理运行输出为准，不沿用旧固定用例数。
- `npm run check`：历史语法检查通过（含 `backend/vendor`）；文件数量随源码变化，以本轮运行输出为准。
- `npm audit --omit=dev`：0 个已知漏洞。直接依赖为 MCP SDK 1.32.2、undici 7.30.1、yaml 2.9.1。
- Yunzai 目录结构加载：在临时 `Yunzai/plugins/dsh-chat` 中加载真实插件入口、三类 apps 和锅巴接口；验证本地服务启动且未 spawn ACP。
- MCP：官方 SDK 客户端连接真实本机 HTTP 服务，验证 initialize、tools/list、tools/call、身份绑定、跨 chat 隔离、轮次失效、输入约束、Origin 拒绝。
- ACP：真实 Node 模拟后端子进程，验证 NDJSON、并发 ID、超时、降级重建、权限、取消与 close drain、异常退出、stderr 分块脱敏、路径含空格。
- 持久化：SQLite v3 迁移、会话恢复、重复消息、人格卡增删改查与按会话绑定、锅巴批量同步、记忆与来源隔离、人格审批/回滚/暂停、任务租约与重试。
- QQ：模拟 OneBot/Yunzai 事件及网关接口，验证从消息到回复的完整插件路径、格式转换、白名单、群管/主人、媒体授权、异步取消、TTS 降级。
- 自动处理：模拟账号模型返回，验证 JSON 流、敏感内容跳过、免费/未知模型拒绝、日限额、取消、候选不自动生效及资源清理。
- 锅巴：schema 包含 `status.*` 只读状态与 `persona.cards` 批量入口；`status` 不会被写回配置。

## 本轮严格安全修复验证（2026-10-28，仅本地模拟）

- 完整 `node --test --test-concurrency=1`：143 通过、0 失败、0 跳过，退出码 0。
- `node scripts/check.mjs`：111 个 JavaScript 文件语法检查通过。
- `node scripts/smoke.mjs`：22 通过、0 失败、0 跳过，退出码 0；使用模拟 ACP / QQ 与本机 MCP SDK。
- 关键回归通过临时撤回防护确认转红，恢复后全套通过：固定账号、旧 MCP 地址、会话重挂、实际模型验证、完整提示词敏感检测、禁止免费自动备用、工具白名单、历史敏感文本与本机路径过滤、贴纸失败回滚、WebUI 启动共享。

### 已覆盖修复范围

- 模型：账号 provider 仅 `deepseek-account`，unknown 拒绝；自动 fallback 仅账号，绝不自动 free；显式跨账号/免费信任等级新 session；新建/resume 无实际 model 选项拒绝。免费模型检查全组装 prompt（人格/昵称/记忆/正文），拒绝敏感模式及图片/附件；规则非绝对保证。
- 隐私与身份：宿主已知的本轮 QQ 用户/消息只给模型别名（不保证任意文本全部个人信息识别），工具结果逐字段白名单与固定错误；会话、消息/去重、队列、媒体授权和反馈按 selfId 隔离，旧 bare chat 映射不迁移。
- MCP：每 turn 能力 URL 轮换，旧授权失效；下一轮 close/resume 重挂失败 fail closed。**此路径尚未用真实 backend 验证**，不能用历史 smoke 代替。
- 资源：缓存默认 TTL 24h / 128 MiB / 每账号聊天每小时下载 60 次 / 5min 清理；新贴纸默认 256 MiB / 2000 个总量、下载前预留、失败回滚和孤儿清理；反馈默认 3s 冷却 / 每聊天每 UTC 日新增 100 条 / 90 天保留，同用户同消息更新原行。
- WebUI：并发启动共享、启动中 stop 取消清理、错误不带原始 stderr；真实进程启动/停止仍需部署验收。
- 本轮仅本仓库本地改动，不部署、不执行 git 写入、不联网；最终测试总数和哈希清单由主代理统一处理。

## 历史本机后端实测（2026-10-27）

- qq 组合：99 行，启用 **52** 行；`backend-smoke` initialize → new → close → resume → close 通过。
- 模型列表：`session/new` 返回 **26** 个模型（`our-free-model` 23、`our-free-model-region` 1、`deepseek-account` 2）；移除内置渠道包后 `buddy` 渠道不再出现。
- 真实 prompt：`deepseek-account/deepseek-flash` 3.5 s；`our-free-model/kilo-auto/free` 6.9–9.4 s，均为单条回复、turn completed。
- 裁剪：移除 33 个无关重依赖（-1,223.7 MB）与 desktop/web/client 源码（约 125 MB），fork 2,381.3 MB → **1,032.8 MB**；裁剪后上述 smoke 与 prompt 仍通过。
- 隐私：内置 OFM 副本移除 `vendor/channel-pack/`（含 `RACCOON_PHONE_CIPHER_SECRET` 等第三方硬编码凭据）与 EAC 封条材料；移除后 smoke 与真实 prompt 仍通过。
- `dsh-our-free-model` 的 OpenCode/beam 条目在 2026-10-27 21:47 的自检中全部地区受限或额度用尽；Kilo 池可用。

## 模型可用性（2026-10-27，23 个 `our-free-model` 模型）

- Kilo 车道 16 个：**11 个 HTTP 200**（其中 9 个返回文本“正常”；`nemotron-3-ultra-550b-a55b:free` 与 `nemotron-3.5-lightning:free` 返回 200 但正文为空，仅推理内容或空流），**5 个失败**：`liquid/lfm-2.5-2.6b:free`、`poolside/laguna-xs-2.1:free`、`recursive/flint-v1.0:free`、`xingchen-agi/xing4.0-29b-a4b:free` 为上游 429 限流，`stealth/glyph-cluster` 为上游 503。
- 可直接使用（有正文）：`kilo-auto/free`、`openrouter/free`、`reflection/beam-free`、`nvidia/nemotron-3.5-super-vl:free`、`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`、`nvidia/nemotron-3.5-content-safety:free`、`dots-studio/dots-3-note-preview:free`、`cohere/north-mini-code:free`、`poolside/laguna-s-2.1:free`。
- OpenCode/zen 车道 7 个（`flint-40b-free`、`mimo-v2.6-flash-free`、`glm-5.3-flash-free`、`jev-1.13-free`、`deepseek-v4.1-flash-free`、`nemotron-3.5-lightning-free`、`nemotron-3.5-super-vl-free`）未直连测试；OFM 自检显示全部被上游限流或地区封锁。
- `our-free-model-region/beam-free` 此前为地区受限；`deepseek-account` 两模型未重复测试（`deepseek-flash` 已有真实 prompt 记录）。
- 历史免费池探测不作为默认模型建议或当前可用性保证。默认使用已确认的账号模型；免费模型需主人显式启用/选择，并受本轮严格安全策略限制，先 `#dsh模型列表` 确认实际选项。

## 尚需部署环境验收

- 本轮严格安全修复未连接真实 backend 或 QQ；需验证每 turn MCP close/resume 重挂、严格 model 返回、跨信任新 session、账号备用、免费敏感/图片拒绝、同机多账号隔离和 WebUI 并发取消。历史模型 prompt 成功不证明这些新路径可用。

- **最小构建图尚未落地**：当前是"预构建产物 + 裁剪后的安装"，`pnpm build:artifacts` 的构建图仍包含 client/web/desktop；重建需先还原 `D:\dsh-qq-trim\src-*` 并 `pnpm install`。
- 未连接真实 QQ/NapCat 完成收发验收（插件路径已用真实后端 + 假适配器验证到回复）。
- 未取得运行内存、首字延迟分布、模型每轮 token/费用数据；固定 ACP 只报告上下文 `used/size`。

部署顺序：构建/准备后端 → backend-prepare（会装入内置 OFM）→ 独立账号登录 → doctor → backend-smoke → 白名单测试群文本 → MCP 文本工具 → 模型切换 → 重启恢复 → 取消/超时 → 按需逐项启用扩展。真实发送验收由部署者在自己的账号环境执行。

本源码包包含每文件 `SHA256SUMS.txt`。打包排除 node_modules、data、用户配置、登录态和临时文件；交付前检查 ZIP 条目及每文件摘要。
