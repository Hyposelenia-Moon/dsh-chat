# 固定 fork 与 QQ ACP 后端

本包交付 Yunzai 插件源码、QQ 安全组合、构建/验证脚本及模拟协议测试。**压缩包不含已编译 DSH、第三方依赖、登录态或模型额度。** 没有在真实 QQ 账号、DSH 订阅、OFM 服务上完成端到端验收。

## 核实后的接入合同

2026-10-25 直接读取指定 fork，固定到：

```text
repository: https://github.com/Hyposelenia-Moon/deepseek-harness
commit: 22ddee3792402c3e70ec5f86a63c3e3e895a2f60
package version: 0.2.1-rc.3
Node: >=24.13.0（同时满足 fork 的 >=24.9.0）
pnpm: 11.28.5
```

fork 的 GitHub tags 列表为空，不能执行文档方案中的 `git checkout 0.2.1-rc.3`。这里固定实际 commit；不把 package version 误称为现有 tag。固定信息在 `backend/pin.json`。

实际源码与方案的关键差异：

- 自定义 profile 存在 `$DSH_HOME/profiles/qq/package.json`，通过 `dsh.profile.bundles` 依次挂 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-acp-app`，再应用该目录的 `cordis.patch.yml`。
- ACP `session/new` 明确从全局 host plane 创建 agent，**不选择 agent preset**。本实现因此覆盖 `system-prompt`，并禁用本地文件、终端、工作目录、web、subagent、workflow、goal、插件管理等模型工具；ACP 会话只挂插件提供的 MCP。
- `initialize` 返回 `protocolVersion: 1`；会话支持 new/list/resume/close、prompt、cancel、set_config_option。stdio 是按行分隔的 JSON-RPC，stdout 必须只含协议。
- 模型选项值实际是 `JSON.stringify([provider, model])`。插件保留原始 opaque value，用户输入 `provider/model` 时从服务端选项精确解析；模型名可以含 `/`。
- `session/resume` 必须携带相同绝对 `cwd`，并重新挂载本次提供的 `mcpServers`。插件因此会在重启后提交当前 MCP 端口/凭证地址。
- `session/request_permission` 仅附 `sessionId`、`toolCallId` 和 one-shot options，没有可用于自动授权的可信 `toolName`。插件统一拒绝该通道，QQ 工具由 MCP 的服务端权限检查执行。MCP tool bridge 本身没有调用 approval 的代码。
- ACP 的 `agentInfo.version` 是桥接实现版本 `0.0.1`，不能用它替代 fork commit 校验。
- 当前 ACP 仅提供 `usage_update: {used,size}` 上下文占用，prompt 结果只有 `stopReason`；没有每轮 input/output/reasoning tokens 或成本。本版不会把占用量冒充用量，轮次 token/费用统计需等待后端扩展合同。

对应固定源码：[ACP](https://github.com/Hyposelenia-Moon/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/acp/acp/src/index.ts)、[模型选项](https://github.com/Hyposelenia-Moon/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/acp/acp/src/model-control.ts)、[profile](https://github.com/Hyposelenia-Moon/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/boot/app-boot/src/profile.ts)、[MCP bridge](https://github.com/Hyposelenia-Moon/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/mcp/mcp-client/src/tools.ts)。

## 准备本地后端

手动从指定 fork 获取源码，不能用上游或全局安装的 `dsh` 替换：

```powershell
# 下载前先按你的网络配置测试 GitHub 直连；下列 git 本身不改变代理设置。
git clone https://github.com/Hyposelenia-Moon/deepseek-harness.git D:\dsh-qq
git -C D:\dsh-qq checkout --detach 22ddee3792402c3e70ec5f86a63c3e3e895a2f60
Set-Location D:\dsh-qq
pnpm install --frozen-lockfile
pnpm run build:artifacts

Set-Location D:\Yunzai\plugins\dsh-chat
node scripts/backend-prepare.mjs --source D:\dsh-qq --home D:\dsh-qq-data
```

`pnpm` 必须事先安装为 fork 指定的 `11.28.5`。`pnpm install` 是主人明确执行的依赖下载，遵从 fork lockfile。插件启动不下载代码、不安装依赖、不调用 `npx`/`dlx`、不查询更新、不切换上游。构建阶段仍使用 fork 自带构建图，会生成它所要求的 desktop/client 等构建依赖；这里实现的是 **L1 运行组合减法**，没有声称完成 L2 源码删除或 CLI 专用构建图。

如果依赖已安装，可显式调用离线构建包装器（Windows 也通过 Node 执行 pnpm 的 JS 入口，避免 shell 路径解释）：

```powershell
node scripts/backend-build.mjs --source D:\dsh-qq --home D:\dsh-qq-data --pnpm C:\path\to\pnpm\bin\pnpm.mjs
```

准备脚本会生成：fork 根的 `dsh.cmd`/`dsh-chat.mjs`、`dsh-chat-backend.json`，以及独立 DSH_HOME 下的 QQ profile。按其输出设置锅巴配置：

```yaml
backend:
  path: 'D:\dsh-qq\dsh.cmd'
  profile: qq
  expectedCommit: 22ddee3792402c3e70ec5f86a63c3e3e895a2f60
  dshHome: 'D:\dsh-qq-data'
  patchPath: ''
