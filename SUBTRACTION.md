# QQ 后端组合记录

固定来源：`Hyposelenia-Moon/deepseek-harness@22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，包版本 `0.2.1-rc.3`。

本包实施 L1：独立 DSH_HOME 的 qq profile 组合 base + acp-app，再应用 `backend/qq.patch.yml`。不改变 fork 的 tracked 源码，不启动 desktop/web surface；禁用本地文件/终端/web/subagent/workflow/goal/插件管理等模型工具，并默认拒绝 ACP 客户端权限请求。`backend-prepare` 静态检查真实 base/acp rows 的最终组合，构建清单校验防止误用其他来源。

静态组合和模拟 ACP 测试不等同于实际启动验证。部署者仍需完成 build、dump-config、真实 ACP/MCP prompt、会话恢复、模型切换和 QQ 发送验收。

L2 删除 desktop/web/market 等源码未实施。原 fork 的构建图会包含 CLI 所要求的其他构建依赖；本包不宣称已取得裁剪后的包体积、内存或启动时间数据。后续每次源码减法应独立提交，运行 fork build、对应测试及 qq smoke，并在此记录。

OFM 未安装。后续挂载需固定来源/版本、审阅 provider 与设置依赖，重新生成并审核组合及完整性清单，再验收后端公布的模型；不能只改锅巴下拉选项。
