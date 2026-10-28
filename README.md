# DSH-Chat

Yunzai / NapCat 的 QQ 聊天插件，通过 ACP stdio 托管固定 DSH fork，使用受控 MCP 工具处理 QQ 操作。设计来源见 `docs/DESIGN.md`。

这是 **0.1.0 源码交付包**。插件及模拟集成测试已实现；包内不含 Yunzai、NapCat、编译后的 DSH、node_modules、登录态或模型额度。真实 QQ + DSH 订阅环境的端到端验收需在部署机完成。详细结果见 `docs/VALIDATION.md`。

## 环境

- Node.js **24.13.0 或更高的 24.x**，使用内置 SQLite，无须编译 better-sqlite3。
- Yunzai V3 兼容插件环境及可用的 QQ 网关；锅巴配置需要 Guoba-Plugin。
- 参考 fork `Hyposelenia-Moon/deepseek-harness`，commit `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`（版本 `0.2.1-rc.3`，无对应 tag）。后端可以基于它自行精简，插件不要求 commit 一致。
- 后端构建依照 fork 使用 pnpm `11.28.5`；插件依赖用 npm lockfile 安装。

## 安装

1. 将整个 `dsh-chat` 文件夹放到 `Yunzai/plugins/dsh-chat`。保留目录名。
2. 在插件目录执行：

   ```powershell
   npm ci --ignore-scripts
   npm run check
   npm test
   ```

   Windows 也可运行 `安装依赖.cmd`。这一步安装插件依赖，不会启动 DSH 或 QQ。

3. 按 `docs/BACKEND.md` 构建后端（可基于固定 fork，也可自行精简），并运行 `scripts/backend-prepare.mjs` 生成独立 `qq` profile 与启动器。
4. 在锅巴中配置 DSH-Chat，或复制 `config/default_config.yaml` 为 `config/config.yaml` 后编辑。最少填写：

   ```yaml
   backend:
     path: 'D:\dsh-qq\dsh.cmd'
     profile: qq
     expectedCommit: 22ddee3792402c3e70ec5f86a63c3e3e895a2f60
     dshHome: 'D:\dsh-qq-data'
     patchPath: ''
   permissions:
     masters: ['主人QQ号']
     groupWhitelist: ['要启用的群号']
     allowAllGroups: false
   ```

   示例中的 QQ 号请改为数字字符串。`DSH_HOME` 必须独立；默认 `~/.dsh`、额外全局 patch 和 `patchPath` 都会被拒绝。`expectedCommit` 只作提示：与后端构建记录的 commit 不一致时 `doctor` 会提示，不阻断启动。

5. 在插件目录运行 `npm run doctor` 检查本地配置和构建。完成后端独立账号授权后重启 Yunzai，私聊机器人或在白名单群内 `@机器人 你好`，也可用 `#聊 你好`。

入口初始化 SQLite、定时任务和配置；第一条 AI 消息才启动 ACP。默认拒绝所有群，需明确填写白名单。不会在聊天时下载后端、安装插件、读取桌面版凭据或更新源码。

## 已提供的功能

