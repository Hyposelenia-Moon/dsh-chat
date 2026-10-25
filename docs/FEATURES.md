# 持久化与扩展服务

运行环境为 Node.js 24.13+，数据库使用内置 `node:sqlite`，无需安装原生 SQLite npm 扩展。服务默认关闭记忆、自学习、表情、写信和空间；定时器默认运行，但只执行主人明确创建并已注册处理器的任务。

## 数据库

`new Store({ path })` 和 `openDatabase(path)` 返回同步 Store。接口为 `prepare(sql)`、`exec(sql)`、`transaction(fn)`、`audit(event, ctx, detail)`、`close()`。`transaction` 使用 `BEGIN IMMEDIATE`，回调必须同步。时间均为 Unix 毫秒。

建表文件为 `model/schema.sql`，包含设计的十个业务表，以及 `turns`、`audit`、`usage`、`message_dedup`、`profile_approvals`、`feature_state`、`skill_templates`、`sticker_events`。启用 WAL、外键和五秒 busy timeout；当前 schema 为 v2，会为 v1 任务表迁移 `self_id`，读取到较新 schema 会拒绝启动。数据库路径应置于插件专属 data 目录。

`messages` 对 `(chat_id, qq_message_id, role)` 建唯一索引；入口另外使用 `message_dedup` 在入队前去重。同一 chat 的 assistant 消息不带 QQ 消息 ID 时不会被误去重。`profiles` 的部分唯一索引保证最多一个激活版本。

## 统一调用约定

各服务构造参数为 `{ db, config, logger, adapter, mediaRoot }`，方法参数为 `(args, ctx)`。可信上下文 `ctx` 包含 `chatId`、`senderId`、`role`、`turnId`，其中角色必须来自 QQ 网关和主人配置。服务提供范围检查；调用方在 MCP 执行及定时任务真正执行前再次校验当前权限、总开关、群白名单、功能开关和频率。

错误抛出 `FeatureError`，`code` 包括 `FEATURE_DISABLED`、`FORBIDDEN`、`INVALID_ARGUMENT`、`NOT_FOUND`、`QUOTA_EXCEEDED`、`UNSUPPORTED`。调用方可将它们转为结构化 MCP 错误。

## 记忆

`MemoryService` 提供：

- `search({ query, scope?, scopeId?, limit? }, ctx)` → 记忆数组，附相关分数。
- `write({ content, subject?, kind?, scope?, scopeId?, importance?, automatic? }, ctx)` → 新记录或带 `duplicate:true` 的现有记录。
- `forget({ id }, ctx)`、`restore({ id }, ctx)` → 更新后的记录，仅主人。

普通用户只访问本人的 `user` 记忆、当前群的 `group` 记忆和可读的 `global` 记忆；写入 global 记忆需要主人。默认搜索只合并这三个可见范围，不遍历其他用户和群。为避免私聊偏好在群里被注入，`user` 记忆额外按 `source_chat_id` 隔离：同一个 QQ 的不同群和私聊分别检索、分别去重；主人显式搜索其他用户时也保留当前 chat 的来源限制。这是对设计用户范围的隐私保护调整。主人显式写入的 `global` 记忆为公共知识，群记忆按目标群共享。

SQLite 支持 FTS5 时使用 BM25；中文子串使用参数化 `LIKE` 召回，因此“茉莉”可命中“喜欢喝茉莉花茶”。排序结合词命中、重要度和时间衰减；默认只返回六条，最多五十条。已遗忘或已被替代的记录不注入上下文。

自动写入由 `memory.maxAutomaticPerDay` 限制，兼容 `dailyWriteLimit`。限额按 UTC 自然日、插件整体统计。主人手工调用可传 `automatic:false`；工具调用方必须强制 `automatic:true`，覆盖来自模型的值。敏感串过滤会拒绝常见密钥、私钥、认证 token、明确的密码字段、邮箱、手机号和身份证号。过滤是规则式识别，无法覆盖全部敏感信息；建议只保存明确的偏好和事实。

## 自学习与人格

`LearningService` 提供 `feedback`、`propose`、`approve`、`rollback`、`current`、`list`、`pause`。`propose({ content, reason? }, ctx)` 只接受文本人格，生成递增版本并保持 `active=0`。审批和回滚仅主人可操作；回滚对象必须曾经获批。审批记录保存审批人、时间、前一版本和操作类型。

每日候选由 `learning.maxCandidatesPerDay` 限制，兼容 `dailyCandidateLimit`。`pause({ paused:true }, ctx)` 写入数据库，重建服务后仍保持暂停；审批和回滚在暂停期间可用。所有方法均不改配置文件、代码、权限或凭据。

`saveTemplate({ intent, steps, successful }, ctx)` 保存主人审核的文本步骤模板；`templates({ query }, ctx)` 仅检索成功模板。步骤只保存文字，不存可执行代码和参数对象，也不会自动执行；调用具体工具时继续走正常权限校验。

## 表情

