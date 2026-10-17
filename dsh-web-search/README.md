# dsh-web-search

**中文** · 第三方网页搜索插件：为 DSH 的 `web_search` 工具增加 **Tavily / 模型自带联网**
两个后端，并在设置侧边栏的"第三方搜索"页面提供**总开关**。关闭开关即交回 DSH 内置搜索，
开启后 `web_search` 走所选第三方后端，无需重启。不修改 DSH 源码，卸载即恢复内置行为。

## 搜索工具

| 引擎 | 计费 | 说明 |
| --- | --- | --- |
| **Tavily（默认、推荐）** | **免费 1000 次/月** | LLM 优化搜索，返回摘要 + AI 答案；在 <https://app.tavily.com> 注册并创建 API Key |
| **模型自带联网** | 约 ¥16/千次 + token 费 | 借 MiMo API 服务端 `web_search`；需在 MiMo 控制台（Console → Plugin Management）开通「Web Search 插件」；本插件固定单次 1 个关键词以控制费用 |

关闭总开关后，`web_search` 交回 DSH 内置的 DeepSeek 搜索：

- 默认回到 `deepseek-official`（Messages 联网搜索）；
- 如果之前在 DSH 内置的 Web search 页选过新版 Search API，插件会记住并恢复到
  `deepseek-search-api`（`/v1/tools/search`）。

官方搜索的认证、参数和计费完全由 DSH 内置 provider 负责，本插件不重复实现。

## 安装

```powershell
# 从 GitHub
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-web-search"

# 本地目录
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-web-search

# link: 安装不会自动安装包内依赖，需在本目录执行一次：
cd dsh-web-search
pnpm install
```

安装后**重启 DSH**。确认组合生效：

```powershell
dsh --profile web --dump-config
# 期望：web 行 config.searchProvider: web-search（fetchProvider: http）
#       web-search 行存在
#       web-search-deepseek 行保持启用（关闭开关后的内置后端）
```

## 使用

1. 打开 DSH 设置，在侧边栏进入 **第三方搜索**（同一页面也可在 设置 → 插件 → dsh-web-search 的行配置中打开）；
2. 顶部开关默认**已开启**；选择 Tavily / 模型自带联网，填入 API Key 与参数，保存；
3. 需要回到内置搜索时，关闭顶部开关即可，下一次 `web_search` 立即改用内置 provider。

开启前需要当前引擎至少有一个已保存的 Key。关闭状态下 Key 输入框仍可填写，方便先配置再开启。

## 开关如何工作

- 插件 patch 层把 `web` 行设为 `searchProvider: web-search`，这是**默认开启**的来源；
- **开启**：客户端对 `web` 的 `searchProvider` / `fetchProvider` 两个字段执行 `unset`。DSH 的设置服务
  会把 `unset` 解析为继承值；当整条配置与继承层完全相等时，用户层覆盖会被自动删除。因此
  `web-search` 不会被写进用户配置；
- **关闭**：按插件区的 `builtin` 记忆写入内置的一组 provider：
  - `messages` → `deepseek-official` + `http`；
  - `api` → `deepseek-search-api` + `deepseek-fetch-api`；
- 插件页的开关状态由 `web.searchProvider === "web-search"` 推算，不另存布尔值。在内置页切换
  provider 时，插件页会同步显示为"已关闭"。

### 卸载行为

| 卸载时状态 | 用户层 `web` | 结果 |
| --- | --- | --- |
| 开启 | 无覆盖 | 插件层随 bundle 消失，回到 DSH 默认值，零残留 |
| 关闭 | 内置的一组 id | 指向 DSH 自带 provider，搜索正常 |
| 从未切换 | 无 | 零残留 |

插件自己的 `web-search` 配置行（引擎、Key 引用等）在卸载后仍会留在用户层，这不影响 `web`，
也不会造成悬空 provider。

## 行为细节

- **密钥安全**：API Key 经 credentials 域写入（`$DSH_HOME/.credentials.yaml`），不写入
  profile 设置文件、界面不回显明文；留空保持当前密钥。解析顺序：设置中的明文字段 →
  credentials/launch-environment 中的凭证引用（默认 `TAVILY_API_KEY` / `MIMO1_API_KEY`）。
- **结果契约**：适配器只解析结构化结果（Tavily `results`/`answer`、MiMo `url_citation` 注解与
  `search_results`），绝不从模型文本里抓 URL；来源数上限（默认 8）由 `dsh-tool-web`/web 接缝截断。
- **错误码**：`WEB_PROVIDER_CREDENTIAL_MISSING`（缺密钥/密钥被拒）、`WEB_PROVIDER_ERROR`
  （传输/配额/响应不可解析）、`WEB_ABORTED`（取消）。缺 Key 的报错会同时提示两条出路：填 Key，
  或关闭第三方搜索改用内置。
- **模型引擎成本控制**：请求固定 `max_keyword: 1`（MiMo 按关键词次数计费）。
- **零修改 DSH 本体**：生效完全通过 loader 组合补丁（`patch.yml`：插入本插件行、把 `web` 行
  指向 `web-search`）和设置服务的公开写入接口；不修改 `app.asar`，卸载即完整还原。

## 已接受的限制

1. **刚装好、还没填 Key 时，搜索会报错。** patch 层默认开启，而 seam 没有回退；缺 Key 时会抛
   `WEB_PROVIDER_CREDENTIAL_MISSING`，报错文案会提示填 Key 或关闭开关。`available()` 保持
   返回 `true`，避免变成含义更模糊的 `CONFIGURED_UNAVAILABLE`。
2. **插件开启时，内置 Web search 页的开关显示为 "Messages 搜索"。** 内置页只认它自己的两组 id，
   实际后端以插件页的开关为准。
3. **开启插件时 `fetchProvider` 回到 `http`。** 插件层固定为 `http`；之前选了新版 Search API 的
   用户，开启期间也用 HTTP 抓取，关闭后按 `builtin` 恢复 `deepseek-fetch-api`。
4. **旧配置 `engine: deepseek` 仍然能加载**，但会归一化为 Tavily；这是为了不让旧配置让插件
   加载失败、连关闭开关的入口都没有。

## 版本与兼容

- 0.4.0：从"接管"改为"补充"；删除插件内的 DeepSeek 官方引擎，交由 DSH 内置 provider 处理。
- 适配 DSH **0.2.1-rc.2**（当前最新）；测试依赖固定到该版本，peer 范围同时保留
  `0.2.0-rc.2`、`0.2.1-alpha.x` 与 `0.1.7-rc.2`。
- 官方 Search API 文档：<https://api-docs.deepseek.com/api/search>。

## 本地开发

```powershell
cd dsh-web-search
pnpm install
node --test
```

引擎映射、分发和选项归一化保持为纯逻辑；Host 入口显式依赖公开的
`@deepseek-ai/dsh-web`、`@deepseek-ai/dsh-launch-environment` 与 `@deepseek-ai/schemastery` 契约。

```text
dsh-web-search/
├── patch.yml              # loader 组合补丁（insert + web provider 指向）
├── lib/
│   ├── index.js           # 宿主半边：Config 设置表单 + 注册搜索提供方
│   ├── client.js          # 浏览器半边：总开关 + plugins.row.config「第三方搜索」页
│   ├── dispatch.js        # 按设置分发到所选引擎（每次搜索入口快照配置）
│   ├── options.js         # 设置归一化 + 可用性检查
│   ├── http.js            # JSON POST / 取消分类
│   ├── errors.js          # HarnessError 形状的错误工厂
│   └── engines/           # tavily / model-native 适配器
└── test/                  # node --test 单测
```
