# DSH-Chat 设计方案

> 在 Yunzai 主框架下，用「最小化 DSH fork」作为会话与推理内核的 QQ 聊天插件。
>
> 后端 fork：<https://github.com/Hyposelenia-Moon/deepseek-harness>
> 状态：方案稿 v2（已纳入 fork 减法）
> 日期：2026-10-25

---

## 1. 背景与目标

当前 QQ 接入是「Yunzai + NapCat」和「DSH + dsh-onebot-qq」两套并存：

- Yunzai 负责 QQ 登录、`#` 命令、群管；
- DSH 负责 AI 对话，但通过独立 OneBot 插件直连 QQ，和 Yunzai 抢同一批消息；
- 表情包、空间动态、权限、记忆、自学习这些能力分散，维护成本高。

目标是在 **Yunzai 内**做一个聊天插件：

1. Yunzai / NapCat 保持主框架，不换 QQ 网关；
2. 每个 QQ 私聊、群聊映射到一个 **DSH 会话**；
3. 模型可在面板切换；
4. 具备简化 Harness 的能力：会话、工具、权限、记忆、定时任务、日志；
5. 用 **锅巴** 做管理面板；
6. 支持 AI 自学习，但有审批和回滚。

### 1.1 为什么基于 fork 做减法

DSH 上游是完整 monorepo（约 2.2 万个文件，含 desktop、web、插件市场、subagent、终端等）。QQ 聊天只需要 agent loop、LLM、session、MCP、ACP 这几块。

直接在完整 DSH 上做 QQ 插件，启动慢、依赖多、升级面大；直接删源码又容易破坏包依赖。因此采用：

1. 先用 **组合减法**：在 fork 里新增 `qq` profile，只挂聊天必需模块；
2. 稳定后再做 **源码减法**：删除 desktop/web/market 等应用与 bundle；
3. 不把 QQ 接入做进 DSH 内核，QQ 仍由 Yunzai/NapCat 负责。

---

## 2. 范围

### 2.1 目标功能

| 模块 | 能力 |
|---|---|
| 聊天 | @ 触发、前缀触发、私聊、群聊、引用回复、分条/合并 |
| 会话 | 每个 chat 一个持久 DSH session，可恢复、可清空 |
| 模型 | 列表、切换、每群默认、推理强度 |
| 权限 | 主人、群管、群白名单、功能开关、工具级校验 |
| 表情包 | 收录、去重、打标、按语境发送、限额 |
| 动态 | QQ 空间说说、评论、点赞（能力允许时） |
| @ | 解析 mention、引用回复、指定对象 |
| 写信 | 长文/图片/文件形式的信件，可定时 |
| 记忆 | 事实、偏好、事件、关系，检索与遗忘 |
| 自学习 | 反馈、反思、人格候选、技能模板 |
| 面板 | 锅巴配置、状态、日志、记忆/表情管理 |
| 定时 | 空间动态、主动搭话、每日反思 |

### 2.2 非目标

- 不替换 Yunzai 的 QQ 登录、命令体系、群管；
- 不自动修改 Yunzai 代码或插件代码；
- 不做翻唱、声音克隆、B 站自动运营等重功能（可作为后续独立插件）；
- 不允许 AI 自动改权限、密钥、安全规则。

---

## 3. 总体架构

### 3.1 拓扑

```text
QQ
 │
 ▼
NapCat（OneBot v11）
 │
 ▼
Yunzai
 ├─ 现有插件（# 命令、群管、游戏查询……）
 └─ dsh-chat 插件
      ├─ 消息路由 / 队列 / 权限
      ├─ 会话映射（chatId ↔ ACP sessionId）
      ├─ 模型切换
      ├─ 记忆 / 自学习
      ├─ 定时任务
      ├─ Guoba 面板
      │
      ├─ ACP 客户端（JSON-RPC stdio）
      │     │
      │     ▼
      │  dsh --profile qq（最小 DSH fork）
      │     ├─ DSH agent（推理、模型、上下文）
      │     └─ MCP 客户端
      │
      └─ MCP Server（插件内置）
            ├─ QQ 工具
            ├─ 记忆工具
            └─ 权限校验
```

### 3.2 为什么用 ACP

