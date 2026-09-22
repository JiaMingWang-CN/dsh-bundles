# dsh-channel-weixin

通过微信文字消息操作 DSH 的独立原生插件：在 DSH 设置中扫码连接，用微信收发任务，
并可切换会话与工作目录、控制队列、安排定时任务、查询模型与用量。

- **独立安装**：与 `dsh-client-ui-task-notify`、`dsh-client-ui-usage-stats`、
  `dsh-bundle-mcp-toolkit` 完全同构的 bundle（`package.json` + `patch.yml`），
  不修改 DSH 核心，不要求安装其他插件。
- **不依赖 OpenClaw**：不引用 `openclaw/plugin-sdk`，不读取 `~/.openclaw`，
  不启动网关或子进程；协议交互由本插件自身实现。
- **连接由 DSH 服务托管**：仅在 DSH 运行且插件启用时收发消息；浏览器页面关闭不影响连接，
  页面只读取状态，不会创建第二个消息接收循环。

当前状态：**阶段 1–8 的代码与离线验证全部完成**（323 项单元测试 + 隔离 profile 安装/卸载实测）；
**真实扫码与收发联调尚未进行**——阶段 2 起的下列能力已实现但未经真机验证：
真实扫码登录、微信端到端收发、输入状态显示、模型切换生效、用量口径与统计面板一致、
以及"长期无互动后主动推送是否可行"（该能力**不作承诺**，须联调结论）。

已完成：

- 阶段 1：独立的“微信连接”设置入口（id `weixin`、`order: 35`），运行时的安装/卸载与路由验证通过。
- 阶段 2：ilink 协议客户端与登录状态机、凭证私有存储、二维码编码器（自实现，零依赖）、
  登录端点，以及设置页交互——显示二维码、验证码输入、扫码连接 / 取消登录 / 退出登录。
- 阶段 3：会话接入操作层——仅主会话可切换、短 ID 解析与歧义上报、目录必须绝对且存在、
  新建后加载默认标准 Agent 模式并应用完全权限预设、切换复用活动 Agent 或恢复会话、按对端持久化绑定，
  支持 `/agents` 查看及 `/agent <模式ID>` 切换空白会话模式，以及 §7.1 全部命令的解析与执行（失败一律保持原绑定）。
- 阶段 4：消息链路——`getupdates` 长轮询、文本发送与输入状态、uint64 无损解析、入站过滤与去重、
  分段与发送调度、**按 inbox claim 归属回合的任务跟踪**（未认领前不归属任何输出；只累积对外文字；
  工具状态只带工具名）、环路接线（凭证存在即开始接收、`/disconnect` 断开但保留凭证、卸载即停）、
  陈旧凭证停止并上报、失败短/长退避与空闲退避、超时清扫。
- 阶段 5：任务控制与定时——`/stop`（取消当前任务并**暂停队列**，保留待执行项）、
  `/queue`、`/queue remove <任务ID>`、`/queue resume`；`/schedule add|list|remove`
  （显式时间、显示时区与下次触发、**停机错过只标记不补跑**、触发前重新校验绑定/目录/会话）。
- 阶段 6：模型与查询——`/models`、`/model [<ID>]`（按会话切换：持久意图 + 实时覆盖，
  不改全局默认、不打断当前任务）、`/usage`（读 token-meter 投影四桶，输出已含推理不重复加计；
  跨会话汇总明确标注不可用）、`/search <关键词>`（经会话检索服务，仅对外文字、带分页游标）。
- 阶段 7：异常与生命周期——退避（短/长/空闲）、陈旧凭证停止并上报、停止清理、卸载即停；
  **崩溃窗口幂等**：提交前落盘 in-flight 标记、接纳后清除，重启只报告"未确认"**绝不自动重跑**；
  回复投递失败在投递完成后记录并跨重启保留；游标/去重/in-flight/回复状态同写一个原子文档。
- 阶段 8：双平台静态核查（宿主平台路径规则、CJK/空格目录、导入大小写、无平台特定分支）、
  `LICENSE` 与 `NOTICE.md`、安装/更新/卸载/验证/故障排查说明。

待做：真实微信账号的扫码与收发联调（需联网，待批准）；Linux 实机验证。

## 安全与依赖约束

- **只用 Node 内置模块**：第三方 bundle 从插件目录无法解析 DSH 内部依赖（如 `zod`），
  因此存储、HTTP、加密均由内置模块与本插件自有代码实现。
- 变更类端点（登录/退出）要求同源页面请求并携带插件自有请求头，拒绝外部 Origin；
  这是必需的补偿控制，因为 DSH 不校验插件自有路由（阶段 0 报告 §5.2，已运行时实证）。
- 页面的状态响应是**字段白名单**：账号脱敏、错误限长；二维码轮询密钥（`qrcode`）、
  验证码与 `bot_token` 永不进入该响应。二维码可扫描内容只经 `/login/qr` 在登录进行中提供。
- 凭证落盘于 `$DSH_HOME/storages/channel-weixin/account.json`（0o600/0o700，原子替换）；
  Linux 权限由插件自身保证，Windows 上应由 ACL 保护。

## 安装

```bash
# 从 GitHub（发布后）
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-channel-weixin"

# 本地开发目录（link: 方式，改动即时生效）
dsh plugin --profile web add -w C:\Programs\dsh-bundles\dsh-channel-weixin
```