| 部分 | 行为 |
| --- | --- |
| 消息路由 | 私聊、@、前缀、引用回复、去重；保留其他 Yunzai `#` 命令 |
| 队列与会话 | 按机器人账号与 chat 隔离，串行、全局并发限制、取消、超时 drain、SQLite 映射与严格恢复 |
| 人格卡 | 多套系统提示词并存，按会话绑定；主人用 `#dsh人格卡` 管理，锅巴可按 JSON 批量同步，数据在插件内 |
| 帮助 | `#dsh帮助` 部署与状态菜单（HTML 图），渲染后端不可用时回退文本 |
| WebUI | 主人私聊 `#dshwebui` 启动官方 DSH 界面（127.0.0.1 随机端口，需先安装 web profile）；`#dshwebui stop` 关闭 |
| 更新 | 主人私聊 `#dsh更新`，对 Git 安装做 fast-forward；与普通 Yunzai 插件一致 |
| 模型 | 读取真实 ACP 选项；账号仅 deepseek-account，unknown 拒绝；自动备用仅账号；免费模型默认关闭 |
| 免费模型 | 内置 `dsh-our-free-model` provider（Kilo 免密钥池），随后端准备一起安装；在锅巴打开「允许免费模型」后可用 |
| MCP | 16 个工具，宿主绑定真实 chat/发送者/角色，工具级权限、开关、频率校验 |
| QQ | 文本、图片、表情、@、引用、受控文件、TTS/音频；按适配器能力发送 |
| 记忆 | 中文检索、本人/本群/全局范围、来源聊天隔离、遗忘与恢复、敏感串过滤、日限额 |
| 学习 | 正负反馈、人格候选、主人审批、已审批版本回滚、持久暂停 |
| 自动处理 | 可选账号模型记忆提取、反馈反思；独立无 MCP 会话，默认关闭，消耗额外模型额度 |
| 信件 | 文本和真实 `.txt` 文件、立即或定时发送 |
| 定时 | 文本、信件、空间发帖、反思；任务租约、账号记录、重启恢复、失败退避、执行前重新校验主人 |
| 锅巴 | 基础配置表单；复杂管理通过命令和服务接口完成 |
| 审计 | SQLite 工具与操作审计、脱敏 JSONL 日志、队列状态、首段文本延迟、上下文占用 |

命令见 `docs/COMMANDS.md`，服务与数据边界见 `docs/FEATURES.md`。

## 启用扩展

扩展默认关闭。以记忆为例，同时开启 `features.memory` 与 `memory.enabled`；自动提取还需 `memory.autoExtract: true`。人格学习对应 `features.learning`、`learning.enabled`；自动反思对应 `learning.autoReflect`。这些字段均可由锅巴配置。自动处理只使用已确认的账号模型，不进入免费池。

`learning.requireApproval` 固定为 true。任何人格候选都不会自动改权限、密钥、代码或激活自身。主人可使用 `#dsh人格候选 …`、`#dsh人格审批 ID` 和 `#dsh人格回滚 ID`。

文件工具只接受受控媒体目录及当前聊天授权的文件。手工导入文件可放在 `data/media/uploads/机器人QQ/group_群号/` 或 `data/media/uploads/机器人QQ/private_QQ号/`。旧无账号目录不会自动授权。其他聊天的信件、图片不会因为猜中路径而被授权。

媒体下载先尝试可控的直接连接，QQ 官方媒体域名直连失败后才使用 `media.proxyUrl` 或进程配置的 HTTPS proxy；不会更改全局代理。模型服务的网络路由由 DSH / provider 配置决定，插件不改写。

## 隐私

- 插件数据都在本机明文：`data/`（SQLite、日志、媒体）、`config/config.yaml`、DSH 的会话与凭据目录；请自行设置访问权限并纳入备份管理，不要连同插件目录一起打包外发。
- WebUI 是官方 DSH 界面，只监听 `127.0.0.1` 随机端口；链接里的 token 等同登录态，只发主人私聊。
- 日志不记录消息正文；宿主已知的本轮 QQ 用户和消息目标只给模型别名，真实 ID 由宿主解析；这不保证任意正文中的所有个人信息都被识别。工具结果逐工具字段白名单输出并脱敏文本；模型与聊天错误使用固定码/文案，不透传原始异常或网关对象。
- 记忆、信件、媒体按聊天授权隔离；跨群的路径猜中也不会授权。
- 对话内容与命中的记忆会发给所选模型 provider；免费模型需显式开启并选择，发送前检查全组装提示词（人格、昵称、记忆、正文等），拒绝敏感模式及图片/附件。规则无法识别全部隐私，不提供绝对保证；免费池上游可能记录提示词。DSH `usage_update` 只给上下文占用量，没有逐轮 token/费用。
- 会话、消息/去重、队列、媒体授权与反馈按 `selfId:chatId` 隔离；缺失 selfId 拒绝，旧 bare chat 会话映射不自动迁移或接管。
- MCP 能力 URL 每 turn 轮换，结束后旧授权失效；下一轮 close/resume 重挂新地址，失败即拒绝 prompt。本机进程窃取本轮能力地址的风险仍存在。
- 媒体缓存默认 TTL 24 小时、128 MiB、每账号聊天每小时下载 60 次、每 5 分钟清理；新贴纸库默认总量 256 MiB / 2000 个，下载前预留、失败回滚并清理孤儿。反馈默认同用户同聊天 3 秒冷却、每聊天每 UTC 日新增 100 条、保留 90 天；同用户同助手消息更新原记录。

