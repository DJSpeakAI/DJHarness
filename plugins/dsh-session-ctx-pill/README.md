# @local/dsh-session-ctx-pill — 左栏会话行上下文百分比

移植自 little DJ 的 **task189「会话行上下文百分比 pill」**：左侧会话列表每一行
后面挂一颗小胶囊，显示这条会话「下一次请求会喂给模型多少上下文」。

```
默认工作区
● 在对话中加上上下文百分比      15%   4分钟
● 小 DJ 输入框添加 Token 按钮    6%   待回答
```

## 为什么有用

上下文一到 80%（`compaction-basic` 的 `DEFAULT_THRESHOLD_RATIO = .8`）DSH 就会
自动压缩。主人 20% 就新开会话，所以真正需要的是「这条聊到哪儿了、还剩多少」——
一眼扫完，不用点进去看输入框下面那圈上下文环。

## 口径（不自己算 token，全用官方投影）

| 项 | 来源 |
| --- | --- |
| 分子 used | `contextPressure.projectedTokens ?? pressureTokens` —— 最近一次请求实际读入的 prompt tokens（含缓存命中）+ 此后对话增量 |
| 分母 win | `contextPressure.contextWindow` —— 该会话模型自报窗口（DeepSeek/GPT 系 1M） |
| 百分比 | `min(100, used / win * 100)` |

数据源分两条路（和官方会话列表行一致）：

- **活着的会话** → `sessionProjections.snapshot(session, ['contextPressure'])`（实时）
- **已落盘的会话** → `sessionProjectionCache.cachedSnapshot(header, ['contextPressure'])`
  —— 官方列表现的同一个**零 I/O** 读口，值可能落后一个 checkpoint，但不会错

缺源（还没有过 `request/context`、没跑过一轮、或 cache 行版本过期）的会话**不出胶囊**：
缺源不编数，和小 DJ 一致。

## 配色

| 档 | 阈值 | 颜色 |
| --- | --- | --- |
| ok | ≤ 50% | 三级灰（`--dsw-alias-label-tertiary`） |
| warn | 50–80% | 琥珀 `#d8a13a` |
| danger | > 80% | 红 `#e0533d`（= 自动压缩线） |

## 结构

- `index.js`（Host）：`POST /session-ctx-api/state` → `{ at, map: { [sessionId]: {pct,used,win} } }`；
  `sessionPersistence.list()` 结果缓存 10s，其余全是内存读。
- `client.js`（Client）：注册 `sidebar.session.row.trailing`（`inline: true`，时间标签之后）；
  共享 store 20s 轮询 + 页面重新可见时补一次，N 行只发一份请求。

## 维护

- 改完 `index.js`：需要重载宿主插件（插件页关一次再开，或重启 DSH）。
- 改完 `client.js`：宿主 HMR 自动推新版本，刷新页面即生效。
- 撤回：插件页关掉「会话行上下文百分比」，或把 profile `package.json` 里这条
  bundle 删掉。

## 验证（CDP，一次性脚本在 tmp）

```powershell
# 1) host 接口有没有数
node E:\DJH\bin\ui-assert.mjs --eval-file E:\DJH\tmp\eval-ctx.mjs --wait-ms 6000
# 2) 页面里胶囊有没有渲染、tooltip 对不对
node E:\DJH\bin\ui-assert.mjs --eval-file E:\DJH\tmp\eval-ctx-pills.mjs --wait-ms 5000
```