DSH fork 保留官方 ACP 服务器（`dsh --profile qq` 内挂 `dsh-acp`），作为插件与 agent 之间的自动化接口：

- 标准 JSON-RPC stdio，适合被 Yunzai 插件托管；
- 支持 `session/new`、`session/list`、`session/resume`、`session/close`；
- 支持 `session/prompt`、`session/cancel`、`session/update`；
- 支持 `session/set_config_option` 切换模型和推理强度；
- 支持挂载 stdio / HTTP MCP server；
- 支持 `session/request_permission`。

相比每条消息 spawn 一个 headless 进程，ACP 可以：

- 保持一条连接、多 session 并发；
- 保留会话、跨重启恢复；
- 接收流式更新和工具生命周期；
- 让插件做统一的队列和限流。

### 3.3 进程模型

- 每个 Yunzai 进程启动一个 ACP 子进程；
- 插件负责启动、健康检查、退出清理；
- ACP 的 stdout 只用于协议帧，日志走 stderr；
- 插件崩溃/重启时，ACP 子进程随之退出；会话已持久化，可恢复。

### 3.4 Fork 减法策略

后端不使用完整 desktop/web profile，而是在 fork 上分三层减法。

| 层级 | 做什么 | 风险 | 时机 |
|---|---|---|---|
| L1 组合减法 | 不改源码，新增 `qq` profile，只挂聊天必需模块 | 低 | 先做 |
| L2 源码减法 | 删除 desktop/web/market 等 apps 与 bundle | 中 | L1 稳定后 |
| L3 核心抽取 | 把 agent loop/llm/session/mcp 抽成库嵌进 Yunzai | 高 | 可选 |

#### L1：保留

- `apps/cli`（`dsh` 入口）
- `dsh-base` 的必要部分
- agent loop、llm、session、storage、mcp、acp、preset、compaction、credentials、settings、host、boot

#### L1：移除/禁用

- desktop 壳、web 前端、plugin market
- subagent、workflow、goal、schedule
- browser-use、computer-use、terminal、ssh、lsp
- telemetry、feedback、experimental
- 群聊不需要的本地工具

#### L2：删除

- `apps/desktop`、`apps/desktop-host`、`apps/web`、`apps/plugin-market-generator`
- 对应 bundle：desktop-shell、web-client、market、subagent、workflow、browser、computer-use、terminal、ssh、lsp、experimental

每删一块都要 `pnpm build` + 相关测试 + `qq` profile smoke test，并记录到 `SUBTRACTION.md`。

#### 维护

- 固定到 tag/commit（当前 fork 为 `0.2.1-rc.3`），不追 `master`
- 分支 `qq-min`，每个删除单独 commit
- 上游只按 tag rebase；安全修复按 4.7 的 cherry-pick / 依赖升级流程处理
- 运行时来源与版本锁定见 4.6
- 不做自动更新，手动发版
- 保留 MIT 版权与第三方 notices

---

## 4. DSH 接入

### 4.1 启动

```text
dsh --profile qq --patch <plugin>/config/qq.patch.yml
```

`qq` profile 来自 fork 的最小组合：只挂 base、agent loop、llm、session、mcp、acp 等必需模块，不启动 desktop/web/market。

`qq.patch.yml` 用于把 ACP 默认的 coding persona 换成 QQ 人格：

- 覆盖 `preset` 为 `dsh-chat` 专用 preset；
- persona 使用插件配置中的人格文本；
- 群聊 session 不挂本地文件/终端工具；
- 主人私聊 session 可挂完整工具。

Phase 0 需要验证：`qq` profile 能否启动 ACP、patch 是否生效、persona 是否被正确加载。

### 4.2 会话生命周期

```text
session/new
  ├─ cwd: 插件工作区
  ├─ mcpServers: [dsh-chat-mcp]
  └─ 返回 sessionId + configOptions

session/prompt
  ├─ 文本
  ├─ 图片/资源链接（支持时）
  └─ 一次一个提示词

session/update
  ├─ assistant 文本
  ├─ thought
  ├─ tool 生命周期
  └─ 配置变化 / 上下文用量

session/close
  └─ 取消、drain、释放
```

恢复：

- 插件重启后，用 `session/list` / `session/resume` 找回映射；
- 恢复不回放旧更新，只恢复日志；
- 找不到 session 时自动新建。

