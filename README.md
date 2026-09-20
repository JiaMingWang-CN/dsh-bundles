# dsh-bundles

DeepSeek Harness（dsh）的 `dsh.bundle` 插件包集合。每个子目录是一个独立可安装的
bundle 包，通过官方插件通道一键安装到 web profile。

## 包列表

| 目录 | 内容 |
|---|---|
| `dsh-client-ui-task-notify` | 会话完成系统通知插件：主会话完成任务且未选中/离开界面时发系统通知（子 Agent 不通知）；设置页在「Agent 预设」下方，提供开关与提示音选择（系统默认 / 叮 / 叮咚 / 上升 / 静音），开关与提示音持久化到 DSH 配置（`settings.yaml` 的 `ui-task-notify` 段）。提示音由 Web Audio 合成，固定增益，响度跟随系统音量。 |
| `dsh-client-ui-usage-stats` | 用量统计插件：设置页在「任务通知」下方，折叠本机全部会话日志（含子 Agent），按「提供商 → 模型」「按模型」「按会话」三种视图展示 token 用量（输入 / 缓存读 / 缓存写 / 输出，推理单列但不重复计入）。同名模型由多个提供商提供时分别统计，「按模型」视图合并并列出全部提供商。数据只读、不折算费用、不做模型调用。 |
| `dsh-bundle-mcp-toolkit` | MCP 工具集配置：codegraph（需项目有 `.codegraph/` 索引，`codegraph init` 创建）与 context7 两个 stdio MCP server，命令走 `npx -y`，无需全局安装。 |

## 安装

### 前置条件

MCP 工具集依赖以下两个工具，请先按各自仓库的教程安装并确认命令可用（`codegraph --version`、`context7-mcp --help`）：

- **CodeGraph**：https://github.com/colbymchenry/codegraph
- **Context7**：https://github.com/upstash/context7

已安装 dsh 后，执行三条命令即可（前两条已在全新 profile 端到端实测）：

```powershell
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-client-ui-task-notify"
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-client-ui-usage-stats"
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-bundle-mcp-toolkit"
```

- git 安装时 pnpm 会自动装入包内依赖（`@deepseek-ai/schemastery` 等），无需手动 `pnpm install`；
- 首次启动时 MCP server 通过 `npx -y` 拉取，会稍慢；
- 安装后 `dsh --profile web --dump-config` 可确认 bundle 已进入层栈；profile 的
  `patchReload: live` 会让正在运行的 dsh 直接热加载新 bundle（无需重启，刷新页面即可）；
- 卸载：`dsh plugin --profile web remove -w dsh-client-ui-task-notify dsh-client-ui-usage-stats dsh-bundle-mcp-toolkit`；
- 更新：`dsh plugin --profile web update dsh-client-ui-usage-stats`（包规格未钉 commit、
  只钉默认分支，pnpm 会重新解析并拉回 `main` 最新状态；只替换 profile 的 `node_modules`，
  不碰会话日志与设置）。**注意生效范围**：`patchReload: live` 只热重建客户端 bundle，
  所以只改了 `lib/client.js` 时刷新页面即生效；改了 host half（`lib/index.js`）则需重启
  dsh 才生效。

本地开发安装（克隆本仓库后用本地路径，改源码即时生效）：

```powershell
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-client-ui-task-notify
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-client-ui-usage-stats
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-bundle-mcp-toolkit
```

## 开发说明

- `dsh plugin add` 对本地目录默认走 `link:` 链接——改动 `lib/` 源码后刷新页面即生效，无需重装；
- `dsh-client-ui-task-notify` 的 host half（`lib/index.js`）注册 `ui-task-notify` 设置
  namespace，依赖 `@deepseek-ai/schemastery`；该包用 `link:` 方式安装时 pnpm 不会代装
  依赖，首次拿到仓库后需在包目录内执行一次 `pnpm install`；
- 客户端 half（`lib/client.js`）通过 `ctx.settingsScope` 读写持久化状态，通过
  `settings.section` slot（order 25）挂载设置页。
- `dsh-client-ui-usage-stats` 没有任何依赖（host half 只用 `ctx.webServer`），`link:` 安装后
  无需 `pnpm install`；
- 它的 host half **直接读会话日志文件**（`$DSH_HOME/sessions/*/*/session.v3.jsonl.zstd`）
  并按「提供商 + 模型」折叠 token（沿用 `dsh-token-meter` 的 `tokenUsage` 语义：同一
  `(turn, step)` 槽位替换而非累加，`llm/retry-started` 结束替换范围）。**不要改回
  `ctx.sessionQuery`**：那个服务对每个会话做完整回放校验，实测 40 个会话 / 50 MB 一次要
  14 秒；直接解码同样数据只要 0.9 秒，而且大小/mtime 签名可以让后续打开完全跳过解码：
  - 首次折叠 ≈ 0.9 s；重复打开 ≈ 5 ms；`?includeSubagents=false` 变体 ≈ 15 ms（不重新解码）；
  - 每个会话按 `路径 + size + mtime` 缓存，只有日志真的追加过才重新解析；报告本身按 15 s
    新鲜度复用，因此即使面板不提供「刷新」按钮，重新打开也会拿到最新统计；
- 统计**默认包含子 Agent 会话**（面板不提供开关）：只能靠**目录名**区分主/子，因为日志头行在
  会话创建时就落盘，那时 harness 还不知道该会话会被委派，所以 **`origin` 字段在所有已落盘的
  日志里都不存在**（实测 40/40）。主会话是 `session-<uuid>`，子 Agent 是裸 uuid；
- 两个 half 之间不走 `harness.handle`：那是动态 Cordis 插件（`cordis_define`）专属的沙箱
  RPC，而 bundle 包的 host half 是普通 cordis 插件，**没有 `harness` 全局**（用了会导致整个
  profile 启动失败）。这里改为由 host half 在 `ctx.webServer` 上注册一条包内路径
  `GET /plugins/ui-usage-stats/summary`（JSON、`no-store`），浏览器 half 用 `fetch` 读取——
  与 `dsh-client-hmr`、`dsh-host-open-in-app` 等官方包的做法一致；
- 浏览器 half 只做渲染，数字（千分位 / 万 / 亿）在 host half 用 `Intl` 格式化后下发，
  因为客户端执行环境不保证有 `Intl`；设置页通过 `settings.section` slot（order 30）
  挂载在「任务通知」下方；面板会把上一次结果留在内存里，重新打开时先立即画出旧数据再后台更新，
  所以不会出现空白等待；
- 客户端 half 必须显式声明 `inject: ["slots"]` 并直接用 `ctx.slots`（`ctx.slots.inject`
  → `ctx.slots.register`），与官方 `settings.section` 注册方保持一致；不要改用
  `ctx.get("slots")` 之后再通过被注入服务转发注册。
- 改了 host half（`lib/index.js`）之后**要重启 dsh 才生效**：profile 的 `patchReload: live`
  只会热重建客户端 bundle，host half 是启动时加载的；只改 `lib/client.js` 则刷新页面即可。