## 部署边界

- **本轮安全修复仍需真实验收。** 历史后端 smoke/prompt 记录见 [验证记录](docs/VALIDATION.md)，本轮没有启动真实后端或连接 QQ，不能沿用历史结果认定新策略可用。
- **L1 组合减法已提供，L2 源码删除未实施。** 构建仍依照 fork 原有构建图。详见 `SUBTRACTION.md`。
- **OFM 已内置，历史探测不代表当前可用。** 账号 provider 白名单仅 `deepseek-account`，unknown（包括未列入账号白名单且未命中 free 分类的 region provider）拒绝；仅使用 ACP 实际公布且信任可确认的模型。当前安全修复未复验真实后端，详见 [验证记录](docs/VALIDATION.md)。
- **QQ 空间需要真实能力适配器。** NapCat 接口因实现而异，默认报告不支持；支持注入 `bot.qzone.post/comment/like`。不会发送猜测的 OneBot action。评论还需显式开启。
- **图片信件、视觉自动打标、向量检索、表情预览墙及高级锅巴管理页未实现。** 图片信件返回不支持，文本/文件信件可用；记忆使用 FTS5 与中文子串检索。
- **固定 ACP 仅提供上下文 used/size。** 没有每轮 input/output/reasoning token 或价格，因此不生成虚构费用统计。数据库保留扩展字段。
- `merged` 输出将一轮文本合并为单条普通消息，最长 20000 字符；不是 QQ 合并转发节点。长回复建议使用默认 split。
- `#dsh清空` 删除映射并关闭会话，保留审计、聊天记录与记忆。ACP 不支持删除历史；记忆有独立遗忘/恢复命令。
- 定时任务为至少一次执行。发送成功后进程立即崩溃的窗口可能重复发送；没有网关幂等键时不承诺恰好一次。取消会阻止后续调度，已被 QQ 网关接受的消息无法撤回。
- 配置日后改变默认模型时，已有 chat 的显式模型选择继续保留；用模型命令切换或清空会话。显式跨账号/免费信任等级切换创建新 session，不复用旧历史；自动 fallback 仅账号到账号，不自动 free。新建/resume 缺少可确认的实际 model 选项时拒绝继续，不沿用未经确认的默认模型。群聊与主人私聊都只开放受控 MCP，不开放任意本地文件/终端工具。
- SQLite、会话、信件与 DSH_HOME 是本地明文数据，应纳入你自己的访问权限和备份管理。敏感内容过滤使用常见模式匹配，无法识别所有语义上的隐私。

WebUI 并发启动共享同一次启动，启动期间 stop 会取消并清理子进程，错误不附带原始 stderr。本轮每 turn MCP 重挂、严格模型确认及上述安全路径仍需真实 backend/QQ 验收。

## 开发与发版

```powershell
npm run check
npm test
npm run smoke
npm audit --omit=dev
```

`scripts/backend-smoke.mjs` 面向真实已准备的后端；`npm run smoke` 使用模拟 ACP / QQ 与真实 MCP SDK 协议检查。二者验证范围不同。

源码采用 GPL-3.0-only，全文见 `LICENSE`；再次分发插件或其修改版时须同样以 GPL-3.0 提供对应源码。依赖和 fork 的来源、许可证见 `THIRD_PARTY.md`。构建并分发 DSH 时需另外保留它自己的 LICENSE 和 notices。
