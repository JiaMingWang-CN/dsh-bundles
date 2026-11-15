# @wjm200509/dsh-bundle-mcp-toolkit

**中文** · 通过 stdio 客户端向 DSH 注册三个 MCP server：

- **CodeGraph**：通过本地代码索引定位符号、调用路径和架构关系；
- **Context7**：向 Agent 提供当前版本的第三方库文档与示例；
- **Browser-Use**：让 Agent 驱动真实浏览器执行网页操作（打开页面、点击、填表、抓取内容）。

CodeGraph 与 Context7 由 `npx -y` 启动，Browser-Use 由 `uvx` 启动，都不要求全局安装。

## 前置条件

- Node.js 20 或更高版本，以及可用的 `npx`；
- 使用 Browser-Use 时还需要 `uv`（提供 `uvx`，见 <https://docs.astral.sh/uv/>）与 Python 3.12；
- CodeGraph 查询的每个项目要有 `.codegraph/` 索引。

## 安装

```powershell
dsh plugin --profile web add -w "@wjm200509/dsh-bundle-mcp-toolkit"
```

安装后重启 DSH。首次启动时 `npx`/`uvx` 需要下载对应包，耗时会比后续启动长。

## 使用

- 工具以 `mcp__<server>__<tool>` 暴露，例如 `mcp__codegraph__codegraph_explore`；
- CodeGraph 需要目标项目已建立索引：在项目根目录执行 `codegraph init -i`；
- Context7 不要求项目初始化；如果服务端提示限流或要求认证，可运行 `npx ctx7 setup`；
- Browser-Use 不要求项目初始化，调用会驱动真实浏览器。

版本固定在 `patch.yml` 中：CodeGraph `@colbymchenry/codegraph@1.6.2`、Context7 `@upstash/context7-mcp@4.5.0`、Browser-Use `browser-use==0.13.14`；启动时不会重新联网解析最新版本，升级时修改该文件中的版本号。

## 兼容

适配 DSH **0.2.2-rc.1**；`engines.dsh` 同时保留 `0.1.7-rc.2`、`0.2.0-rc.2`、`0.2.1-alpha.x` 的范围。

## 开发

```powershell
cd dsh-bundle-mcp-toolkit
```

目录只有 `patch.yml`（三个 MCP client 行）和本文件；插件不包含 Host/Client 代码。
