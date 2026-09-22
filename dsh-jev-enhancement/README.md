# dsh-jev-enhancement

面向 DeepSeek Harness（dsh）web profile 的 **Jev 增强层** bundle：按
`provider/model` 精确启用的两件互不依赖的能力，由 TypeSafe 的 System One 模型 Jev
提供结构化判断，本地规则负责一切放行与回退。

- **Context Compaction（原文筛选）**：Jev 判断哪些较早内容已陈旧/被替代/不再需要，
  本地规则决定删除资格；只做原文筛选，不生成摘要、不改写保留内容，原文永远留在会话
  日志中，可一键恢复。
- **Decision Assistance（结构化决策）**：故障分类、路线选择、风险判断三个决策节点。
  建议只能在白名单与门槛内被采纳，只能收紧（`allow → ask`），永远不能放松权限或审批。

默认**全局关闭**；关闭或未选择模型时 DSH 完全走原生流程——不读密钥、不序列化上下文、
不发起任何网络请求。

## 目录

- [安装](#安装)
- [配置](#配置)
- [使用方式](#使用方式)
- [状态与诊断接口](#状态与诊断接口)
- [更新、禁用与卸载](#更新禁用与卸载)
- [本地开发](#本地开发)
- [常见问题（故障排查）](#常见问题故障排查)

## 安装

与其他 bundle 一致：把本目录安装为 dsh web profile 的插件 bundle 即可
（`dsh` 读取 `package.json` 的 `dsh.bundle.patch`，套用 `patch.yml`）。
`patch.yml` 只做一件事——把本插件插入 composition 首位，使其上下文筛选先于原生压缩的
压力检查运行。**不修改 DSH 本体**，原生压缩、重试、审批全部保留为回退路径。

依赖：`@deepseek-ai/schemastery`（随包安装）。开发/测试需要 `pnpm install`。

## 配置

设置侧边栏 → **Jev 增强**（`settings.section`）。页面与运行时使用同一配置源与同一套
校验规则（`lib/rules.js`，由 `test/rules-parity.test.js` 保证两份拷贝一致）。

### 配置 Schema

| 层级 | 字段 | 默认 | 语义 |
| --- | --- | --- | --- |
| 全局 | `enabled` | `false` | 总开关（优先于一切模型配置） |
| 全局 | `credentialRef` | `TYPESAFE_API_KEY` | 凭据引用：宿主凭据域或环境变量名，**不存明文密钥** |
| 全局 | `jevModel` | `jev-latest` | Jev 模型（与被增强的 DSH 模型无关）；灰度建议固定 `jev-1.13.0` |
| 全局 | `timeoutMs` | `10000` | 单次 Jev 调用等待上限 |
| 全局 | `callBudgetPerStep` | `1` | 每步骤 Jev 调用预算 |
| 全局 | `callBudgetPerTask` | `20` | 每任务 Jev 调用预算 |
| 模型 | `providerId` + `modelId` | 来自模型目录 | 精确模型选择键（不支持模糊名称；同名不同 Provider 互不污染）；列表自动取自 DSH 已配置模型（`remote.session.modelCatalog()`），不支持手动添加 |
| 模型 | `enabled` | `false` | 该模型是否允许增强（未配置的模型一律原生） |
| 压缩 | `enabled` | `false` | Context Compaction 独立开关 |
| 压缩 | `mode` | `observe` | `observe` 只记录建议不改上下文；`active` 真实筛选 |
| 压缩 | `triggerRatio` | `0.7` | 输入预算占用达到该比例时尝试筛选 |
| 压缩 | `targetRatio` | `0.5` | 筛选后期望占用，**必须小于** `triggerRatio` |
| 压缩 | `keepRecentMessages` | `6` | 最近至少保留的消息数（下限，按原子单元向前扩整） |
| 压缩 | `maxRemovalRatio` | `0.5` | 单次最多移除的表面 token 比例 |
| 压缩 | `minIntervalSteps` | `4` | 两次筛选之间的最小步骤间隔 |
| 压缩 | `removalAcceptance.choice` | `0.8` | 删除判断（Choice）置信度门槛 |
| 压缩 | `removalAcceptance.noul` | `0.8` | 删除安全判断（Noul）门槛 |
| 决策 | `enabled` | `false` | Decision Assistance 独立开关 |
| 决策 | `nodes` | `[]` | 允许介入的节点白名单：`fault-classification` / `route-selection` / `risk-judgment` |
| 决策 | `acceptanceByNode.faultClassification.minConfidence` | `0.75` | 故障分类采纳门槛 |
| 决策 | `acceptanceByNode.faultClassification.maxExtraRetries` | `1` | 额外重试上限（不改变既有重试次数与幂等限制） |
| 决策 | `acceptanceByNode.routeSelection.minConfidence` | `0.7` | 路线选择采纳门槛 |
| 决策 | `acceptanceByNode.routeSelection.candidates` | `[]` | 候选路线白名单 `[{provider, model}]`，仅限 DSH 已注册适配器的 provider |
| 决策 | `acceptanceByNode.riskJudgment.minNoul` | `0.7` | 风险维度（Noul）判定门槛 |

### 按模型示例

以 `deepseek/deepseek-chat` 开启筛选（先观察一个周期再改 `active`），以
`openai/gpt-5` 只开决策：

```jsonc
{
  "enabled": true,
  "credentialRef": "TYPESAFE_API_KEY",
  "jevModel": "jev-1.13.0",
  "timeoutMs": 10000,
  "callBudgetPerStep": 1,
  "callBudgetPerTask": 20,
  "models": [
    {
      "providerId": "deepseek",
      "modelId": "deepseek-chat",
      "enabled": true,
      "compaction": {
        "enabled": true,
        "mode": "observe",          // 观察一周后改为 "active"
        "triggerRatio": 0.7,
        "targetRatio": 0.5,
        "keepRecentMessages": 8,
        "maxRemovalRatio": 0.5,
        "minIntervalSteps": 4,
        "removalAcceptance": { "choice": 0.8, "noul": 0.8 }
      },
      "decision": { "enabled": false, "nodes": [] }
    },
    {
      "providerId": "openai",
      "modelId": "gpt-5",
      "enabled": true,
      "compaction": { "enabled": false },
      "decision": {
        "enabled": true,
        "nodes": ["fault-classification", "risk-judgment"],
        "acceptanceByNode": {
          "faultClassification": { "minConfidence": 0.8, "maxExtraRetries": 1 },
          "riskJudgment": { "minNoul": 0.7 }
        }
      }
    }
  ]
}
```

约束与基线：`targetRatio < triggerRatio`；预算分母是模型实际可用输入预算
（`contextWindow` − 输出预留 − 协议开销）；拿不到可靠 token 预算时跳过自动筛选；
证据不完整（候选原文放不进 Jev 状态）时保留内容；配置错误只隔离到相关模型/功能并在
状态区报告，不阻止 DSH 启动。

## 使用方式

1. 在设置页填入凭据引用，点击**测试连接**（用户显式触发的一次最小 Jev 调用）。
2. 打开总开关，在模型列表里启用要增强的模型（列表自动读取 DSH 已配置模型，按 Provider 分组；不支持手动添加）。
3. 按需打开 Context Compaction（建议先 `observe`）与 Decision Assistance 节点。

模型列表说明：模型目录由宿主提供（Provider 分组 + 模型名/ID），逐行开关是否启用增强；
已保存但当前未检测到的模型单独归入「已保存但当前未检测到」组，可保留或删除。

4. 保存。保存失败不会显示为已生效；刷新或重开设置后配置正确恢复。

运行期行为：

- 压缩在步骤边界检查阈值/间隔/预算后才可能调用 Jev；成功后以
  `compaction/prune` + 表面替换提交，原文保留在日志中。
- 决策节点一律先取原生决策再增强：故障分类只在原生判定终止时于策略预算内补一次有界
  重试；路线选择只替换到白名单内的 provider/model（并按新模型重新门控）；风险判断只把
  `allow` 升级为 `ask`。
- 连续 3 次 Jev 调用失败熔断 5 分钟，期间全部走原生路径。

## 状态与诊断接口

同源页面读取（控制类带 `x-jev-enhancement: 1` 头 + 环回 Origin 校验）：

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/plugins/jev-enhancement/status` | GET | 白名单化状态：开关、模型策略摘要、配置校验、不可用原因、熔断、脱敏计数 |
| `/plugins/jev-enhancement/test` | POST | 一次最小连通性调用（消耗 1 次 Jev 请求） |
| `/plugins/jev-enhancement/restore` | POST | `{ "sessionId": "..." }`：撤销该会话的筛选，按原文恢复 |
| `/plugins/jev-enhancement/log` | GET | 导出专属 Jev 审计日志为单个 JSONL 文件（同源 + 自定义头 guard） |

### 专属日志（jev-audit.jsonl）

每次 Jev 活动都会向插件私有存储追加一行 JSONL 记录：调用计数/时延、Jev token 成本、
压缩建议/提交/撤销、决策结果（节点、建议值、是否采纳、来源）、回退原因、熔断状态，
并带目标模型（`target`）标识。记账口径（避免空跑和刷屏）：

- **只记真实判断**：决策记录只在真的问过 Jev（`source:"jev"`）或确定性规则判定（`source:"rule"`）
  时产生；门控通过但无需判断的空跑只计入计数器 `routeSkips`，不写判断记录；
- **预算耗尽按“状态”记**：每个回退原因每次耗尽只写一条 fallback 记录，后续尝试只累加
  `budgetFallbacks` 计数，下一次成功调用后重新记录。

落盘规则：

- 位置：`~/.dsh/storages/jev-enhancement/jev-audit.jsonl`（跟随 `DSH_HOME`），文件 0600、目录 0700；
- 超过 1MB 轮转为 `jev-audit.jsonl.1`（保留一份），导出时两份拼接不丢历史；
- **只记元数据**（审计入口字段白名单，多余字段直接丢弃）：不记对话原文、state、工具输出、密钥；
- 设置页「状态反馈」卡片点「**导出日志**」即可下载为一份 `.jsonl` 文件；
- 日志写入失败（磁盘/权限）静默降级为“无日志”，不影响任何请求路径。

## 更新、禁用与卸载

- **更新**：替换 bundle 目录后重装；配置保存在 DSH 设置文档中，跨版本保留。
- **一键关闭**：设置页关掉总开关（或模型开关）。下一次请求即从原始会话材料重建：
  已筛选的会话会自动把原文恢复回上下文，由原生构建器处理。
- **卸载**：移除 bundle 即恢复 DSH 出厂行为（`patch.yml` 为声明式加载器补丁）。
  卸载后已提交的筛选不会自动恢复（插件已不在场）；如需恢复，请在卸载前执行
  `restore` 或关闭增强等待一次请求完成重建。

## 本地开发

```bash
pnpm install        # 安装 schemastery 与 launch-environment
node --test         # 全部单元测试（纯 mock，无真实 API 请求）
node scripts/sync-rules.mjs   # 修改 lib/rules.js 后，把共享规则块同步进 lib/client.js
```

布局：`lib/rules.js`（共享配置规则，页面与运行时同一份）· `lib/typesafe.js`（唯一外发
边界）· `lib/units.js`（原子单元与硬保护）· `lib/compaction.js`（规划/提交/恢复）·
`lib/decision.js`（三个决策节点）· `lib/budget.js`（预算与熔断）· `lib/audit.js`（脱敏
观测）· `lib/index.js`（宿主接线）· `lib/client.js`（设置页，内嵌同一份规则块）。

## 常见问题（故障排查）

| 现象 | 原因与处理 |
| --- | --- |
| 设置页显示"未配置密钥" | 检查 `credentialRef` 指向的凭据域条目或环境变量；密钥不写入 `settings.yaml` |
| "连接失败：auth" | API Key 无效（HTTP 401）。修正密钥后重新测试；auth 失败会停用增强直到配置变化 |
| "连接失败：contract" | 请求契约被服务端拒绝（HTTP 422）。按契约记录核对 `jevModel`；插件不会猜测字段重试 |
| 一切增强不生效 | 依次检查：总开关 → 模型 `providerId/modelId` 是否精确匹配当前路由 → 功能/节点开关 → 状态区的配置校验错误 |
| 某模型配置报错但 DSH 正常 | 配置错误按模型隔离：该模型回原生，其他模型不受影响；按状态区提示修正 |
| 压缩"总是放弃" | 观察日志中的原因：`no-candidates`（都在保护集合）、`insufficient-gain`（收益不足）、`stale-result`（并发变更丢弃）、`evidence-budget`（证据放不下） |
| 出现"熔断中" | 连续 Jev 失败触发冷却。冷却结束后自动恢复；期间原生流程不受影响 |
| 想审计 Jev 都干了什么 | 设置页点「导出日志」，或直接看 `~/.dsh/storages/jev-enhancement/jev-audit.jsonl`（只有元数据） |
| 关闭后上下文变大 | 正常：筛选被撤销、原文按字节恢复，随后由原生压缩按其策略处理 |
| 想撤销已发生的筛选 | 设置页"一键恢复当前会话"，或关闭增强并发送任意一次请求 |
