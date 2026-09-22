# dsh-bundles

**中文** · [English](README.en.md)

一组面向 DeepSeek Harness（dsh）web profile 的独立插件：任务完成通知、跨会话 Token 用量面板，以及 CodeGraph + Context7 MCP 工具集。

每个目录都是一个可单独安装的 bundle。只安装需要的部分即可。

## 目录

- [包含内容](#包含内容)
- [快速安装](#快速安装)
- [MCP 工具安装](#mcp-工具安装)
  - [CodeGraph](#codegraph)
  - [Context7](#context7)
- [使用方式](#使用方式)
- [更新与卸载](#更新与卸载)
- [常见问题](#常见问题)
- [本地开发](#本地开发)

## 包含内容

### 任务通知

`dsh-client-ui-task-notify` 在主会话完成任务且页面不在前台时发送系统通知。

- 子 Agent 完成时不通知；
- 提供系统默认、叮、叮咚、上升和静音五种提示音；
- 开关与提示音写入 DSH 的持久化设置；
- 自定义提示音由 Web Audio 生成，音量跟随系统。

### 用量统计

`dsh-client-ui-usage-stats` 读取本机 DSH 会话日志，生成跨会话 Token 用量面板。

- 按提供商、模型或会话查看；
- 分开展示输入、缓存读取、缓存写入、输出与推理 Token；
- 推理 Token 已包含在输出中，不会重复计入总量；
- 包含主会话与子 Agent 会话；
- 只读取日志，不调用模型，也不估算费用；
- 按日志大小与修改时间缓存，重复打开无需重新解码全部历史记录。

### MCP 工具集

`dsh-bundle-mcp-toolkit` 向 DSH 注册两个 stdio MCP server：

- **CodeGraph**：通过本地代码索引定位符号、调用路径和架构关系；
- **Context7**：向 Agent 提供当前版本的第三方库文档与示例。

两个 server 都由 `npx -y` 启动，不要求全局安装 npm 包。

### 网页搜索

`dsh-web-search` 为 `web_search` 工具提供可切换的搜索后端，在“设置 → 插件 → 插件配置 →
网页搜索”卡片中一键更换，即时生效；不修改 DSH 本体，卸载即恢复内置行为。

- Tavily（默认）：免费 1000 次/月，LLM 优化搜索；
- 模型自带联网：MiMo 服务端 `web_search`，约 ¥16/千次 + token 费（需在 MiMo 控制台开通「Web Search 插件」）；
- DeepSeek 官方：沿用内置搜索，消耗 DeepSeek 余额；
- API Key 经 credentials 域保存，不落 `settings.yaml` 明文。

### 微信连接

`dsh-channel-weixin` 让用户通过微信文字消息操作 DSH：扫码连接后，微信里的文字作为任务
发给绑定的 DSH 会话，结果按段落回复到微信。

- 独立实现：不依赖、不启动 OpenClaw，未复制其源代码，零第三方运行依赖（只用 Node 内置模块）；
- 设置中独立入口（`order: 35`，位于“用量统计”之后），显示连接状态、绑定会话与目录、队列与定时任务数量；
- 命令（微信中发送 `/help` 查看）：`/new`、`/sessions`、`/use`、`/cwd`、`/stop`、`/queue`、
  `/schedule`、`/agents`、`/agent`、`/models`、`/model`、`/usage`、`/search`；
- 边界：单账号、仅扫码绑定的本人私聊；仅文字；微信任务按完全权限执行；
  停机期间错过的定时触发只标记不补跑；主动推送受微信服务端限制，须以真实联调结论为准。

## 快速安装

### 前置条件

- 已安装 DeepSeek Harness（dsh）；
- 使用 MCP 工具集时，需要 Node.js 20 或更高版本；
- Windows、macOS 或 Linux 上可用的 `npx`。

### 从 GitHub 安装

分别执行需要的命令：

```powershell
# 任务完成通知
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-client-ui-task-notify"

# Token 用量统计
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-client-ui-usage-stats"

# CodeGraph + Context7 MCP 工具集
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-bundle-mcp-toolkit"

# 免费网页搜索（Tavily / 模型自带联网 / DeepSeek 可切换）
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-web-search"

# 微信连接
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-channel-weixin"
```

确认 bundle 已进入 web profile：

```powershell
dsh --profile web --dump-config
```

首次启动 MCP 工具集时，`npx` 需要下载对应包，耗时会比后续启动更长。

## MCP 工具安装

MCP bundle 已经包含 DSH 所需的 server 配置；下面只需准备运行环境和项目索引。

### CodeGraph

- **项目地址**：https://github.com/colbymchenry/codegraph

CodeGraph 在本地建立代码知识图谱。MCP server 可以服务多个项目，但每个项目都要单独创建 `.codegraph/` 索引。

### Context7

- **项目地址**：https://github.com/upstash/context7

Context7 默认可以直接启动；如果服务端提示限流或要求认证，可运行 `npx ctx7 setup` 完成官方引导配置。

## 使用方式

### 开启任务通知

1. 打开 DSH 的“设置”；
2. 进入“任务通知”；
3. 开启通知并选择提示音；
4. 浏览器首次请求系统通知权限时选择允许。

只有主会话从运行中变为完成、且当前页面未聚焦时才会通知。

### 查看 Token 用量

1. 打开 DSH 的“设置”；
2. 进入“用量统计”；
3. 在“提供商 / 模型 / 会话”之间切换。

Host 端修改需要重启 DSH；只修改客户端界面时刷新页面即可。

### 切换网页搜索

1. 打开 DSH 的“设置”；
2. 进入“插件 → 插件配置 → 网页搜索”；
3. 选择搜索工具（Tavily / 模型自带联网 / DeepSeek 官方），填入 API Key 并保存。

切换即时生效、无需重启；各引擎的开通与计费说明见 `dsh-web-search/README.md`。

### 使用 MCP 工具

- CodeGraph 查询要求目标项目已有 `.codegraph/`；
- Context7 不要求项目初始化；
- DSH 首次拉起 server 较慢属于正常现象；
- 可以使用 `dsh --profile web --dump-config` 检查 MCP client 是否进入配置层栈。

## 更新与卸载

更新全部已安装插件：

```powershell
dsh plugin --profile web update
```

更新单个插件：

```powershell
dsh plugin --profile web update dsh-client-ui-usage-stats
```

卸载本仓库的 bundle：

```powershell
dsh plugin --profile web remove -w dsh-client-ui-task-notify dsh-client-ui-usage-stats dsh-bundle-mcp-toolkit dsh-channel-weixin dsh-web-search
```

卸载微信连接**不会删除已保存的凭证与绑定状态**（`$DSH_HOME/storages/channel-weixin/`）。
如需彻底清除，请先在设置页“退出登录”，或手动删除该目录。

更新或卸载后建议重启 DSH。

## 常见问题

### CodeGraph 提示找不到索引

在被查询项目的根目录执行：

```powershell
codegraph init -i
```

### MCP server 第一次启动很慢

Bundle 使用 `npx -y`。第一次运行需要下载包，后续会使用本机缓存。

### 修改用量统计后页面没有变化

- 修改 `lib/client.js`：刷新浏览器；
- 修改 `lib/index.js`：重启 DSH 后再刷新。

### 本地安装任务通知后缺少依赖

本地目录安装使用 `link:` 时，不会自动安装包内依赖。执行：

```powershell
cd dsh-client-ui-task-notify
pnpm install
```

## 本地开发

克隆仓库后，通过本地路径安装：

```powershell
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-client-ui-task-notify
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-client-ui-usage-stats
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-bundle-mcp-toolkit
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-channel-weixin
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-web-search
```

运行测试（用量统计、微信连接与网页搜索都带 `node --test` 测试）：

```powershell
cd dsh-client-ui-usage-stats
npm test

cd ..\dsh-channel-weixin
npm test

cd ..\dsh-web-search
npm test
```

目录结构：

```text
dsh-bundles/
├── dsh-client-ui-task-notify/
├── dsh-client-ui-usage-stats/
├── dsh-bundle-mcp-toolkit/
├── dsh-channel-weixin/
├── dsh-web-search/
├── docs/                    # 插件计划与阶段核对报告
└── preferences/             # 只读参考项目
```