### 4.3 模型切换

`session/new` 返回 `configOptions`，其中包含：

- `model`：provider + model 列表；
- `reasoning_effort`：模型支持时提供。

切换：

```text
session/set_config_option
  ├─ configId: "model"
  └─ value: "<provider>/<model>"
```

规则：

- 每个 chat 单独记录模型；
- 切换从下一轮生效，不打断当前轮；
- 面板展示 provider、模型名、上下文、是否免费；
- 免费模型（`our-free-model` 的 Kilo 池）标记来源与限流提示。

### 4.4 权限请求

ACP 可能发 `session/request_permission`：

- 只读/发消息类：按插件策略自动允许；
- 文件写入、终端、删除：群聊默认拒绝；
- 主人私聊可按配置允许；
- 拒绝时返回标准 deny，不阻塞会话。

### 4.5 ACP 已知限制

- 不支持删除、fork、transcript 回放、附加目录；
- 不支持 ACP 传输 MCP（用 stdio/HTTP）；
- coding persona 是默认值，需要 patch 覆盖；
- profile 配置变更需要重启 ACP 子进程；
- fork 的 `qq` profile 禁用 desktop/web/market 等 surface，本方案不依赖这些能力。

这些限制在设计中规避，不依赖。

### 4.6 运行时来源与版本锁定

运行时只使用 fork 的构建产物，不从上游拉代码。

| 阶段 | 来源 |
|---|---|
| 首次 | `git clone` fork |
| 构建 | fork 内 `pnpm install && pnpm run build` |
| 运行 | fork 构建目录的 `dsh`，`--profile qq` |
| 上游 | 仅手动升级时 fetch/rebase，不参与运行 |
| 自动更新 | 关闭；不用 `npx`、`pnpm dlx`、market |

布局：

```text
D:\Yunzai\Yunzai\plugins\dsh-chat\     # QQ 插件（本地代码）
D:\dsh-qq\                             # fork 构建产物（固定 commit）
D:\dsh-qq-data\                        # 独立 DSH_HOME
```

锅巴配置：

```yaml
backend:
  path: 'D:\dsh-qq\dsh.cmd'
  profile: 'qq'
  expectedCommit: '<fork commit>'
  dshHome: 'D:\dsh-qq-data'
```

启动前校验：

- 可执行文件存在；
- commit/version 与 `expectedCommit` 一致；
- `DSH_HOME` 独立，不与已安装的桌面版共用；
- 不一致时拒绝启动并提示“当前指向的不是 fork 构建”。

`dsh-chat` 是 Yunzai 插件，代码在本地；DSH 的 bundle 与依赖由 fork 的 lockfile 固定，运行时不会联网拉代码。外部网络只用于模型 API。

### 4.7 上游同步与安全更新

原则：**功能冻结，安全同步**。不自动追上游，也不长期忽略漏洞。

| 上游修复 | 是否跟 |
|---|---|
| agent loop、LLM 适配、MCP、ACP、session、sandbox、工具执行 | **要** |
| 依赖库 CVE（npm 包） | **要**，即使 DSH 核心没改 |
| desktop / web / market / 未启用的 bundle | 不需要（已减法移除或禁用） |
| UI、文案、内部重构 | 不需要 |
| 提示词/默认行为变化 | 可不跟，按需 |

同步方式，按代价从低到高：

1. **依赖升级**：`pnpm audit --prod` 找 CVE，只升级受影响包并更新 lockfile；
2. **cherry-pick 安全提交**：只摘上游 tag 里的安全修复 commit，不动其他功能；
3. **整包 rebase**：只有修复牵扯 ACP/session/profile 大改时才做，并适配 `dsh-chat`。

安全节奏：

| 级别 | 动作 |
|---|---|
| 严重（RCE、越权、凭据泄露） | 24–72 小时内评估并修 |
| 高 | 1 周内 |
| 中/低 | 季度批量 |

每月：

- 看上游 releases / security advisories；
- `pnpm audit --prod`；
- 检查已移除功能是否还残留依赖。

升级流程：

```text
pinned commit
  → 新建 security/<cve> 分支
  → cherry-pick 或 bump 依赖
  → pnpm build
  → 契约测试（ACP/MCP/模型切换/resume）
  → QQ 端到端 smoke test
  → 打包替换
  → 保留上一版回滚
```