安装后重启或在设置页重载，即可在“设置 → 微信连接”看到入口；
入口顺序值 `order: 35`，正常位于“用量统计”（30）之后，但不依赖该插件存在。

## 更新

```bash
# GitHub 安装的包
dsh plugin --profile web update dsh-channel-weixin

# 本地 link: 安装的包：源码改动即时生效，只需重载 profile
dsh plugin --profile web add -w C:\Programs\dsh-bundles\dsh-channel-weixin
```

更新后请确认设置页仍显示“微信连接”，并检查“最近错误”一栏是否为空。

## 卸载

```bash
dsh plugin --profile web remove -w dsh-channel-weixin
```

插件把路由与样式都注册为可撤销的 Cordis effect，卸载后不残留路由、订阅、定时器或轮询。
**卸载不会删除已保存的凭证与状态**（`$DSH_HOME/storages/channel-weixin/`）：
如需彻底清除，请在卸载前先用设置页的“退出登录”，或手动删除该目录。

## 验证安装是否生效

```bash
# 组合层应出现本插件的独立层与插件行
dsh --profile web --dump-config | findstr /C:"dsh-channel-weixin" /C:"channel-weixin"

# 运行中：状态路由应返回 JSON（未登录时为 phase=stopped）
curl http://127.0.0.1:3080/plugins/channel-weixin/status
```

端口以实际 Web UI 为准；该路由只返回非敏感状态，任何本地进程都可读取（见“安全边界”）。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 设置页没有“微信连接” | 确认 `--dump-config` 中有本插件层；重启或重载 profile |
| 一直“等待扫码” | 二维码 5 分钟过期会自动刷新（上限 3 次）；超限后重新点“扫码连接” |
| 提示凭证已失效 | 微信侧登录已失效，点“扫码连接”重新扫码；插件不会对失效凭证高速重试 |
| 收不到微信消息 | 确认 DSH 服务在运行、插件已启用、页面显示“已连接”；查看“最近错误” |
| 回复发送失败 | 多为 `context_token` 失效（长时间未互动）；重新在微信发一条消息再试 |
| 模型/用量/搜索不可用 | 对应宿主服务未组合；命令回复中会说明具体原因 |
| 想彻底清除数据 | 先“退出登录”，再删除 `$DSH_HOME/storages/channel-weixin/` |

## 平台与依赖

零第三方运行依赖，仅用 Node 内置模块；支持 Windows 与 Linux。
宿主服务缺失时按能力降级而不是拒绝加载——完整矩阵见 `NOTICE.md`。

## 目录结构

```text
dsh-channel-weixin/
├── package.json     # bundle 声明：host/client 导出、web 客户端、patch
├── patch.yml        # 无位置锚点地插入插件行
├── lib/index.js     # host 半边：连接状态、路由与登录端点、轮询生命周期
├── lib/weixin.js    # ilink 协议客户端与登录状态机（fetch/时钟可注入，可离线测试）
├── lib/storage.js   # 凭证与绑定的私有存储（原子替换、0o600/0o700）
├── lib/qr.js        # 二维码编码器（byte 模式、版本 1–10、RS 纠错、SVG 渲染）
├── lib/sessions.js  # 会话列举/新建/切换、目录校验、完全权限映射
├── lib/commands.js  # 入站文本分类与 §7.1 命令解析
├── lib/dispatch.js  # 命令执行与回复文案（失败保持原绑定）
├── lib/inbound.js   # 入站消息过滤与去重窗口
├── lib/reply.js     # 分段与发送调度（正文优先、状态可丢弃）
├── lib/task.js      # 任务归属与输出累积（按 inbox claim 认领回合）
├── lib/queue.js     # 任务控制：停止、队列查看/删除/继续
├── lib/schedule.js  # 定时任务：显式时间解析、到期判定、错过标记
├── lib/model.js     # 按会话模型切换（持久意图 + 实时覆盖）
├── lib/usage.js     # 会话用量投影读取与关键词历史检索
├── lib/channel.js   # 消息环路：收信 → 命令/任务 → 提交 → 回复
├── lib/client.js    # 设置中的“微信连接”页面（二维码、验证码、连接管理）
└── test/            # node --test 单元测试
```

## 测试

```bash
cd dsh-channel-weixin
npm test
```

## 安全边界

- 页面的状态路由只返回**字段白名单**投影：账号脱敏、错误文本限长，
  凭证、二维码轮询密钥、验证码与 `context_token` 不进该响应（单元测试固定这一约束）。
- 变更类端点要求同源页面请求 + 插件自有请求头，并拒绝非回环 Origin；
  该路由不受 DSH 管理界面 Cookie 鉴权保护，因此只暴露非敏感状态，
  且不把服务绑定改为 `0.0.0.0`。
- 微信任务使用 DSH 完全权限、不逐项审批，仅限已扫码绑定的本人私聊。

## 许可

本项目为 MIT（见 `LICENSE`）。协议事实参考 `@tencent-weixin/openclaw-weixin` v2.4.9
（MIT，`Copyright (C) 2026 Tencent`），但**未复制其源代码**；本插件不依赖、不启动 OpenClaw。
第三方声明、平台差异与服务依赖矩阵见 `NOTICE.md`。

MIT 只解决代码版权；使用微信服务与由此产生的账号风险由使用者自行承担。
