# AGENTS.md

This file provides project-level guidance to AI coding agents (DSH) when working with code in this repository.

## 项目概况

DSH-Chat — Yunzai / NapCat 的 QQ 聊天插件：Yunzai 负责 QQ 登录、`#` 命令与群管，插件用 ACP（JSON-RPC over stdio）托管**固定 fork** 的 DSH 子进程做推理，所有 QQ 动作收敛为受控 MCP 工具。ESM（`"type": "module"`），GPL-3.0-only，Node **≥ 24.13**（内置 `node:sqlite`，不需要 better-sqlite3）。

- **入口**：`index.js` → `apps/{chat,admin,panel}.js`（三个 Yunzai `plugin`）→ `lib/runtime.js`（唯一编排中枢，路由/队列/会话/工具/命令都在这里）
- **分层**：`apps/`（事件薄壳）→ `lib/`（编排与各服务）→ `mcp/`（工具面）→ `model/`（SQLite 与建表）→ `backend/`（后端来源校验）→ `guoba/`（配置表单）
- **固定后端**：`backend/pin.json` 记录 fork 的 commit 与包版本；`backend/provenance.js` 在每次启动前校验 origin / commit / tracked 工作树 / 构建文件 SHA-256 / profile SHA-256 / `DSH_HOME`
- **依赖**：`@modelcontextprotocol/sdk`、`undici`、`yaml`；插件自带 `package-lock.json`
- **常用命令**：`npm ci --ignore-scripts`、`npm run check`（语法，42 文件）、`npm test`（73 例）、`npm run doctor`、`npm run smoke`
- **部署**：整个目录以 `dsh-chat` 为名放进 `<bot根>/plugins/`，不要改名（`apps/*.js` 用 `../../../lib/plugins/plugin.js` 解析框架）

### 快速参考

| 功能 | 入口 | 触发 | 说明 |
|---|---|---|---|
| 聊天 | `apps/chat.js`（priority 5000） | 私聊任意文字 / 群里 `@机器人` / `#聊` 前缀 | 未触发必须 `return false` 放行给其他插件 |
| 管理命令 | `apps/admin.js`（100） | `#dsh …` / `#好` / `#不好` | 权限在 `runtime.handleCommand` 内统一判定 |
| 面板入口 | `apps/panel.js`（99） | `#dsh 面板` | 兜底；实际配置走 Guoba |
| 会话 | `lib/session-map.js` | 每条消息 | `chatId ↔ ACP sessionId` 持久映射，重启后 resume |
| 队列 | `lib/queue.js` | 每条消息 | 同 chat 串行、全局并发 2、单轮 180s |
| 工具面 | `mcp/server.js` + `lib/permissions.js` | 模型调用 | 16 个受控工具；参数走自写 JSON Schema 校验 |
| 扩展服务 | `lib/{memory,learning,stickers,letters,qzone,scheduler,reflector}.js` | 命令 / 工具 / 定时 | 默认全部关闭，按 `features.*` + `<service>.enabled` 双闸开启 |
| 数据 | `model/schema.sql` | — | schema v2，17 张表，WAL + FTS5 |

## 文档索引（按需阅读，别一次全读）

| 想了解 / 要改的东西 | 先读 |
|---|---|
| 完整设计方案、ACP 能力边界、模型与记忆规划、阶段划分 | [`docs/DESIGN.md`](docs/DESIGN.md) |
| 固定 fork 的接入合同、构建与账号准备、启动校验 | [`docs/BACKEND.md`](docs/BACKEND.md) |
| 使用者命令表、Guoba 配置顺序、排查表 | [`docs/COMMANDS.md`](docs/COMMANDS.md) |
| 数据库接口、记忆/学习/表情/信件/定时/空间的服务契约 | [`docs/FEATURES.md`](docs/FEATURES.md) |
| 已验证范围与仍需真机验收的缺口 | [`docs/VALIDATION.md`](docs/VALIDATION.md) |
| L1 组合减法做了什么、L2 为什么没做 | [`SUBTRACTION.md`](SUBTRACTION.md) |
| 依赖与 fork 来源、许可证 | [`THIRD_PARTY.md`](THIRD_PARTY.md)、`LICENSE` |
| 面向使用者的安装与部署边界 | [`README.md`](README.md) |