即使暂未跟上游，也先降低暴露面：

- 群聊 session 不挂本地文件/终端工具；
- MCP 工具白名单 + 工具级权限；
- ACP 只走 stdio，不开公网端口；
- 限制模型可访问的路径和网络；
- 记录工具调用审计日志。

---

## 5. 插件结构

```text
plugins/dsh-chat/
├─ index.js
├─ apps/
│  ├─ chat.js
│  ├─ admin.js
│  └─ panel.js
├─ lib/
│  ├─ acp-client.js
│  ├─ session-map.js
│  ├─ queue.js
│  ├─ model.js
│  ├─ permissions.js
│  ├─ memory.js
│  ├─ learning.js
│  ├─ stickers.js
│  ├─ qzone.js
│  ├─ letters.js
│  └─ scheduler.js
├─ mcp/
│  └─ server.js
├─ config/
│  ├─ default_config.yaml
│  └─ qq.patch.yml
├─ model/
│  ├─ db.js
│  └─ schema.sql
└─ guoba/
   └─ schema.js
```

依赖：

- `better-sqlite3` 或 Yunzai 现有 SQLite 方案；
- `@modelcontextprotocol/sdk`（MCP server）；
- Node 内置 `child_process`、`readline`；
- 不引入重型 Web 框架，面板走 Guoba。

---

## 6. 消息流

```text
1. NapCat 收到消息
2. 插件预处理
   ├─ 去重
   ├─ 识别 @ / 前缀 / 私聊
   ├─ 权限与白名单
   └─ 媒体转存
3. 入队（按 chatId 串行）
4. 取 session
   ├─ 有 → 复用 / resume
   └─ 无 → session/new
5. session/prompt
6. 消费 session/update
   ├─ assistant 文本 → 分条/合并发 QQ
   ├─ thought → 按配置丢弃或转发
   └─ tool 调用 → MCP 执行并记日志
7. 落库：消息、用量、反馈
8. 触发记忆抽取（异步，不阻塞回复）
```

队列规则：

- 同一 chat 串行；
- 不同 chat 可并发，但受全局并发上限；
- 忙碌时新消息排队，不发“已排队”提示；
- 超时/取消有明确状态。

---

## 7. 会话与数据模型

### 7.1 SQLite 表

```sql
sessions(
  chat_id TEXT PRIMARY KEY,
  chat_type TEXT,            -- group / private
  session_id TEXT NOT NULL,
  model TEXT,
  reasoning_effort TEXT,
  preset TEXT,
  cwd TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  session_id TEXT,
  role TEXT,                 -- user / assistant / tool
  content TEXT,
  qq_message_id TEXT,
  sender_id TEXT,
  created_at INTEGER
);

memories(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT,                -- global / group / user
  scope_id TEXT,
  subject TEXT,
  kind TEXT,                 -- fact / preference / event / relation / rule
  content TEXT,
  importance REAL,
  created_at INTEGER,
  last_used_at INTEGER,
  superseded_by INTEGER,
  embedding BLOB
);

feedback(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  message_id INTEGER,
  signal TEXT,               -- good / bad / correction / repeat
  note TEXT,
  created_at INTEGER
);

stickers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT UNIQUE,
  file TEXT,
  tags TEXT,
  emotion TEXT,
  usage_count INTEGER,
  created_at INTEGER
);

letters(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  title TEXT,
  body TEXT,
  format TEXT,               -- text / image / file
  scheduled_at INTEGER,
  sent_at INTEGER
);

profiles(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER,
  content TEXT,
  reason TEXT,
  active INTEGER,
  created_at INTEGER
);

jobs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT,
  chat_id TEXT,
  payload TEXT,
  run_at INTEGER,
  status TEXT
);
```

### 7.2 映射规则

- 私聊：`private:<QQ>`；
- 群聊：`group:<群号>`；
- 同一群内不同人共享群 session，但记忆按 `scope=user` 区分；
- 主人私聊可用独立 session，避免和群上下文串线。

---

## 8. MCP 工具层

### 8.1 工具清单

