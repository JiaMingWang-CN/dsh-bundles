# dsh-bundles

[English](README.en.md) | **中文**

dsh-bundles 是一组写给 DeepSeek Harness（dsh）的 `dsh.bundle` 插件包。每个子目录是一个独立可安装的 bundle，通过官方插件通道一键装进 web profile——一个在会话完成时提醒你，一个把本机 token 用量摊开给你看，还有一个给你的 agent 装上代码索引和实时文档。

## Table of Contents

- [How it works](#how-it-works)
- [Installation](#installation)
  - [Prerequisites](#prerequisites)
  - [From GitHub](#from-github)
  - [Local development](#local-development)
- [The Bundles](#the-bundles)
  - [ui-task-notify](#ui-task-notify)
  - [ui-usage-stats](#ui-usage-stats)
  - [mcp-toolkit](#mcp-toolkit)
- [When Something Goes Wrong](#when-something-goes-wrong)
- [Updating](#updating)
- [Philosophy](#philosophy)
- [Development notes](#development-notes)

## How it works

装好之后，这些 bundle 就在那里，不需要你做任何特别的事。

任务通知插件盯着主会话：任务跑完时，如果你正盯着界面，它什么都不做；如果你已经切走或最小化，它发一条系统通知。子 Agent 完成任务不通知——那个噪音比信号多。提示音由 Web Audio 现场合成，响度跟随系统音量，开关和提示音选择都持久化在 DSH 配置里。

用量统计插件在后台折叠本机全部会话日志，按「提供商 → 模型」「按模型」「按会话」三种视图把 token 用量摆出来。它只读日志、不算钱、不调模型。重新打开面板时先立刻画出上一次的结果，再后台更新，所以不会出现空白等待。

MCP 工具集注册两个 stdio server：**codegraph** 回答「这个符号在哪、它怎么被调用」这类问题（需要项目有 `.codegraph/` 索引），**context7** 把第三方库的当前文档喂给 agent，而不是让它靠过时的记忆瞎编。两个 server 的命令都走 `npx -y`，不污染全局环境。

三条 `dsh plugin add` 命令装完，profile 的 `patchReload: live` 会让正在运行的 dsh 直接热加载新 bundle——不用重启，刷新页面就行。

## Installation

### Prerequisites

两个 UI bundle（task-notify、usage-stats）没有任何前置依赖，装完即用。

MCP 工具集依赖以下两个工具，请先按各自仓库的教程安装，并确认命令可用（`codegraph --version`、`context7-mcp --help`）：

- **CodeGraph**：https://github.com/colbymchenry/codegraph
- **Context7**：https://github.com/upstash/context7

另外，codegraph 只能回答**已被索引的项目**——在被查询的项目里跑一次 `codegraph init` 生成 `.codegraph/` 索引。

### From GitHub

已安装 dsh 后，执行三条命令即可（前两条已在全新 profile 端到端实测）：

```powershell
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-client-ui-task-notify"
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-client-ui-usage-stats"
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-bundle-mcp-toolkit"
```

- git 安装时 pnpm 会自动装入包内依赖（`@deepseek-ai/schemastery` 等），无需手动 `pnpm install`；
- 首次启动时 MCP server 通过 `npx -y` 拉取，会稍慢；
- 安装后 `dsh --profile web --dump-config` 可确认 bundle 已进入层栈。

### Local development

克隆本仓库后用本地路径安装，改源码即时生效：

```powershell
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-client-ui-task-notify
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-client-ui-usage-stats
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-bundle-mcp-toolkit
```

## The Bundles

### ui-task-notify

会话完成系统通知。主会话完成任务、且界面未选中或已离开时发系统通知；子 Agent 不通知。设置页挂在「Agent 预设」下方（`settings.section` slot，order 25），提供总开关与提示音选择（系统默认 / 叮 / 叮咚 / 上升 / 静音），状态持久化到 `settings.yaml` 的 `ui-task-notify` 段。提示音由 Web Audio 合成，固定增益，响度跟随系统音量。

### ui-usage-stats

用量统计。设置页挂在「任务通知」下方（`settings.section` slot，order 30），折叠本机全部会话日志（含子 Agent），按「提供商 → 模型」「按模型」「按会话」三种视图展示 token 用量（输入 / 缓存读 / 缓存写 / 输出，推理单列但不重复计入）。同名模型由多个提供商提供时分别统计，「按模型」视图合并并列出全部提供商。数据只读、不折算费用、不做模型调用。

### mcp-toolkit

两个 stdio MCP server 的配置，命令走 `npx -y`，无需全局安装：

- **codegraph**（`mcp__codegraph__codegraph_explore`）：回答符号定位、调用路径、架构这类问题，支持任意**已索引**项目，靠每次调用的 `projectPath` 参数定位索引。
- **context7**（`mcp__context7__resolve-library-id` / `mcp__context7__query-docs`）：给 agent 喂第三方库的当前文档，而不是过时的训练记忆。

## When Something Goes Wrong

- **改了 host half（`lib/index.js`）后页面没变化**：正常。`patchReload: live` 只热重建客户端 bundle；host half 是启动时加载的，**要重启 dsh 才生效**。只改 `lib/client.js` 则刷新页面即可。
- **`link:` 安装后 task-notify 报缺依赖**：`dsh plugin add` 对本地目录默认走 `link:`，pnpm 不会代装依赖。第一次拿到仓库后，在 `dsh-client-ui-task-notify` 目录里跑一次 `pnpm install`（它依赖 `@deepseek-ai/schemastery`）。`dsh-client-ui-usage-stats` 没有依赖，不需要这一步。
- **codegraph 查询报找不到索引**：被查询的项目里没有 `.codegraph/`。跑一次 `codegraph init`。
- **首次启动 MCP server 很慢**：`npx -y` 在拉包，第二次就好了。

## Updating

- 更新全部：`dsh plugin --profile web update`；更新单个：`dsh plugin --profile web update dsh-client-ui-usage-stats`。更新后重启 dsh 生效。
- 卸载：`dsh plugin --profile web remove -w dsh-client-ui-task-notify dsh-client-ui-usage-stats dsh-bundle-mcp-toolkit`。

## Philosophy

- **只做一件事**：每个 bundle 一个明确的职责，彼此不依赖，按需安装。
- **数据只读**：统计插件只解码日志、只展示，不改会话、不调模型、不折算费用。
- **快是功能**：统计不回放校验、直接解码日志、按 `路径 + size + mtime` 缓存——首次折叠 ≈ 0.9 s，重复打开 ≈ 5 ms，而不是 14 s。
- **沿用既有机制**：设置页走 `settings.section` slot，跨 half 通信走 `ctx.webServer` 的包内路由——和官方包（`dsh-client-hmr`、`dsh-host-open-in-app`）一个做法，不发明新通道。

## Development notes

- **热更新边界**：`dsh plugin add` 对本地目录默认走 `link:`，改动 `lib/` 源码后刷新页面即生效，无需重装。但 host half（`lib/index.js`）是启动时加载的，改完**要重启 dsh**；只改 `lib/client.js` 则刷新页面即可。
- **task-notify 的依赖**：host half（`lib/index.js`）注册 `ui-task-notify` 设置 namespace，依赖 `@deepseek-ai/schemastery`。`link:` 安装时 pnpm 不代装依赖，需在包目录内手动 `pnpm install` 一次。客户端 half（`lib/client.js`）通过 `ctx.settingsScope` 读写持久化状态，通过 `settings.section` slot（order 25）挂载设置页。
- **usage-stats 无依赖**：host half 只用 `ctx.webServer`，`link:` 安装后无需 `pnpm install`。
- **直接读会话日志**：host half 直接读 `$DSH_HOME/sessions/*/*/session.v3.jsonl.zstd` 并按「提供商 + 模型」折叠 token（沿用 `dsh-token-meter` 的 `tokenUsage` 语义：同一 `(turn, step)` 槽位替换而非累加，`llm/retry-started` 结束替换范围）。**不要改回 `ctx.sessionQuery`**：那个服务对每个会话做完整回放校验，实测 40 个会话 / 50 MB 一次要 14 秒；直接解码同样数据只要 0.9 秒，而且大小 / mtime 签名可以让后续打开完全跳过解码：
  - 首次折叠 ≈ 0.9 s；重复打开 ≈ 5 ms；`?includeSubagents=false` 变体 ≈ 15 ms（不重新解码）；
  - 每个会话按 `路径 + size + mtime` 缓存，只有日志真的追加过才重新解析；报告本身按 15 s 新鲜度复用，因此即使面板不提供「刷新」按钮，重新打开也会拿到最新统计。
- **主 / 子会话靠目录名区分**：统计**默认包含子 Agent 会话**（面板不提供开关），因为日志头行在会话创建时就落盘，那时 harness 还不知道该会话会被委派，所以 **`origin` 字段在所有已落盘的日志里都不存在**（实测 40/40）。主会话是 `session-<uuid>`，子 Agent 是裸 uuid。
- **不要用 `harness.handle`**：那是动态 Cordis 插件（`cordis_define`）专属的沙箱 RPC，而 bundle 包的 host half 是普通 cordis 插件，**没有 `harness` 全局**（用了会导致整个 profile 启动失败）。这里改为由 host half 在 `ctx.webServer` 上注册一条包内路径 `GET /plugins/ui-usage-stats/summary`（JSON、`no-store`），浏览器 half 用 `fetch` 读取——与 `dsh-client-hmr`、`dsh-host-open-in-app` 等官方包的做法一致。
- **格式化放在 host half**：数字（千分位 / 万 / 亿）在 host half 用 `Intl` 格式化后下发，因为客户端执行环境不保证有 `Intl`。面板会把上一次结果留在内存里，重新打开时先立即画出旧数据再后台更新，所以不会出现空白等待。
- **客户端 half 直接用 `ctx.slots`**：必须显式声明 `inject: ["slots"]` 并直接用 `ctx.slots`（`ctx.slots.inject` → `ctx.slots.register`），与官方 `settings.section` 注册方保持一致；不要改用 `ctx.get("slots")` 之后再通过被注入服务转发注册。
