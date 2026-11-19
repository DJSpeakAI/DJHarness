# dsh-butler-rotate —— 大管家自动换脑

大管家会话（星闪球桥 `E:\DJH\home\orb-bridge.json` 的 `sessionId`）上下文占用到 **40%** 时自动换脑：

1. **压缩老会话**：`ctx.compaction.compactNow()`（dsh-compaction-basic 后端；摘要写回老会话日志，`<compacted-summary>` 检查点）。
2. **新建大管家会话**：`ctx.sessionController.create({ workspaceId, agentPreset: 'butler' })`（butler 预设已物理禁手，没有执行类工具）。
3. **切桥**：写 `orb-bridge.json` 的 `sessionId` + `POST 127.0.0.1:9780/whoami`（桥运行时不热读磁盘，`/whoami` 会同步内存里的 `butlerId`）。
4. **老会话留痕 + 归档**：先 `session.append('assistant/message', …)` 留一条「上下文到 40%，已切到新会话 xxx」，再 `ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })`——只从左栏隐藏，不删日志。
5. **球播报**：`POST 127.0.0.1:9780/event {type:'rotate', text}` → 球页面轮询 `/events` 播报「主人，上下文到 40% 了，我开了个新会话接着聊」。

## 触发与口径

- 占用率与 `dsh-session-ctx-pill` 完全同口径：`ctx.sessionProjections.snapshot(session, ['contextPressure'])`，
  `pct = (projectedTokens ?? pressureTokens) / contextWindow`。
- 触发点：桥目标会话的 `turn/end`（回合结束、agent 空闲）+ 启动 15s 后 + 60s 兜底轮询。
- 防抖：换完 `cooldownMs`（默认 30s）内不再触发；同一会话进程内只换一次。
- agent 忙（有回合在跑）不换，等下一次空闲。

## 配置

`cordis.patch.yml` 里的 `config`（改完要重启）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `threshold` | `0.4` | 触发阈值（0~1） |
| `cooldownMs` | `30000` | 换完后的防抖窗口 |
| `preset` | `butler` | 新会话使用的 agent preset |
| `notify` | `true` | 是否推 rotate 事件给星闪球 |
| `autoRotate` | `true` | 总开关 |

运行时覆盖（**不用重启**，调试/验证用）：`E:\DJH\home\butler-rotate.json`，同字段名，例如：

```json
{ "threshold": 0.001, "testMode": true, "notify": false }
```

`testMode: true` 时客户端插件（页面自动跳新会话 / ⭐ 名单）不动作，避免验证时动主人的页面。

## HTTP（仅本机、需要 DSH 页面令牌）

`POST /butler-rotate-api/state`：`{ butler, threshold, testMode, pressure, lastRotation, events }`
`POST /butler-rotate-api/check`：按阈值检查一次
`POST /butler-rotate-api/rotate-now`：无视阈值强制换一次（验证用）

## 状态/日志

- 最近一次换脑记录：`E:\DJH\home\butler-rotate-state.json`
- 日志：`E:\DJH\bin\butler-rotate.log`

## 联动的两处小改动

- `plugins/dsh-orb-bridge/index.js`：新增内部入口 `POST /event`（只允许本机/无 Origin 调用）把事件推进长轮询队列。
- `E:\apps\djh-cat\index.html`：新增独立游标的通知轮询，只播 `type === 'rotate'` 的事件（与问答轮询的 seq 互不影响）。
