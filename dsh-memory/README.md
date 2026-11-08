# dsh-memory

**中文** · 跨会话记忆插件：让 DSH 的 agent 记住犯过的错、做成功的路子和验证过的规则，并在会话结束后自动 **dreaming**——对照会话记录纠错、合并、精简记忆。不修改 DSH 源码，卸载即恢复内置行为（记忆文件保留在原处）。

思路来自 Anthropic Engineering《The components of agent memory》：当下用会话记录忠实留痕，用克制的笔记捕捉环境给不了的判断，事后再以原始记录为依据离线整理。

## 它做什么

| 部分 | 行为 |
| --- | --- |
| 记忆笔记 | agent 用 `memory_list` / `memory_read` / `memory_write` / `memory_delete` 读写记忆；分**项目级**（当前工作目录）和**用户级**（跨项目）两个分区 |
| 索引注入 | 每个会话开始时注入两个分区的 `INDEX.md`（各限 4 KB），正文按需读取；会话内的改动下个会话生效 |
| dreaming | 会话最后一轮结束后空闲 10 分钟，或会话关闭时，在后台起一个隐藏的整理 agent：只给它记忆工具和本项目的会话记录，按"纠错 → 合并 → 索引瘦身 → 修悬空链接 → 补漏记的教训"的顺序整理 |
| 设置页 | 设置侧栏「记忆」：总开关、自动 dreaming、空闲阈值、dreaming 模型、最近运行日志、待处理数、「立即 dream」 |
| `/dream` | 立即整理当前项目的记忆，完成后返回摘要 |

记忆存放在 `<DSH home>/memory/`（默认 `~/.dsh/memory/`）：

```
memory/
  user/                 跨项目：偏好、通用教训
  projects/<项目>/      本项目的规则、陷阱、做法
  .state/               插件状态：dreaming 队列与日志
```

都是普通 Markdown，可以直接查看、编辑或删除。

## 安装

```powershell
# 从 GitHub
dsh plugin --profile web add -w "github:JiaMingWang-CN/dsh-bundles#path:dsh-memory"

# 本地目录
dsh plugin --profile web add -w C:\path\to\dsh-bundles\dsh-memory
```

## 费用与失败

- dreaming 会调用模型、消耗你自己的 token。默认用 DSH 的默认模型，可在设置页指定 provider 与模型 id；不想自动运行就关掉「自动 dreaming」，改用 `/dream` 手动触发。
- 所有 dreaming 全局串行，同一时刻只跑一个。
- 任何一次 dreaming 失败（例如 key 失效）都会**暂停自动 dreaming**，设置页显示原因；暂停期间结束的会话只排队、不调用模型。修好模型后点「立即 dream」或运行 `/dream`，成功后按结束顺序补完队列并恢复自动。
- 退出应用时正在排队或运行的会话会留在队列里，下次再处理，不会触发暂停。

## 已知限制

- 只适配 DSH **0.2.2-rc.1**：依赖的会话、agent、提示词接口仍是 rc 版本，升级 DSH 后需要重新验证。
- dreaming 使用的隐藏会话保存在 `~/.dsh/sessions/_no-cwd/`，插件只保留最近 50 个，更早的由插件自行删除；它们不会出现在会话列表和搜索里。
- dreaming 会话也会触发 DSH 的标题生成，带来少量额外 token。

## 开发

```powershell
cd dsh-memory
pnpm install
pnpm test
```