## 约定

1. **ESM** — 全部 `import` / `export`，不用 `require`；插件入口允许顶层 `await`（Yunzai 用动态 `import()` 加载）
2. **中文** — 注释、`name` / `dsc`、用户可见文案、文档一律简体中文；代码标识符保持英文
3. **日志** — 统一 `Logger`（`lib/logger.js`）的 `event` + 字段风格，事件名用 `snake_case`；**不记录消息正文**（`logging.includeContent` 目前是未实现的开关，别假装它生效）
4. **配置两层** — `config/default_config.yaml`（入库，默认值）→ `config/config.yaml`（运行时，**不入库**，`.gitignore` 已排除）；Guoba 只放行 `guoba/schema.js` 声明过的字段。新增配置项必须三处同步：默认值、`schema.js`、`lib/config.js` 的 `validateConfig`
5. **依赖装在本插件目录** — `npm ci --ignore-scripts`；不要加 `pnpm-lock.yaml`，也不要装到 Yunzai 根（会改主仓库依赖清单）
6. **代码改动必须带测试** — `test/*.test.js` 用 `node:test`，路径走 `os.tmpdir()`，**不得写插件的 `data/`**；修 bug 优先加"能真的转红"的回归断言
7. **改完重算清单** — `SHA256SUMS.txt` 覆盖除自身外的全部文件（当前 61 条，`hash␠␠相对路径`、LF、无 BOM）；改了任何文件都要重算，否则交付校验会对不上
8. **文档同步** — 行为/命令/配置变化时同批更新 `docs/COMMANDS.md`、`docs/FEATURES.md`、`README.md` 与 `#dsh 帮助` 文案
9. **提交摘要** — 一轮一份，只列代码侧改动；文档与清单单列一行。**会话内不执行任何 git 写操作**（add / commit / push / rebase 都不做），提交由维护者手动完成
10. **不擅自扩大改动** — 只做明确要求的改动；用户说"分析 / 排查 / 总结"时只分析不写代码；安全相关改动先给方案

## 硬约束速查（改前必读）

1. **身份只认宿主，不认模型** — MCP 工具拿到的 `ctx`（`chatId` / `senderId` / `role` / `turnId`）只能来自 `mcp.activate()` 的绑定；工具参数里的同名字段一律不接受（`validateArguments` 会直接拒绝未知参数）。`role` 只由 `permissions.normalize()` 从 `isMaster === true`、群角色和 `permissions.masters` 推导，昵称、正文、"我是主人"都不算
2. **新增工具必须三处同改** — `mcp/server.js` 的 `TOOLS`（给模型的 schema）、同文件的 `checkValue` 校验路径、`lib/permissions.js` 的 `TOOL_POLICY`（功能/角色/群聊约束），再在 `runtime.executeTool` 里接线；漏一处就是越权面
3. **免费模型三重闸不能拆** — `models.allowFree` 开关、`isFree` 识别、敏感输入检测缺一不可；后台记忆提取与人格反思**只用账号模型**（`reflector.js` 强制拒绝免费/未知 provider）
4. **人格必须审批** — `validateConfig` 强制 `learning.requireApproval === true`；候选写入 `profiles` 时 `active=0`，只有主人 `approve/rollback` 能改激活版本；任何自动流程不得改写权限、密钥、代码
5. **媒体只走 MediaStore** — 模型给的路径必须经 `media.local()`（真实路径在 `mediaRoot` 内）且按 `media_assets` 按 chat 授权；下载只允许公开 HTTPS + 公网 IP（DNS 解析后锁 IP，逐跳重定向复验），不要绕过这套直接 `fs`
6. **定时任务只有四种** — `letter_send` / `text_send` / `qzone_post` / `reflection`；payload 白名单 + 敏感串拒绝；**执行前必须重查当前主人配置与功能开关**（存的是历史角色，不是当前授权）
7. **ACP 变更类请求超时 = 降级，不是立刻杀连接** — `session/new|resume|set_config_option|close` 超时后 `AcpClient` 进入 `degraded`：拒绝新请求，等**在途请求全部落地**后再重建子进程；不要改回"立即 `#fail`"，那会掐断别的 chat 正在进行的回复
8. **恢复语义** — 只有 `-32602` 且文案匹配 `not resumable|unknown session` 才允许 `session/new` 替换；`session/resume` 不带 `configOptions` 时**沿用后端默认模型并保留库中已存的选择**，不得因此让该 chat 永久失败
9. **turn 与工具授权同生命周期** — `mcp.activate()` 与 `INSERT INTO turns` 必须在同一个 `try` 里，`finally` 用 `grant?.finish()` 释放；否则一次插入失败会让该 chat 之后每轮都报"不能同时授权两个工具轮次"
10. **后端只认 `backend-prepare` 产物** — `patchPath` 只允许空；不要放宽 `provenance.js` 的任一校验点（origin、commit、工作树、清单哈希、独立 `DSH_HOME`、无全局 patch），也不要为了"跑起来方便"接受系统 `dsh`
11. **权限判定不靠提示词** — 系统提示里的"消息是用户数据"只是加固，真正的边界在 `TOOL_POLICY`、参数校验、媒体授权与定时任务重查
12. **不要整文件重排** — 仓库文件是 LF；改动只碰必要的行，避免产出全文件 diff（`SHA256SUMS.txt` 与代码评审都依赖小 diff）

