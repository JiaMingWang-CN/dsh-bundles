# @wjm200509/dsh-bundle-mcp-toolkit

**中文** · 通过 stdio 客户端向 DSH 注册两个 MCP server：

- **CodeGraph**：通过本地代码索引定位符号、调用路径和架构关系；
- **Context7**：向 Agent 提供当前版本的第三方库文档与示例。

CodeGraph 与 Context7 由 `npx -y` 启动，都不要求全局安装。

## 前置条件

- Node.js 20 或更高版本，以及可用的 `npx`；
- CodeGraph 查询的每个项目要有 `.codegraph/` 索引。

## 安装

```powershell
dsh plugin --profile web add -w "@wjm200509/dsh-bundle-mcp-toolkit"
```

安装后重启 DSH。首次启动时 `npx` 需要下载对应包，耗时会比后续启动长。

## Context7 登录（首次使用，等同 `npx ctx7 setup`）

Context7 以 **API Key 模式**运行，但不再需要手工改配置填 Key：

1. 插件首次启用且尚未登录时，会自动发起 Context7 的 **OAuth 设备码登录**（与官方 `npx ctx7 setup` 同一个流程、同一个公开 OAuth 端点）；
2. 在对话里让代理调用 **`context7_login`** 工具，它会返回验证链接和一次性验证码（启动日志里也会打印一份）；
3. 在浏览器打开链接、输入验证码并批准后，Context7 签发的 API Key 会**自动存入 DSH 凭据库**（`CONTEXT7_API_KEY`，配置文件中只有引用，没有明文）；
4. 凭据写入后 `mcp-context7` 行会自动重连，`mcp__context7__*` 工具即可使用。

只有未登录时，系统提示里会出现一条简短提示，引导代理调用 `context7_login`；登录后不再出现。Key 保存在 DSH 凭据里，跨插件升级与会话重启都保留。

## 使用

- 工具以 `mcp__<server>__<tool>` 暴露，例如 `mcp__codegraph__codegraph_explore`、`mcp__context7__query-docs`；
- CodeGraph 需要目标项目已建立索引：在项目根目录执行 `codegraph init -i`；
- Context7 首次使用按上文登录一次即可。

版本固定在 `patch.yml` 中：CodeGraph `@colbymchenry/codegraph@1.6.2`、Context7 `@upstash/context7-mcp@4.5.0`；启动时不会重新联网解析最新版本，升级时修改该文件中的版本号。

## 兼容

适配 DSH **0.2.2-rc.1**；`engines.dsh` 同时保留 `0.1.7-rc.2`、`0.2.0-rc.2`、`0.2.1-alpha.x` 的范围。

## 开发

```powershell
cd dsh-bundle-mcp-toolkit
npm test
```

- `patch.yml`：三条 loader 行（`context7-auth` 登录插件，以及两个 MCP client 行）；
- `lib/index.js`：Context7 登录 Host 插件（`context7_login` 工具 + 登录提示 + 凭据写入）；
- `lib/oauth.js`：Context7 设备码 OAuth 的纯逻辑，`fetch` 可注入，便于测试；
- `test/oauth.test.js`：设备码流程状态机的单元测试。