```

启动验证 origin、commit、package version、tracked 工作树状态、构建产物 SHA-256、profile SHA-256 与 DSH_HOME。默认 `~/.dsh`（包括指向它的目录链接）、独立 home 的全局 patch、额外 `patchPath` 会被拒绝，避免更高优先级 patch 重新启用工具。准备脚本拒绝覆盖非空 QQ profile；修改组合时，应先保留原目录备份并使用新的独立 home。其完整性检查用于避免版本漂移和误用构建，不是抵御能同时改写本地源码、清单及 Git 仓库的管理员。

Windows 启动不通过 `cmd.exe`：插件读取受校验清单后调用 `node <fork>/apps/cli/lib/bin.js --profile qq`，因此支持路径中的空格，也不会将路径或参数插入 shell 字符串。

## 账号与模型

QQ 组合默认路由为 `deepseek-account/deepseek-flash`，实际可用模型以 ACP 返回列表为准。独立 DSH_HOME 不会自动复制桌面版的凭据。ACP `authenticate` 没有实现交互登录，本插件也不提供登录 UI。

固定源码支持的账号准备方式是：**QQ 后端尚未运行时，显式临时启动同一个 fork 的 Web profile，向同一个专用 home 写入账号凭据**。以下命令已对照 CLI grammar 与 Web startup 源码，不是猜测的 `dsh login`：

```powershell
$env:DSH_HOME = 'D:\dsh-qq-data'
$env:DSH_TELEMETRY_DISABLED = '1'
node 'D:\dsh-qq\apps\cli\lib\bin.js' --profile web --host 127.0.0.1 --port 0 --no-open
```

打开终端打印的本机地址，在侧栏 **More → Sign in** 完成 DeepSeek 浏览器授权；这两个英文标签来自固定版本的 Account menu。若弹窗被阻止，可使用登录对话框的链接。Web profile 挂载 `ui-settings-account`、`account-controller` 和 Host webServer，账号 provider 通过本机 `/oauth/callback` 与 PKCE 完成授权，将 grant 保存在 `$DSH_HOME/.credentials.yaml` 的本地记录中。授权回调仅支持本机/SSH 本地转发的 loopback 访问。

完成后在终端按 **Ctrl+C** 停止 Web profile，随后再启动 Yunzai QQ 插件；不要点击 **Sign out**，它会删除刚保存的 grant。这是管理员显式执行的一次性账号设置流程，QQ ACP 运行组合不挂 Web。准备脚本允许 home 中存在凭据和其他 profile，但拒绝覆盖已有 QQ profile、默认桌面 home 或全局 patch。请勿把 `.credentials.yaml` 加入压缩包、日志或版本库。

此路径已经源码核对，**尚未实际构建 Web、浏览器登录或调用订阅模型**。如果部署方不接受这一步临时 Web 设置，本包目前没有纯 ACP 的 `deepseek-account` 登录流程，应保留为部署缺口。

依据：[CLI](https://github.com/Hyposelenia-Moon/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/apps/cli/README.md)、[Web 参数](https://github.com/Hyposelenia-Moon/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/bundle/web-app/src/startup.ts)、[账号菜单](https://github.com/Hyposelenia-Moon/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/ui-settings-account/src/client/AccountMenu.tsx)、[账号与回调限制](https://github.com/Hyposelenia-Moon/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/credentials/deepseek-account-platform/README.md)。

`dsh-our-free-model` 2.1.0 不在此 fork 的仓库组成中，本包没有额外下载它。OFM provider 注册、settings 文件、免费模型清单、Kilo 可用性与方案中的 2026-10-24 探测结论均未在本环境验证；默认 `allowFree: false`、没有自动安装 OFM。只有管理员另行审阅并挂载固定来源后，且 ACP 真正返回相应选项时，插件才可切换。不要手工伪造模型列表。

## 检查与验收

```powershell
npm test
# 将 backend-prepare 输出保存为 backend-config.json 后：
node scripts/backend-smoke.mjs --config backend-config.json --cwd D:\Yunzai\plugins\dsh-chat\data\workspace
```

smoke 只执行 initialize → new → close → resume → close，显示后端真实模型列表，不消耗推理额度；真实 prompt、QQ 发送、MCP 调用、订阅登录与 OFM 仍需有对应账号环境的部署者验收。`session/list` 返回可恢复、未激活的会话，不等同于当前进程全部 active sessions。

已自动测试：真实 Node 模拟 ACP 子进程并发、多 session update、权限拒绝/超时、超时与 AbortSignal、进程退出、无效 stdout、分块 stderr 脱敏、路径空格；SQLite 会话恢复、MCP endpoint 更新、配置失败保持旧模型、免费模型开关。

取消/超时会先 `session/cancel`，再 `session/close` 等待后端释放。下轮恢复须等 close 应答，防止旧轮更新混入新轮；若 close 也超时，会关闭整个 ACP 子进程，其他 chat 在下次请求时恢复。日志只对常见凭据样式做脱敏，避免启用内容日志记录敏感对话。

本包保留 fork 的 MIT 来源链接。构建与分发 DSH 时，应连同 fork LICENSE 和其第三方 notices 一起分发；不要只复制启动器。安全更新采用人工评估、依赖审计及固定 commit 升级，更新 `pin.json` 前重跑契约/QQ 验收。
