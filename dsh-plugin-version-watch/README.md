# dsh-plugin-version-watch

[English](#english) · 中文

在 DSH 设置的“插件更新”页监控已安装插件的版本，并一键更新；更新通过 HMR 热重载生效，通常不需要重启。

## 它做什么

- **列出版本**：设置页按 profile 的依赖列出所有已安装插件，显示当前版本、来源和启用状态。
- **检查更新**：
  - **Git 来源**（`github:owner/repo#path:...`、Git URL）：从 `pnpm-lock.yaml` 读出已安装的精确提交，用 `git ls-remote` 取远端分支/标签的最新提交；能读到时再通过 GitHub 原始文件接口读出该提交下该子目录的 `package.json` 版本号。
  - **npm 注册表来源**：调用 DSH 插件管理器自带的版本列表，取最新的、声明为 bundle、未弃用且兼容当前 DSH 的版本。
  - 本地目录、压缩包、版本范围安装等来源显示为“不支持自动更新”，不会误操作。
- **一键更新**：
  - Git 来源：按 profile 记录的原始 spec 先 `removeBundle` 再 `installBundle`，pnpm 会重新解析远端最新提交；插件管理器的 HMR 重组让新代码直接生效。
  - 注册表来源：调用 `updateBundle`，复用官方的版本校验、失败回滚流程。
  - 结果会明确显示“已实时生效，无需重启”或“需要重启（原因）”。Git 重装失败时旧版本已卸载，界面会提示到 Plugins 页面重新安装。
- **监控**：打开页面时自动检查一次，并每 15 分钟复查；顶部提供“全部重新检查”。

## 安装

在插件管理中安装本目录（绝对路径），或用：

```sh
dsh plugin --profile <profile> add /path/to/dsh-plugin-version-watch
```

安装后在 **设置 → 插件更新** 打开页面。

## 实现

| 半边 | 文件 | 作用 |
| --- | --- | --- |
| Host | `lib/index.js` | 注册两条经连接层认证的路由：`GET /api/version-watch/status` 与 `POST /api/version-watch/update`；读 profile 清单与锁文件，执行检查与更新。 |
| Host | `lib/spec.js` | 解析已保存的依赖 spec（GitHub 简写、Git URL、注册表、本地、压缩包），构造 GitHub 原始文件 URL。 |
| Host | `lib/lockfile.js` | 只读 `pnpm-lock.yaml` 的根 importer 依赖及其解析版本，取出已安装的 Git 提交。 |
| Client | `lib/client.js` | 在 `settings.section` 注册“插件更新”页与导航图标，负责检查、更新按钮、结果提示和自动复查。 |

所有写操作都经由 DSH 的 `pluginManager` 服务，不直接改 profile 文件；因此删除/安装/启用的规则、版本兼容检查与失败恢复都与插件管理器保持一致。

## 限制

- Git 来源的“最新版本”比较的是提交；即使子目录 `package.json` 版本号没变，只要远端有新提交就会显示“有新提交”。重新安装后若代码实际未变，属于无害的空更新。
- 私有仓库依赖本机 Git 凭据；检查使用 `git ls-remote` 且关闭终端提示与凭据助手，读不到时显示“检查失败/无法连接远端”。
- 更新 Git 插件会让它移动到 bundle 选择列表末尾（插件管理器的既有行为），可能改变配置层的优先级。
- 仅支持有 bundle patch 的插件；普通依赖不会出现在列表中。
