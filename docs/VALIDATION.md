# 验证记录

日期：2026-10-25。环境：Windows，Node.js 24.19.0，npm 11.17.0。

## 自动检查

- `npm test`：71 项通过，0 失败，0 跳过。
- `npm run check`：42 个 JavaScript/ESM 文件语法检查通过。
- `npm audit --omit=dev`：0 个已知漏洞。直接依赖固定为 MCP SDK 1.32.2、undici 7.30.1、yaml 2.9.1；审计反映当日 registry 已知记录。
- Yunzai 目录结构加载：在临时 `Yunzai/plugins/dsh-chat` 中加载真实插件入口、三类 apps 和锅巴接口；仅用最小 plugin 基类代替 Yunzai 宿主，验证本地服务启动且未 spawn ACP。
- MCP：官方 SDK 客户端连接真实本机 HTTP 服务，验证 initialize、tools/list、tools/call、身份绑定、跨 chat 隔离、轮次失效、输入约束、Origin 拒绝。
- ACP：实际启动 Node 模拟后端子进程，验证 NDJSON、并发 ID、超时、权限、取消与 close drain、异常退出、丢失 new 响应、stderr 分块脱敏、路径含空格。
- 持久化：真实 SQLite、迁移、会话恢复、重复消息、记忆与来源隔离、人格审批/回滚/暂停、任务重开恢复/租约/重试/账号记录。
- QQ：模拟 OneBot/Yunzai 事件及网关接口，验证从消息到回复的完整插件路径、格式转换、白名单、群管/主人、媒体目录及聊天授权、异步取消、TTS 降级、真实能力探测。
- 自动处理：模拟账号模型返回，验证 JSON 流、敏感内容跳过、免费/未知模型拒绝、日限额、取消、候选不自动生效及资源清理。
- 后端组合：读取固定 commit 的真实 base/acp patch 并进行静态组合检查，确认最终无启用的本地模型工具 rows。

## 尚需部署环境验收

- 未在本环境 clone/install/build 完整 DSH fork，未执行真实 `--dump-config`。
- 未完成真实 DSH 订阅登录或发送模型 prompt；未连接 QQ/NapCat 账号或实际空间服务。
- 未验证 OFM 2.1.0 注册、免费池模型、Kilo 限流/地区状态。
- 未取得真实首字延迟、运行内存、后端裁剪包体积或模型每轮 token/费用数据。固定 ACP 仅报告上下文占用。

部署顺序：构建固定 fork → backend-prepare → 独立账号登录 → doctor → backend-smoke → 白名单测试群文本 → MCP 文本工具 → 模型切换 → 重启恢复 → 取消/超时 → 按需逐项启用扩展。真实发送验收由部署者在自己的账号环境执行。

本源码包包含每文件 `SHA256SUMS.txt`。打包排除 node_modules、data、用户配置、登录态和临时文件；交付前检查 ZIP 条目及每文件摘要。