`StickerService.collect({ file|path, sub_type:1|type:'mface'|emoji_id, tags?, emotion? }, ctx)` 只接收 QQ 表情元数据和已经由媒体服务保存的文件。服务不直接下载 URL。`file` 的真实路径必须位于 `mediaRoot` 内，支持 PNG/JPEG/GIF/WebP，检查文件标识、尺寸、比例、大小和 PNG 块边界；不会解码执行 SVG。格式检查不是完整的图像解码或恶意文件扫描。

确认后的字节按 SHA-256 命名保存在 `mediaRoot/stickers`，对 hash 唯一去重。发送前再次核对内容 hash。收录权限按原始 chat 保存，普通用户的 `search` 和 `send` 不会访问其他群的表情。主人可管理完整库。同一图片已在其他 chat 收录时，普通用户会得到 `ALREADY_EXISTS`，不返回其路径或原始群信息。

`search({ tag?, query?, limit? }, ctx)` 返回列表。`send({ stickerId?|id?|tag? }, ctx)` 调用注入的 `adapter.sendSticker` 或 `adapter.sendImage`，成功后记录用量；没有发送接口时只返回 `delivery:'prepared'`。默认适配器提供 `sendImage`。`stickers.maxPerGroupPerHour` 分别约束每个 chat 一小时内的收录和发送次数，兼容 `hourlyCollectLimit`/`hourlySendLimit`。失败发送释放本次限额预留。

## 写信

`LettersService.write({ title?, body, format:'text'|'file', scheduledAt?, chatId? }, ctx)` 需要主人，返回记录、`text` 及文件格式的 `file`。文件信真实保存为 UTF-8 `.txt`，标题不会参与路径拼接。`format:'image'` 明确返回 `UNSUPPORTED`；本包未配置排版渲染器。

`get({ id }, ctx)` 读取，`send` 在配置 `adapter.sendLetter` 时实际发送，否则返回 `delivery:'prepared'`。主运行时可使用 adapter 的文本/文件接口发送，再调用 `markSent`；发送失败时不能调用该方法。`sent_at` 用于抑制已经确认发送的信件。`scheduledAt` 只是信件记录字段，由运行时显式创建 `letter_send` 任务。

## 定时器

```js
const scheduler = new Scheduler({ db, config, logger });
scheduler.register('text_send', async (payload, job) => {
  // job.context 是持久化的创建者上下文；重新检查当前主人、群和功能权限。
  job.signal.throwIfAborted();
  return authorizedSend(payload, job.context, job.signal);
});
scheduler.schedule({ kind: 'text_send', runAt: Date.now() + 60_000,
  payload: { text: '晚安' } }, ownerContext);
scheduler.start();
```

仅支持 `letter_send`、`text_send`、`qzone_post`、`reflection` 四种 kind；没有 eval、shell 或任意代码执行。`schedule`、`list`、`cancel` 仅主人。payload 必须是受限 JSON 对象，拒绝凭据字段和原型字段。任务的具体 payload 结构由运行时按 kind 再校验。

`tick()` 使用数据库事务 claim 到期任务，写入唯一租约、执行次数及截止时间；执行期间续租。进程退出后，新的服务在租约过期时恢复任务。失败按指数退避重试，达到 `maxAttempts` 后标记 failed。`scheduler.intervalMs` 控制轮询；可配置 `leaseMs`、`retryBaseMs`、`maxBackoffMs`、`jobTimeoutMs` 和 `maxPending`。

处理器收到 `(payload, job)`；`job.context` 包含创建者信息及持久化的 `selfId`（机器人账号），`job.signal` 和 `job.context.signal` 用于取消。历史角色不是当前授权，运行时必须从当前配置重新校验。处理器应在发送前检查 signal，并将它传给支持取消的下游操作。

任务采用至少一次执行语义。若远端已接受发送、进程却在确认落库前崩溃，恢复后可能重复投递；QQ 网关缺少幂等发送键时无法保证恰好一次。需要谨慎处理有外部副作用的任务；信件至少会用 `sent_at` 抑制已确认成功的重复发送。

## 空间

`QzoneService.capabilities(ctx)` 读取 `adapter.capabilities(chatId).qzone`，只启用明确声明支持的方法。`post({ text, images? }, ctx)`、`comment({ postId, text }, ctx)`、`like({ postId }, ctx)` 需要主人和 `qzone.enabled`；评论另需 `qzone.commentsEnabled:true`。缺失网关能力会返回 `UNSUPPORTED`，不会模拟成功。图片必须已保存在受控媒体目录。

服务适配 `adapter.qzone({ action, ...params }, chatId)`，也支持具有明确 capability 的 `qzonePost`/`qzoneComment`/`qzoneLike`。默认每日每种动作最多五次，可通过 `qzone.dailyLimit` 调整，审计预留防止并发突破限额。

## 验证

运行 `node --test test/features.test.js`。测试使用操作系统临时目录，覆盖 SQLite 去重与事务、中文检索与范围隔离、敏感串与限额、主人审批与回滚、暂停持久化、媒体格式/路径/hash、真实信件文件、定时重试与租约恢复、空间能力缺失及默认开关。真实 QQ 发信、NapCat 空间操作和模型驱动反思需要在实际网关与后端可用时进行 smoke test。
