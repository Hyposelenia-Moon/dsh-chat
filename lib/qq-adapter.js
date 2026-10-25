import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export class AdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

const idString = value => value === undefined || value === null ? '' : String(value);
const segmentData = part => part?.data ?? part ?? {};
const decodeCQ = text => String(text).replace(/&#91;/g, '[').replace(/&#93;/g, ']')
  .replace(/&#44;/g, ',').replace(/&amp;/g, '&');

function nativeContent(content) {
  if (typeof content === 'string') return content;
  const convert = part => part?.data && typeof part.data === 'object' ? { type: part.type, ...part.data } : part;
  return Array.isArray(content) ? content.map(convert) : convert(content);
}

function onebotContent(content) {
  const parts = Array.isArray(content) ? content : [content];
  return parts.map(part => {
    if (typeof part === 'string') return { type: 'text', data: { text: part } };
    if (part.data && typeof part.data === 'object') return { type: part.type, data: part.data };
    const { type, ...data } = part;
    return { type, data };
  });
}

function targetOf(chatId) {
  const match = /^(group|private):([1-9]\d{0,15})$/.exec(String(chatId));
  if (!match) throw new AdapterError('INVALID_CHAT', 'chatId 必须是 group:群号 或 private:QQ号');
  const number = Number(match[2]);
  return { type: match[1], id: Number.isSafeInteger(number) ? number : match[2] };
}

/** Normalize trusted gateway fields. Model-produced role/name text never grants permissions. */
export function normalizeEvent(event = {}, config = {}) {
  const chatType = event.message_type === 'group' || event.isGroup === true || event.group_id != null
    ? 'group' : 'private';
  const senderId = idString(event.user_id ?? event.sender?.user_id ?? event.uid);
  const selfId = idString(event.self_id ?? event.bot?.uin ?? event.bot?.self_id);
  const chatId = `${chatType}:${chatType === 'group' ? idString(event.group_id) : senderId}`;
  targetOf(chatId);
  if (!/^[1-9]\d{0,15}$/.test(senderId)) throw new AdapterError('INVALID_SENDER', '事件缺少有效发送者 QQ');
  const parts = Array.isArray(event.message) ? event.message : [];
  const mentions = parts.filter(part => part.type === 'at')
    .map(part => idString(segmentData(part).qq ?? segmentData(part).user_id)).filter(Boolean);
  const rawText = idString(event.raw_message ?? event.msg ?? event.message ?? '');
  const cqMentions = [...rawText.matchAll(/\[CQ:at,qq=([^,\]]+)(?:,[^\]]*)?\]/g)].map(match => match[1]);
  mentions.push(...cqMentions);
  if (event.atBot && selfId) mentions.push(selfId);
  const text = parts.length
    ? parts.filter(part => part.type === 'text').map(part => idString(segmentData(part).text)).join('')
    : decodeCQ(rawText.replace(/\[CQ:[^\]]*\]/g, ''));
  const masters = config.permissions?.masters ?? config.masters ?? [];
  const isMaster = event.isMaster === true || (Array.isArray(masters) && masters.map(String).includes(senderId));
  const gatewayRole = event.sender?.role;
  const isAdmin = chatType === 'group' && (gatewayRole === 'owner' || gatewayRole === 'admin'
    || event.member?.is_admin === true || event.member?.is_owner === true);
  const attachments = parts.filter(part => ['image', 'mface', 'record', 'video', 'file'].includes(part.type))
    .map(part => ({ type: part.type, ...segmentData(part) }));
  return {
    chatId, chatType, senderId, selfId, text: text.trim(), rawText,
    messageId: idString(event.message_id ?? event.messageId ?? event.seq),
    replyTo: idString(event.source?.message_id ?? event.source?.seq
      ?? segmentData(parts.find(part => part.type === 'reply')).id),
    mentions: [...new Set(mentions)], attachments, isMaster, isAdmin,
    role: isMaster ? 'master' : isAdmin ? 'admin' : 'member',
    senderName: idString(event.sender?.card ?? event.sender?.nickname ?? senderId),
    event,
  };
}

