# 来源与许可证

## 本项目

本插件源码以 **GPL-3.0-only** 发布，全文见根目录 `LICENSE`。分发本插件或其修改版时，须按 GPL-3.0 提供对应源码，并保留版权与许可声明。

GPL-3.0 与下列 MIT/ISC 依赖兼容：各依赖仍适用其自身条款，本插件整体按 GPL-3.0 发布。`package.json` 的 `license` 字段为 `GPL-3.0-only`。

## 第三方来源

- 设计来源：用户提供的 `dsh-chat-design.md`（副本见 `docs/DESIGN.md`）。文档中的规划与历史外部服务状态不作为实现的测试结果。
- DSH fork：[Hyposelenia-Moon/deepseek-harness](https://github.com/Hyposelenia-Moon/deepseek-harness)，MIT，固定 commit 见 `backend/pin.json`。本包不含其完整源码或二进制；如另行打包后端，请保留 fork 原 LICENSE 和第三方 notices。
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)，MIT。用于真实 Streamable HTTP MCP 协议服务和契约测试。
- [`yaml`](https://github.com/eemeli/yaml)，ISC。用于配置解析。
- [`undici`](https://github.com/nodejs/undici)，MIT。用于受限媒体下载。
- [Node.js](https://nodejs.org/)，MIT 及其第三方许可证；SQLite 引擎通过 Node 的内置模块使用。

直接及传递 npm 依赖精确版本与完整性见 `package-lock.json`。安装时各包附带的许可证以原包为准。本源码包排除 node_modules、账号、聊天数据库和临时下载素材。