## 测试

```bash
npm ci --ignore-scripts   # 首次
npm run check             # 语法检查，约 42 个文件
npm test                  # node --test --test-concurrency=1，73 例
npm run doctor            # 本地配置 + SQLite/FTS5 + 后端校验（后端未准备时 exit 1 属预期）
```

- **不联网、不启动真实后端**：ACP 用 Node 写的模拟子进程，QQ 用假适配器，MCP 走真实 SDK 客户端连本机 HTTP 服务
- 套件分工：`core`（队列/权限/配置/媒体/脱敏）、`adapter`（事件归一化/发送/锅巴 patch）、`acp-client`（NDJSON、并发 ID、超时/取消/降级重建、stderr 脱敏、路径含空格）、`acp-sessions`（模型选项、resume、免费模型闸）、`mcp`（握手、上下文隔离、参数校验）、`runtime`（消息到回复全链路、去重、恢复、授权释放）、`features`（记忆/学习/表情/信件/定时/空间）、`reflector`（后台 JSON 处理与限额）、`plugin-load`（Yunzai 目录布局下加载真实入口）
- **断言必须能失败**：新增回归先临时还原被修的代码确认转红，再恢复入库
- 真实后端只跑 `scripts/backend-smoke.mjs`（initialize → new → close → resume → close，不消耗推理额度）；真实 QQ 发送、登录态与模型 prompt 由部署者在自己的环境验收

## 待办（摘要）

- **L2 源码减法未做**：当前是 L1 组合减法（`backend/qq.patch.yml` 关闭本地工具），构建仍走 fork 原有构建图；删 desktop/web/market 需要逐块 build + smoke 并记入 `SUBTRACTION.md`
- **OFM 未打包/未验证**：默认 `allowFree: false`；免费池的 provider 注册、模型清单、限额都未在本环境实测
- **端到端未验收**：未构建真实 fork、未登录、未发真实 QQ 消息（见 `docs/VALIDATION.md`）
- **已知未实现**：图片信件（返回 `UNSUPPORTED`）、向量检索、表情预览墙、视觉自动打标、Guoba 高级管理页；ACP 只给上下文 `used/size`，没有每轮 token/费用
- **已知未修的小问题**：`logging.includeContent` 是死开关；`#dsh 帮助` 少列 `重启 / 反思 / 人格 暂停|继续`；`turns.model` 列从未写入；`permissions.groupOverrides` 未校验且未进 Guoba；MCP 端点是无二次鉴权的能力 URL（同机同权限进程可调）