| 工具 | 参数 | 作用 | 最低权限 |
|---|---|---|---|
| `qq_send_text` | chatId, text | 发文本 | 所有 |
| `qq_send_image` | chatId, path/url | 发图片 | 所有 |
| `qq_send_sticker` | chatId, stickerId/tag | 发表情包 | 所有 |
| `qq_mention` | chatId, userId | @ 人 | 群聊 |
| `qq_reply` | chatId, messageId, text | 引用回复 | 所有 |
| `qq_send_voice` | chatId, text/audio | 发语音 | 所有 |
| `qq_send_file` | chatId, path | 发文件 | 主人/群管 |
| `qzone_post` | text, images | 发说说 | 主人 |
| `qzone_comment` | postId, text | 回评论 | 主人 |
| `qzone_like` | postId | 点赞 | 主人 |
| `letter_write` | title, body, format | 写信 | 主人 |
| `memory_search` | query, scope | 检索记忆 | 所有 |
| `memory_write` | content, kind, scope | 写记忆 | 所有（限本人/本群） |
| `memory_forget` | id | 标记过时 | 主人 |
| `group_info` | chatId | 群/成员信息 | 所有 |
| `schedule_task` | kind, runAt, payload | 定时任务 | 主人 |

### 8.2 权限校验

每次工具调用携带：

```json
{
  "chatId": "group:123",
  "senderId": "10001",
  "role": "master|admin|member",
  "turnId": "..."
}
```

校验顺序：

1. 插件总开关；
2. 功能开关（该群是否允许表情/空间/写信）；
3. 发送者角色；
4. 工具自身限制（如群管操作要求机器人群权限）；
5. 频率限制。

拒绝时返回结构化错误，模型可解释，不执行。

### 8.3 媒体与表情包

- 图片：下载到插件 media 目录，校验大小/格式，发送后清理；
- 表情：
  - 只收 `sub_type=1`、mface、带 `emoji_id` 的真表情；
  - 尺寸/宽高比/体积/MD5 去重；
  - 视觉模型打标（可选）；
  - 每群每小时限额；
- 语音：优先 QQ 自带 TTS，失败降级文本；
- 文件：主人/群管限定，路径白名单。

---

## 9. 权限模型

| 层级 | 内容 |
|---|---|
| Yunzai | 主人 QQ、群管、群白名单 |
| 插件 | 每群/每人功能开关 |
| 工具 | MCP 执行前校验 |
| 模型 | 群聊不挂本地工具，主人私聊才挂 |

默认：

- 群聊：只允许聊天、表情、@、图片；
- 群管：可发文件、管理表情；
- 主人：空间、写信、记忆管理、模型切换；
- 所有人：不可读本地文件、不可执行命令。

---

## 10. 模型管理

### 10.1 渠道

| 渠道 | 来源 | 凭据 | 适用 |
|---|---|---|---|
| `deepseek-account` | DSH 订阅账号 | DSH 登录态 | 默认，稳定 |
| `our-free-model` | OFM 插件免费池 | 无（Kilo 免密） | 备用、限流场景 |
| `our-free-model-region` | OFM 地区受限模型 | 无 | 仅探测，通常不可用 |
| 聚合渠道（BYO Key） | OFM 内置 76 家提供商 | 自备 Key | 需要特定模型时 |
| EAC | OFM 协付通道 | GitHub 登录 + star | 桌面端专属，最小 ACP 不启用 |
| 账号渠道（CodeArts/CodeBuddy 等） | OFM 十三个账号渠道 | 各平台登录 | 有账号额度时 |

QQ 聊天默认只开前两类，避免把账号渠道的额度、登录态带进群聊。

### 10.2 OFM 在最小 fork 里的挂载

`dsh-our-free-model` 是 DSH 插件，注册两个 provider 路由：

- `our-free-model`：可用模型；
- `our-free-model-region`：地区受限模型。

在 `qq` profile 中：

- 保留 `dsh-our-free-model` bundle，否则免费模型不会出现在 ACP `configOptions`；
- 只保留 provider 半边，不依赖 desktop/web 设置页；
- 配置读写 `$DSH_HOME/our-free-model/settings.json`，锅巴面板通过插件 API 代理；
- 启动探测失败不阻塞 agent，标记该 provider 不可用并回退；
- 固定版本（当前 2.1.0），OFM 已标记 deprecated，升级前必须回归。

