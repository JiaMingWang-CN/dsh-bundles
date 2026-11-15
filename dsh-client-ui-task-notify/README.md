# @wjm200509/dsh-client-ui-task-notify

**中文** · 任务完成通知插件：主会话从运行中变为完成、且当前页面不在前台时，发送一条系统通知。不修改 DSH 源码，卸载即恢复。

## 功能

- 只在主会话完成时通知，子 Agent 完成不通知；
- 五种提示音：系统默认、叮、叮咚、上升、静音；
- 提示音由 Web Audio 生成，音量跟随系统；
- 开关与提示音写入 DSH 的持久化设置，重启后保留。

## 安装

```powershell
dsh plugin --profile web add -w "@wjm200509/dsh-client-ui-task-notify"
```

安装后重启 DSH。用本地目录时把 `-w` 换成目录的绝对路径。

## 使用

1. 打开 DSH 设置，进入 **任务通知**；
2. 开启通知并选择提示音；
3. 浏览器首次请求系统通知权限时选择允许。

页面聚焦时不会通知；只有主会话由运行中转为完成、且页面未聚焦才发送。

## 兼容

适配 DSH **0.2.2-rc.1**；`engines.dsh` 同时保留 `0.1.7-rc.2`、`0.2.0-rc.2`、`0.2.1-alpha.x` 的范围。

## 开发

```powershell
cd dsh-client-ui-task-notify
npm test
```

目录：

```text
lib/index.js    Host 半边：持久化设置命名空间
lib/client.js   浏览器半边：设置页、菜单项、通知与提示音
patch.yml       loader 组合补丁（插入本插件行）
```