/** A narrow Yunzai / OneBot facade. Authorization stays in runtime and MCP handlers. */
export class QQAdapter {
  constructor({ bot = globalThis.Bot, segment = globalThis.segment, config = {}, mediaRoot } = {}) {
    this.bot = bot;
    this.segment = segment ?? bot?.segment;
    this.config = config;
    this.mediaRoot = mediaRoot ? path.resolve(mediaRoot) : null;
    this.contexts = new Map();
  }

  normalizeEvent(event) { return normalizeEvent(event, this.config); }

  fromEvent(event) {
    const context = this.normalizeEvent(event);
    this.bindEvent(context);
    return context;
  }

  bindEvent(context) {
    targetOf(context.chatId);
    this.contexts.delete(context.chatId);
    this.contexts.set(context.chatId, context);
    if (this.contexts.size > 512) this.contexts.delete(this.contexts.keys().next().value);
    return context;
  }

  _botFor(chatId) {
    const context = this.contexts.get(chatId);
    return context?.event?.bot ?? this.bot?.[context?.selfId] ?? this.bot;
  }

  _segment(type, value) {
    const factory = this.segment?.[type];
    if (typeof factory === 'function') return factory(value);
    const data = type === 'at' ? { qq: String(value) } : type === 'reply' ? { id: String(value) }
      : type === 'text' ? { text: String(value) } : { file: String(value) };
    return { type, data };
  }

  async _callApi(bot, action, params) {
    const result = await bot.callApi(action, params);
    if (result?.status === 'failed' || (result?.retcode != null && Number(result.retcode) !== 0)) {
      throw new AdapterError('GATEWAY_REJECTED', `QQ 网关拒绝 ${action}：${String(result.message || result.wording || result.retcode).slice(0,160)}`);
    }
    return result;
  }

  async _send(chatId, content, options = {}) {
    const target = targetOf(chatId);
    options.signal?.throwIfAborted();
    const event = this.contexts.get(chatId)?.event;
    if (typeof event?.reply === 'function') return event.reply(nativeContent(content), Boolean(options.quote));
    const bot = this._botFor(chatId);
    const peer = target.type === 'group' ? bot?.pickGroup?.(target.id) : bot?.pickFriend?.(target.id);
    if (typeof peer?.sendMsg === 'function') return peer.sendMsg(nativeContent(content));
    if (typeof bot?.callApi === 'function') {
      const params = { message: onebotContent(content), auto_escape: false };
      params[target.type === 'group' ? 'group_id' : 'user_id'] = target.id;
      return this._callApi(bot, target.type === 'group' ? 'send_group_msg' : 'send_private_msg', params);
    }
    throw new AdapterError('SEND_UNAVAILABLE', '当前 Yunzai 适配器没有可用的消息发送接口');
  }

  sendText(chatId, text, options = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new AdapterError('INVALID_TEXT', '发送文本不能为空');
    if (options.replyTo) return this.reply(chatId, options.replyTo, text, options);
    return this._send(chatId, text, options);
  }

  mention(chatId, userId, text = '', options = {}) {
    if (targetOf(chatId).type !== 'group') throw new AdapterError('GROUP_REQUIRED', '@ 仅适用于群聊');
    if (!/^[1-9]\d{0,15}$/.test(String(userId))) throw new AdapterError('INVALID_USER', '需要有效的 @ 对象 QQ');
    const content = [this._segment('at', String(userId))];
    if (text) content.push(this._segment('text', String(text)));
    return this._send(chatId, content, options);
  }

  reply(chatId, messageId, text, options = {}) {
    if (!messageId || typeof text !== 'string' || !text.trim()) throw new AdapterError('INVALID_REPLY', '引用回复需要消息 ID 和文本');
    return this._send(chatId, [this._segment('reply', String(messageId)), this._segment('text', text)], {...options,quote:false});
  }

  async _mediaPath(file) {
    if (!this.mediaRoot || typeof file !== 'string' || !path.isAbsolute(file)) {
      throw new AdapterError('MEDIA_PATH', '媒体必须先由媒体服务保存到插件 media 目录');
    }
    const [root, resolved] = await Promise.all([realpath(this.mediaRoot), realpath(file)]);
    const relative = path.relative(root, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new AdapterError('MEDIA_PATH', '媒体路径超出插件 media 目录');
    }
    if (!(await stat(resolved)).isFile()) throw new AdapterError('MEDIA_PATH', '媒体路径不是普通文件');
    return resolved;
  }

