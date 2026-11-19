# dsh-swipe-sidebar

手机端左栏滑动手势（纯 Client 半插件）。参数与机制**整体照抄 little DJ**（`ui/index.html` 的
task174–177：`edgeSwipeJudge` / `sideCloseJudge` / 返回哨兵），因为那套是在主人同一台手机上实测出来的。

## 行为

窄屏（<768px，`[data-sidebar-drawer]` 抽屉模式）：

| 手势 | 结果 |
|---|---|
| 从屏幕左边缘 **12–64px** 处起手向右滑 ≥40px（且横向 > 纵向×1.6） | 左栏弹出 |
| 左栏开着时向左滑 ≥46px（同样横向主导） | 收起 |
| 从最物理边缘（≤12px）右滑 | 系统把它翻成 `history.back()`，哨兵把这次「返回」翻译成「开左栏」 |
| 连滑两下返回手势（<450ms） | 逃生门：放行真返回，并开 5 秒粘性窗（5 秒内返回都是真返回） |
| 顶部按钮带（y < 44）、交互元素/输入框/代码块起手 | 不抢手势 |
| 桌面宽屏（≥768px） | 完全无效，连哨兵都不垫 |

## 为什么要返回哨兵

little DJ 里的原话：「鸿蒙/移动浏览器把『左缘右滑』抢成 history.back()（主人 2026-11-10 实测：
滑动=返回上一页），页面 touch 事件收不到、preventDefault 无效」。

所以最左边那 12px 拿不到触摸事件，只能：① 热区右移到 12–64px 吃触摸；② 在历史栈垫一条同文档
哨兵，`popstate` 时把返回翻译成开左栏（开左栏时返回=收左栏），快速二次返回才放行真退出。

## 参数（`client.js` 顶部常量）

`HOT_MIN_X=12` `HOT_MAX_X=64` `HOT_MIN_Y=44` `OPEN_DX=40` `OPEN_RATIO=1.6`
`CLOSE_DX=46` `CLOSE_RATIO=1.6` `ABORT_DX=-12` `ABORT_DY=26` `ESCAPE_MS=450` `ESCAPE_STICKY_MS=5000`

自检口：`window.__dshSwipeSidebar.mode()` / `.open()` / `.sentinel()`。

## 挂载

按 `dsh-attach-tiles` 的老办法（热生效，不用重启）：

1. profile `package.json` dependencies 加 `"@local/dsh-swipe-sidebar": "link:E:/DJH/workspaces/default-workspace/plugins/dsh-swipe-sidebar"`；
2. `E:\DJH\home\profiles\web\node_modules\@local\dsh-swipe-sidebar` 建 Junction 指到本目录；
3. profile `cordis.patch.yml` 末尾 `- insert: - id: swipe-sidebar  name: '@local/dsh-swipe-sidebar'`。

**不要**再加进 `dsh.profile.bundles`，否则会双重装载。

## 不想要返回哨兵

删掉 `apply()` 里的 `window.addEventListener('popstate', onPopState)` 与 `armSentinel()` 调用即可，
只剩 12–64px 触摸热区（最边缘 12px 的手势会重新变成浏览器返回）。
