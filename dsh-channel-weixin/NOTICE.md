# 依赖、平台与第三方声明

## 运行依赖

**零第三方运行依赖。** 插件只使用 Node.js 内置模块与标准全局能力：

- 内置模块导入（`lib/` 全部导入清单）：`node:fs`、`node:os`、`node:path`；
- 使用的运行时全局：`fetch`、`URL`、`URLSearchParams`、`Buffer`、`AbortController`、
  `Intl`（时区标签）、`setTimeout`/`setInterval`、`Promise.withResolvers`；
- 除上述之外没有任何包导入——`lib/` 的其余 import 全部是插件自身的相对模块。

这是刻意的约束，而非巧合：第三方 bundle 从自身目录**无法解析** DSH 安装内的依赖
（如 `zod`、`@deepseek-ai/dsh-llm`），因此存储、二维码编码、协议客户端与消息管道全部自带实现。
`package.json` 不声明任何 `dependencies`，安装时不会拉取额外包。

## 宿主服务依赖

| 服务 | 用途 | 缺失时行为 |
| --- | --- | --- |
| `webServer` | 注册插件路由（设置页数据面） | 插件行等待该服务（DSH 的 web profile 始终提供） |
| `agents` | 会话列举/新建/恢复、提交任务、队列控制 | 环路不启动；`/stop`、`/model`、`/usage` 等回复"会话不可用" |
| `permissionPresets` | 新建会话应用完全权限预设 | 会话可创建但回复中说明未能应用完全权限 |
| `sessionPersistence` | 列举/恢复非活动会话 | `/sessions` 只列活动会话，`/use` 对未运行会话报"无法恢复" |
| `sessionProjections` | 读取 `modelSelection`、`tokenUsage` 投影 | `/model` 不显示当前值、`/usage` 报"用量不可用" |
| `llm` / `agentDefaultModel` | 模型目录枚举 | `/models`、`/model` 回复"没有可用的模型服务" |
| `sessionQuery` | 关键词历史检索 | `/search` 回复"当前部署未启用会话检索" |

可选服务缺失时插件**不会因此不激活**：环路与页面按能力降级，并在回复里说明原因。

## 平台支持

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Windows 10/11 | 支持 | 目录校验按 Windows 规则（盘符、UNC）；凭证文件依赖 ACL 保护（`chmod` 为尽力而为） |
| Linux | 支持 | 凭证与状态文件以 `0o600`/目录 `0o700` 写入 |
| macOS | 未验证 | 未在计划的首版范围内，代码无平台特定分支，理论上可用 |

已知平台差异：

- **路径判定使用 DSH 宿主平台的规则**：目录是"DSH 所在机器"的路径，因此 Linux 上
  `C:\work` 会被判为相对路径并拒绝，反之亦然。这是刻意行为，不是兼容性缺陷。
- **私密文件权限**：Linux 由 `0o600`/`0o700` 保证；Windows 上 POSIX 权限位是建议性的，
  实际保护来自文件 ACL（未做额外的 ACL 收紧，未在真实 Windows 环境验证过实际 ACL 结果）。
- **时区显示**依赖 Node 的完整 ICU（现代官方发行版默认具备）；若 ICU 精简导致
  `Intl` 无法给出偏移，则回退为仅显示时区名。

## 第三方声明

本插件是**独立实现**，不包含、不链接、不启动 OpenClaw：没有 `openclaw/plugin-sdk` 依赖，
不读取 `~/.openclaw`，不启动网关或子进程，不使用其配置或存储结构。

协议交互的事实依据来自参考项目 `@tencent-weixin/openclaw-weixin` v2.4.9
（MIT，`Copyright (C) 2026 Tencent`，见 `preferences/openclaw-weixin/LICENSE`）。
本插件**未复制其源代码**：端点、请求头与消息形状按协议文档与公开字段实现，
二维码编码器、消息管道、状态机均为本项目自有代码。

MIT 只解决代码版权问题，**不授予使用微信服务的任何权利**。参考项目为腾讯官方开源，
不构成对第三方独立实现被服务端接受的任何背书；服务端准入、限频、主动推送与令牌有效期
均须以真实账号联调结论为准。
使用本插件产生的账号风险由使用者自行承担。

## 本项目许可

MIT，见 `LICENSE`。
