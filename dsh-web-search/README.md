# dsh-web-search

**中文** · 免费网页搜索插件：为 DSH 的 `web_search` 工具提供**可切换的多引擎搜索后端**，
在"设置 → 插件 → dsh-web-search → 网页搜索（配置）"页面中一键更换搜索工具，即时生效、无需重启。
不修改 DSH 本体，卸载即恢复内置行为。

## 搜索工具（三选一）

| 引擎 | 计费 | 说明 |
| --- | --- | --- |
| **Tavily（默认、推荐）** | **免费 1000 次/月** | LLM 优化搜索，返回摘要 + AI 答案；在 <https://app.tavily.com> 注册并创建 API Key |
| **模型自带联网** | 约 ¥16/千次 + token 费 | 借 MiMo API 服务端 `web_search`；需在 MiMo 控制台（Console → Plugin Management）开通「Web Search 插件」；本插件固定单次 1 个关键词以控制费用 |
| **DeepSeek 官方** | 消耗 DeepSeek 余额 | 沿用内置 DeepSeek 官方搜索（Anthropic 兼容 Messages API 的原生 `web_search`），行为与原版一致 |

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
# 期望：web 行 config.searchProvider: web-search（fetchProvider: http 保留）
#       web-search-deepseek 行 disabled: true
#       web-search 行存在
```

## 使用

1. 打开 DSH 设置 → 插件 → **dsh-web-search**，点"网页搜索"行的"配置"；
2. 选择搜索工具（Tavily / 模型自带联网 / DeepSeek 官方），填入对应 API Key（可选）与参数，保存；
3. 会话中的 `web_search` 即走所选后端，切换即时生效。

## 行为细节

- **密钥安全**：API Key 经 credentials 域写入（`$DSH_HOME/.credentials.yaml`），不写入 `settings.yaml`、界面不回显明文；留空保持当前密钥。解析顺序：设置中的明文字段 → credentials/launch-environment 中的凭证引用（默认 `TAVILY_API_KEY` / `MIMO1_API_KEY` / `DEEPSEEK_API_KEY`，可在设置命名空间中改名）。
- **结果契约**：适配器只解析结构化结果（Tavily `results`/`answer`、MiMo `url_citation` 注解与 `search_results`、DeepSeek `web_search_tool_result` 块），绝不从模型文本里抓 URL；来源数上限（默认 8）由 `dsh-tool-web`/web 接缝截断。
- **错误码**：`WEB_PROVIDER_CREDENTIAL_MISSING`（缺密钥/密钥被拒）、`WEB_PROVIDER_ERROR`（传输/配额/响应不可解析）、`WEB_ABORTED`（取消）；配额与端点类错误附带可操作指引。
- **模型引擎成本控制**：请求固定 `max_keyword: 1`（MiMo 按关键词次数计费）；DeepSeek 引擎沿用 `max_uses`（默认 5，卡片可调），并在发起请求前写入不含凭证的 `web/deepseek-search-llm-request` 会话审计事件。
- **零修改 DSH 本体**：生效完全通过 loader 组合补丁（`patch.yml`：插入本插件行、停用 `web-search-deepseek` 行、把 `web` 行 `searchProvider` 指到本插件）；卸载即完整还原。

## 本地开发

```powershell
cd dsh-web-search
pnpm install
node --test
```

引擎映射、分发和选项归一化保持为纯逻辑；Host 入口显式依赖公开的 `@deepseek-ai/dsh-web`、`@deepseek-ai/dsh-launch-environment` 与 `@deepseek-ai/schemastery` 契约。

```text
dsh-web-search/
├── patch.yml              # loader 组合补丁（insert / disabled / config 覆盖）
├── lib/
│   ├── index.js           # 宿主半边：Config 设置表单 + 注册搜索提供方
│   ├── client.js          # 浏览器半边：plugins.row.config「网页搜索」配置页
│   ├── dispatch.js        # 按设置分发到所选引擎（每次搜索入口快照配置）
│   ├── options.js         # 设置归一化 + 可用性检查
│   ├── http.js            # JSON POST / 取消分类
│   ├── errors.js          # HarnessError 形状的错误工厂
│   └── engines/           # tavily / model-native / deepseek 适配器
└── test/                  # node --test 单测
```