Phase 0 要验证：无 web/desktop 时 OFM 能否注册 provider、模型能否出现在 ACP 列表、设置文件是否生效。

### 10.3 免费模型现状与建议

实测（2026-10-24，出口 CN）：

| 来源 | 状态 |
|---|---|
| OpenCode Zen 免费车道 | 返回 “OpenCode's free tier can only be used from within OpenCode”，当前不可用 |
| `beam-free` | 地区封锁 |
| Kilo 免费池 | 免密可用，`isFree` 清单实时拉取 |

Kilo 池推荐：

| 用途 | 模型 |
|---|---|
| 日常首选 | `kilo-auto/free` |
| 看图/长文档 | `nvidia/nemotron-3.5-super-vl:free` |
| 超长文本 | `reflection/beam-free` |
| 写代码 | `cohere/north-mini-code:free` |
| 备选 | `poolside/laguna-s-2.1:free`、`dots-studio/dots-3-note-preview:free` |

不建议：

- `nvidia/nemotron-3.5-lightning:free`：首字延迟可能超过 30 秒；
- `liquid/lfm-2.5-2.6b:free`：上下文太小；
- OpenCode 车道全部：当前被上游拒绝。

注意：

- Kilo 免费池明确声明 prompt 可能被上游记录，**不要发密码、密钥、隐私、商业内容**；
- 免费不等于无限，会 429，插件需标记限额并回退；
- 免费模型不保证工具调用/视觉/长上下文能力，面板要标注实测能力。

### 10.4 选择与回退

```yaml
models:
  default: 'deepseek-account/deepseek-flash'
  fallback:
    - 'our-free-model/kilo-auto/free'
  allowFree: true
  freePromptWarning: true
  probeOnStart: true
```

规则：

- 默认走 `deepseek-account`；
- 429/地区受限/超时，允许回退一次到 `our-free-model`；
- 回退在日志和回复里标注（可配置是否告知用户）；
- 严肃任务不静默降级到弱模型，失败就明确报错；
- 每 chat 保存模型，群覆盖优先于默认；
- 切换失败保留旧模型并提示。

### 10.5 ACP 模型列表

- 从 `session/new` 返回的 `configOptions` 读取 provider/model；
- OFM 的模型必须出现在列表中，否则面板无法切换；
- 展示：provider、模型名、上下文、视觉、推理、免费/付费；
- 切换用 `session/set_config_option`，下一轮生效；
- 模型不可用时禁用而不是隐藏，附原因。

### 10.6 用量与成本

- 记录每轮 input/output/reasoning token；
- 免费模型标记 `cost=0`，但仍记录调用次数；
- 面板按模型/群/人统计；
- 超过每日阈值可自动切回默认或暂停；
- 不把免费模型的 429 当成故障刷屏，合并提示。

---

## 11. 锅巴面板

| 页 | 字段/操作 |
|---|---|
| 连接 | ACP 状态、启动/重启、session 列表、清空会话 |
| 模型 | 默认模型、群覆盖、推理强度、免费模型开关 |
| 人格 | 人格文本、语气、长度、称呼、示例 |
| 权限 | 主人、群白名单、功能开关、工具权限 |
| 聊天 | 触发方式、上下文条数、分条/合并、引用回复 |
| 表情包 | 库、自动收录、发送概率、限额、预览墙 |
| 空间 | 账号、发帖频率、评论开关、关键词 |
| 写信 | 触发、长度、格式、定时 |
| 记忆 | 搜索、列表、删除、反思频率 |
| 自学习 | 反馈来源、人格候选、审批、回滚 |
| 日志 | 最近请求、工具调用、错误、用量 |

复杂页面（记忆管理、表情墙）用 Guoba 自定义组件或独立页面。

---

## 12. 记忆与自学习

### 12.1 记忆

- 来源：对话抽取、每日反思、空间动态、主人手动添加；
- 类型：事实、偏好、事件、关系、群规矩；
- 检索：BM25 + 可选向量，按说话人/重要度/遗忘曲线加权；
- 过期：标为「已过时」，保留可恢复；
- 注入：只注入与当前说话人/话题相关的少量记忆。

### 12.2 反馈学习

信号：

- 主人纠正（“不是这样”）；
- `#好` / `#不好`；
- 引用吐槽、重复追问；
- 表情/点赞等弱信号。

