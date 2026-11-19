# dsh-scroll-hide-chrome

手机端「滚动隐藏上下框」+「顶栏浮层」——**纯 Client 半插件**（没有 Host 逻辑）。

## 要解决的事

手机浏览器自己就吃掉顶部（地址栏/状态栏）和底部（手势条）一大块，DSH 的会话页再压上
**顶部导航 76px + 底部输入框 128px**，390×844 的屏幕上真正能看消息的只剩五百多 px。

所以：**往下读 → 上下两条一起收起；往上滑一点 → 立刻弹回来。**
而且顶栏必须是**浮层**：它出现/消失都不许推挤消息内容（2026-11-15 主人第二轮反馈）。

## 行为

| 操作 | 结果 |
|---|---|
| 内容向下滚（累积 ≥26px） | 顶栏浮层滑出屏幕（`translateY(-100%)`+淡出，**不占位**），输入区高度收 0（220ms） |
| 内容向上滚（任意 1px） | 顶栏 + 输入框立刻弹回，**内容一动不动** |
| 已经滚回顶部 6px 内 | 永远显示（第一条消息从顶栏下沿开始，不会被盖） |
| 点/聚焦输入框（要打字） | 强制显示，并锁 1.5s 不收起 |
| 收起态点消息区以外（左栏、右栏、标题栏…） | 弹回 |
| 发消息后自动贴底、打开会话定位到底 | **不**收起（这类程序性滚动没有手指在动） |
| 桌面宽屏（>899px） | 完全不参与：顶栏还在文档流里，视图 tab 行也保留 |

## 实现（真机 DOM，390×844 量出来的）

```
div[class*="_root"]            flex column, overflow hidden, position:relative
  div(display:contents)
    header[class*="_header"]   grid：标题行 30 + 视图 tab 行 25（会话页 76px）
  div[class*="_body"]
    div[class*="_scrollBody"]  ← 唯一滚动容器（overflow:auto）
      ……消息……
      div[class*="_composerSeat"]  position: sticky，贴底
```

### 顶栏：浮层（2026-11-15 改）

JS 精确认会话页那个 header（`scrollBody.closest('div[class*="_root"]').querySelector('header[class*="_header"]')`）
→ 打 `header[data-djh-overlay]` + `root[data-djh-overlay-root]`，CSS：

- `position:absolute; top:0; left:0; right:0; z-index:50`：脱离文档流，盖在消息区上面；
- `min-height:0` + `grid-template-rows:auto`：高度收到单行 41px；
- `background:var(--dsw-alias-bg-base)`：浮层底必须不透明（原来 header 没底色，靠文档流垫着）；
- hidden 态只做 `transform: translateY(-100%) + opacity:0 + pointer-events:none` —— **布局零变化**；
- `div[data-djh-overlay-root] div[class*="_scrollBody"] { padding-top: var(--djh-chrome-h) }`：
  浮层不占位，给滚动内容补一条顶部留白，滚到最顶时第一条消息仍从顶栏下沿开始。

**第 2 行（视图 tab「对话/轨迹」+ 右侧「…」更多按钮）整条删掉**：
`header[data-djh-overlay] div[class*="_tabs"] { display:none }`
（只隐藏 `[data-conversation-tabs]` 不够——外层 grid 行还留 29px + 一条「…」，顶栏卡在 70px）。
顶栏 76 → 41px。**桌面宽屏保留这行**。

### 输入框

`composerSeat` 是 sticky：hidden 时 `height:0`（`--djh-seat-h` 记真实高做过渡）+ padding/margin 归零 +
`overflow:hidden`。只 `translateY` 会留 170px 流占位 → 拉到底一大段空白（主人实锤过）。

### 其它

- 状态胶囊 `[data-status-pills-overlay]`（非会话页的悬浮份）一起淡出，免得压在消息顶上。
- 状态只是一个属性：`<html data-djh-chrome="hidden|shown">`，CSS 全在 `@media (max-width: 899px)` 里。
- 切会话/换视图：`MutationObserver`（300ms 节流）把浮层标记搬到新 header（`ResizeObserver` 只盯旧元素，删了不回调）。

## 几个坑（都踩过）

1. `scroll` 不冒泡，但**捕获阶段能从 document 收到**——所以用 `{capture:true,passive:true}` 委托。
2. 顶栏收起会让布局变化 → scroll anchoring 补偿 `scrollTop` 会被判成「上滑」→ 抖成开关灯。
   **切换后 320ms 静默**，静默期只记 `lastTop` 不判定。
3. 消息区里也有 `div[class*="_header"]`，所以顶栏选择器**必须带 `header` 标签名**。
4. 程序性滚动（发消息贴底、打开会话定位）不算用户意图：只有最近 1.2s 内有 `touchstart/touchmove/wheel`
   才允许收起。
5. **切态后 300ms 内不许量 `composerSeat`**：恢复动画中途量到 8px 会写进 `--djh-seat-h` → 输入框永久卡 8px。
6. 顶栏高度用 `Math.ceil`（留白宁可多 1px，也不能让消息钻到顶栏底下）。
7. z-index 选 50：内容层最高 30、DSH 菜单 1100、状态胶囊面板 10000、左栏抽屉更高——都能压过浮层。
8. **左栏抽屉按钮是「框架层」浮层**（`div[class*="_leadingSeat"]`，`position:absolute; z-index:15`，位置 12,11），
   原来靠 z-index 压在**占位**顶栏上；顶栏变浮层(50)后会把它整块盖住 → 必须
   `div[class*="_leadingSeat"]{z-index:60!important}` 抬到顶栏之上，否则手机上点不到左栏。
9. 安全阀：当前视图不是第一个（例：轨迹）时把 `div[class*="_tabs"]` 放回来 —— 否则手机上回不到「对话」。
10. 插件 HMR 会重跑 `factory`：样式先 `remove()` 再插，监听全在 `ctx.effect` 的清理函数里收。

## 自检口

```js
window.__dshScrollHideChrome.hidden()    // 当前是不是收起态
window.__dshScrollHideChrome.enabled()   // 是不是手机窄屏
window.__dshScrollHideChrome.top()       // scrollBody.scrollTop
window.__dshScrollHideChrome.chrome()    // { overlay, headerH, position, tabsVisible, padTop, rootMarked }
window.__dshScrollHideChrome.force(true) // 手动切（验证样式用）
```

验证套件：`node E:\DJH\tmp\verify-scroll.mjs 9640`（30 项）。
