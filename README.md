# dsh-bundles

DeepSeek Harness（dsh）的 `dsh.bundle` 插件包集合。每个子目录是一个独立可安装的
bundle 包，通过官方插件通道一键安装到 web profile。

## 包列表

| 目录 | 内容 |
|---|---|
| `dsh-client-ui-task-notify` | 会话完成系统通知插件：主会话完成任务且未选中/离开界面时发系统通知（子 Agent 不通知）；设置页在「Agent 预设」下方，提供开关与提示音选择（系统默认 / 叮 / 叮咚 / 上升 / 静音），开关与提示音持久化到 DSH 配置（`settings.yaml` 的 `ui-task-notify` 段）。提示音由 Web Audio 合成，固定增益，响度跟随系统音量。 |
| `dsh-bundle-mcp-toolkit` | MCP 工具集配置：codegraph（需项目有 `.codegraph/` 索引，`codegraph init` 创建）与 context7 两个 stdio MCP server，命令走 `npx -y`，无需全局安装。 |

## 安装

### 前置条件

MCP 工具集依赖以下两个工具，请先按各自仓库的教程安装并确认命令可用（`codegraph --version`、`context7-mcp --help`）：

- **CodeGraph**：https://github.com/colbymchenry/codegraph
- **Context7**：https://github.com/upstash/context7

已安装 dsh 后，执行两条命令即可（已在全新 profile 端到端实测）：

```powershell
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-client-ui-task-notify"
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-bundle-mcp-toolkit"
```

- git 安装时 pnpm 会自动装入包内依赖（`@deepseek-ai/schemastery` 等），无需手动 `pnpm install`；
- 首次启动时 MCP server 通过 `npx -y` 拉取，会稍慢；
- 安装后 `dsh --profile web --dump-config` 可确认 bundle 已进入层栈，重启 dsh 生效；
- 卸载：`dsh plugin --profile web remove -w dsh-client-ui-task-notify dsh-bundle-mcp-toolkit`。

本地开发安装（克隆本仓库后用本地路径，改源码即时生效）：

```powershell
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-client-ui-task-notify
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-bundle-mcp-toolkit
```

## 开发说明

- `dsh plugin add` 对本地目录默认走 `link:` 链接——改动 `lib/` 源码后刷新页面即生效，无需重装；
- `dsh-client-ui-task-notify` 的 host half（`lib/index.js`）注册 `ui-task-notify` 设置
  namespace，依赖 `@deepseek-ai/schemastery`；该包用 `link:` 方式安装时 pnpm 不会代装
  依赖，首次拿到仓库后需在包目录内执行一次 `pnpm install`；
- 客户端 half（`lib/client.js`）通过 `ctx.settingsScope` 读写持久化状态，通过
  `settings.section` slot（order 25）挂载设置页。