  async sendImage(chatId, file, options = {}) {
    options.signal?.throwIfAborted();
    const approved = await this._mediaPath(file);
    return this._send(chatId, this._segment('image', approved), options);
  }

  async sendVoice(chatId, input, options = {}) {
    const { audio, text } = typeof input === 'string' ? { text: input } : input ?? {};
    const signal = options.signal ?? input?.signal;
    signal?.throwIfAborted();
    if (audio) return this._send(chatId, this._segment('record', await this._mediaPath(audio)), { signal });
    if (typeof text !== 'string' || !text.trim()) throw new AdapterError('INVALID_VOICE', '需要语音文件或文本');
    if (typeof this.segment?.tts === 'function') {
      try { return await this._send(chatId, this.segment.tts(text), { signal }); } catch { signal?.throwIfAborted(); }
    }
    return this.sendText(chatId, text, { signal });
  }

  async sendFile(chatId, file, { name, signal } = {}) {
    signal?.throwIfAborted();
    const approved = await this._mediaPath(file);
    signal?.throwIfAborted();
    const target = targetOf(chatId);
    const bot = this._botFor(chatId);
    const fileName = path.basename(name || approved);
    const peer = target.type === 'group' ? bot?.pickGroup?.(target.id) : bot?.pickFriend?.(target.id);
    if (typeof peer?.sendFile === 'function') return peer.sendFile(approved, fileName);
    if (target.type === 'group' && typeof peer?.fs?.upload === 'function') return peer.fs.upload(approved, '/', fileName);
    if (typeof bot?.callApi === 'function') {
      const params = { file: approved, name: fileName, [target.type === 'group' ? 'group_id' : 'user_id']: target.id };
      return this._callApi(bot, target.type === 'group' ? 'upload_group_file' : 'upload_private_file', params);
    }
    throw new AdapterError('FILE_UNAVAILABLE', '当前适配器没有文件上传接口');
  }

  async groupInfo(chatId) {
    const target = targetOf(chatId);
    if (target.type !== 'group') throw new AdapterError('GROUP_REQUIRED', '此接口需要群聊');
    const bot = this._botFor(chatId);
    const group = bot?.pickGroup?.(target.id);
    const info = typeof group?.getInfo === 'function' ? await group.getInfo()
      : typeof bot?.callApi === 'function' ? await this._callApi(bot, 'get_group_info', { group_id: target.id }) : group?.info;
    if (!info) throw new AdapterError('GROUP_INFO_UNAVAILABLE', '当前适配器没有群信息接口');
    const data = info.data ?? info;
    // Keep gateway credentials and unrelated adapter internals outside tool responses.
    return Object.fromEntries(['group_id', 'group_name', 'member_count', 'max_member_count', 'owner_id']
      .filter(key => data[key] !== undefined).map(key => [key, data[key]]));
  }

  capabilities(chatId) {
    const bot = chatId ? this._botFor(chatId) : this.bot;
    return {
      text: Boolean(bot?.pickGroup || bot?.pickFriend || bot?.callApi || this.contexts.size),
      image: true, mention: true, reply: true,
      voice: { audio: true, tts: typeof this.segment?.tts === 'function', textFallback: true },
      files: Boolean(bot?.pickGroup || bot?.pickFriend || bot?.callApi),
      qzone: Object.fromEntries(['post', 'comment', 'like'].map(action => [action, typeof bot?.qzone?.[action] === 'function'])),
    };
  }

  async qzone({ action, ...params }, chatId, { signal } = {}) {
    signal?.throwIfAborted();
    if (!['post', 'comment', 'like'].includes(action)) throw new AdapterError('QZONE_ACTION', '未知的空间操作');
    const qzone = (chatId ? this._botFor(chatId) : this.bot)?.qzone;
    if (typeof qzone?.[action] !== 'function') {
      throw new AdapterError('QZONE_UNAVAILABLE', 'NapCat/当前适配器未提供此 QQ 空间能力');
    }
    if (params.images?.length) params.images = await Promise.all(params.images.map(file => this._mediaPath(file)));
    signal?.throwIfAborted();
    return qzone[action](params);
  }
}

export default QQAdapter;