用途：

- 调整回复长度、语气、称呼、表情频率、主动搭话概率；
- 只改风格参数，不改安全底线。

### 12.3 人格候选

- 定时从反馈与记忆生成候选修订；
- 写入 `profiles`，`active=0`；
- 主人在面板审批后生效；
- 支持版本对比与回滚；
- 不允许 AI 自动改代码、权限、密钥。

### 12.4 技能模板

- 记录成功工具链（发空间、写信、发表情）；
- 按意图检索，作为步骤模板；
- 失败链标记，不推荐；
- 模板只存步骤，不存敏感参数。

### 12.5 护栏

- 每日自动记忆/候选数量上限；
- 敏感信息不写入；
- 所有自动修改有审计日志；
- 一键暂停自学习；
- 人格候选必须审批。

---

## 13. 定时任务

- 空间动态：按频率发说说/回评论；
- 主动搭话：按概率触发，有防刷屏；
- 每日反思：总结当天聊天，生成记忆/候选；
- 写信：定时发送；
- 任务持久化，重启恢复；
- 失败重试与退避。

---

## 14. 分阶段实施

### Phase 0：技术验证（2-3 天）

- 在 fork 上新增 `qq` profile，`dsh --dump-config --profile qq` 检查依赖闭包；
- 启动 ACP、`session/new`、`prompt`、`update`；
- 自定义 persona patch；
- MCP server 挂载并调用 `qq_send_text`；
- 模型列表与切换；
- 验证 OFM provider 注册、模型列表、`settings.json` 生效；
- 确认 OpenCode 车道不可用时的回退；
- 会话恢复；
- 版本锁定：`expectedCommit`、独立 `DSH_HOME`、启动校验；
- 建立 ACP/MCP 契约测试基线；
- 确认运行时不触发 `npx` 或上游拉取；
- 记录启动时间、内存、包体积。

验收：`dsh --profile qq` 跑通一条完整链路，且不启动 desktop/web。

### Phase 0.5：L2 源码减法（3-7 天，可选）

- 删除 `apps/desktop`、`apps/desktop-host`、`apps/web`、`apps/plugin-market-generator`；
- 删除对应 bundle：desktop-shell、web-client、market、subagent、workflow、browser、computer-use、terminal、ssh、lsp、experimental；
- 每删一块执行 `pnpm build` + `qq` profile smoke test；
- 记录 `SUBTRACTION.md`。

验收：只保留 CLI/ACP 的 `qq` 构建可启动，包体积和内存明显下降。

### Phase 1：MVP（3-5 天）

- 插件骨架、Guoba 基础配置；
- 会话映射、队列、@ 触发、引用回复；
- 文本聊天、分条/合并；
- 权限白名单；
- 模型切换。

验收：群里 @ 能连续对话，私聊可用，重启后会话可恢复。

### Phase 2：QQ 工具（3-5 天）

- 表情包收发；
- @ 人、发图、发语音、发文件；
- 写信；
- 空间发帖/回评论；
- 工具级权限。

验收：模型能按语境调用工具，越权被拒绝。

### Phase 3：记忆与自学习（3-5 天）

- SQLite 记忆库、检索、抽取；
- 反馈记录与风格参数；
- 人格候选审批/回滚；
- 每日反思。

验收：记住主人偏好，纠正后风格变化，可回滚。

### Phase 4：增强（可选）

- 主动搭话、心情、B 站、翻唱、语音克隆。

### Phase 5：稳定性

- 重连、超时、限流、重试；
- 日志与诊断；
- 单元测试 + 模拟 OneBot 端到端测试；
- 升级迁移。

---

## 15. 测试与验收

| 层级 | 内容 |
|---|---|
| 单元 | 队列、权限、模型映射、记忆检索、工具参数 |
| 集成 | ACP 模拟服务器；MCP 工具调用 |
| 端到端 | 模拟 OneBot 事件 → 回复 |
| 回归 | 重启恢复、断线重连、超时、限流 |
| 安全 | 越权工具、路径穿越、敏感信息、提示注入 |

关键指标：

- 首字延迟；
- 每轮 token/费用；
- 工具成功率；
- 队列积压；
- 记忆命中率；
- 自学习回滚次数。

---

## 16. 风险与备选

| 风险 | 说明 | 应对 |
|---|---|---|
| ACP 多开冲突 | 多实例争用同一 DSH_HOME / 单例 | Phase 0 验证；失败改用 SDK JSON-RPC / headless |
| 自定义 profile 不生效 | ACP 默认 coding persona | 用 `--patch` 覆盖；必要时独立组合 |
| fork 构建环境 | 2.2 万文件、native/Electron 依赖 | 只构建 CLI/ACP；先 L1，固定 Node/pnpm 版本 |
| 删包破坏依赖 | 包间隐式依赖 | 一次删一个，build + smoke test |
| 上游漂移 | developer preview 频繁 breaking | 固定 tag，不追 master |
| 分发包 | 需要自己打 Windows 包 | 输出文件夹/zip，不做安装器 |
| 工具越权 | 模型可被诱导调危险工具 | MCP 层校验，不靠提示词 |
| 记忆成本 | 每轮抽取烧 token | 便宜模型、批量抽取、限额 |
| 自学习漂移 | 人格越学越偏 | 候选审批、版本回滚、每日上限 |
| 锅巴表达力不足 | 复杂面板 schema 不够 | 自定义组件/独立页面 |
| NapCat 接口缺失 | 空间/表情能力不全 | 先探测，降级文本/图片 |
| 群聊刷屏 | 多人同时发 | 队列、限流、合并、冷却 |
| 安全修复滞后 | 冻结 fork 漏掉 CVE | 按 4.7 月度审计、按级别 cherry-pick / 依赖升级 |
| OFM 已 deprecated | 2.1.0 后不再维护，可能不兼容 rc.3 | 固定版本，Phase 0 验证；失效则只用 `deepseek-account` |
| 免费模型隐私/限流 | prompt 可能被上游记录，429 | 默认不用于敏感内容，回退 + 合并提示 |

备选：

- fork 构建失败 → 先在官方 rc.3 上做 L1 组合减法；
- ACP 不可用 → `dsh-sdk-jsonrpc-server`；
- ACP 进程不可行 → 核心库抽取（L3）；
- MCP 不可用 → 插件内 HTTP 工具回调；
- 锅巴不可用 → 独立 Web 面板（不推荐）。

---

## 17. 待确认

1. MVP 范围：先聊天+模型+权限+锅巴，还是第一版带表情/空间/写信？
2. 模型来源：只用 DSH 现有 provider（含 OFM 免费池），还是另配 DeepSeek API Key？
3. 插件目录：`plugins/dsh-chat` 是否合适？
4. 自学习审批：人格修改必须主人审批，还是允许小范围自动调整？
5. 群聊是否允许本地文件工具？（建议不允许）
6. 是否进入 L2 删源码，还是停在 L1 `qq` profile？
7. fork 固定到哪个 tag/commit？
8. 最小 DSH 的构建产物怎么分发（文件夹/zip/单 exe）？

---

## 附录 A：ACP 方法速查

| 方法 | 用途 |
|---|---|
| `initialize` | 建立连接、能力协商 |
| `session/new` | 新建持久会话，挂 MCP |
| `session/list` | 列出可恢复会话 |
| `session/resume` | 恢复会话 |
| `session/close` | 关闭会话 |
| `session/set_config_option` | 切换模型/推理强度 |
| `session/prompt` | 提交提示词 |
| `session/cancel` | 取消 |
| `session/update` | 接收流式更新 |
| `session/request_permission` | 权限请求 |

---

## 附录 B：参考

- DSH fork：<https://github.com/Hyposelenia-Moon/deepseek-harness>
- DSH 上游：<https://github.com/deepseek-ai/deepseek-harness>
- DSH ACP：`@deepseek-ai/dsh-acp`、`@deepseek-ai/dsh-acp-app`
- DSH MCP：`@deepseek-ai/dsh-mcp-client`
- OFM：`dsh-our-free-model` 2.1.0（本机 profile `node_modules`，设置与缓存位于 `~/.dsh/our-free-model/`；已标记 deprecated）
- Yunzai 插件规范：项目内 `AGENTS.md`、`plugins/` 现有插件
- 锅巴配置：`Guoba-Plugin` 文档与现有插件 schema
