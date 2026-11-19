/**
 * 手机端「滚动隐藏上下框」（纯 Client 半插件，无 Host 逻辑）。
 *
 * 需求（主人原话，2026-11-15）：
 *   ①「手机屏幕上往下滑动 → 上面的导航和下面的输入框都隐藏；往上滑动一点 →
 *      上面的导航和下面的输入框都弹出来。」
 *
 *   ② 同日第二轮（DJ 截图 `screenshot_20261115_191425`，红圈圈住「对话 轨迹」那行）：
 *      - 「上面有两行，把第 2 行删掉」→ 视图 tab 行（对话/轨迹，含右边「…」更多按钮）
 *        手机上整条删掉，不要。
 *      - 「第 1 行可以留，但它跟页面在同一个平面上，往上滑它出现时会把页面往下顶，
 *        非常不爽 —— 我要把它压在我的对话框上面」→ 顶栏从「占位 + 收高度」改成
 *        **浮层**：脱离文档流盖在消息区上，出现/消失都不再推挤页面。
 *
 * 落地做法（按真机 DOM 量过，390×844 视口）：
 *   DSH 会话页布局是
 *     div[class*="_root"]         （flex column，overflow hidden，position:relative）
 *       header[class*="_header"]  （grid：标题行 + 视图 tab 行；会话页 76px）
 *       div[class*="_body"]
 *         div[class*="_scrollBody"]  ← 唯一滚动容器（overflow:auto）
 *           ……消息……
 *           div[class*="_composerSeat"] （position: sticky，贴 scrollBody 底部）
 *
 *   所以：
 *     ① 顶栏：JS 精确认「会话页 header」（root 里那个 header 标签），打标
 *        `data-djh-overlay` → CSS 改成 `position:absolute` 浮在消息区上面，高度
 *        自然收缩（tab 行删掉后 41px）。收起态用 `translateY(-100%) + opacity`
 *        滑出屏幕，**不碰文档流** → 内容永远不动，不会被顶。
 *     ② 浮层不占位，滚动内容顶部会钻到顶栏下面 → 给 scrollBody 补一条
 *        `padding-top: var(--djh-chrome-h)`（顶栏真实高度），滚到最顶时第一条消息
 *        仍从顶栏下沿开始；滚下去之后 padding 已在文档顶部之外，不浪费空间。
 *     ③ 视图 tab 行：`header[data-djh-overlay] div[class*="_tabs"]` 整条 display:none
 *        （`[data-conversation-tabs]` 只是里面的 tablist，外层「…」更多按钮藏在同一层，
 *        必须连外层一起删）。只在手机窄屏生效，桌面保留。
 *     ④ 输入框：composerSeat 是 sticky，translateY 不参与布局；但只滑走会留 170px
 *        流占位（拉到底一大段空白），所以 hidden 时 height 也收 0（--djh-seat-h 记真实高）。
 *     ⑤ 状态胶囊（dsh-status-pills 的非会话页悬浮份）一起淡出，免得浮在消息顶上。
 *
 * 判定（手感参数）：
 *   · 只认手机窄屏（≤899px）且非 Windows 标题栏壳；桌面宽屏完全不参与。
 *   · 向下累积滚过 26px → 收起；向上滚任意 1px → 立刻弹回（主人要的「往上滑一点」）。
 *   · 滚回顶部 6px 内 / 输入框获得焦点 / 点了输入框（键盘要弹）→ 强制显示。
 *   · 只有「最近 1.2s 内有手指（或滚轮）真的在动」才收起 —— 发消息后自动滚到底、
 *     打开会话定位到底这类程序性滚动不会把输入框偷偷藏掉。
 *   · 切换状态后 320ms 内不响应 scroll（躲开 Chrome scroll anchoring 的补偿）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-scroll-hide-chrome',
  factory() {
    /* ── 参数 ─────────────────────────────────────────────────────── */
    const STYLE_ID = 'dsh-scroll-hide-chrome-style'
    const ATTR = 'data-djh-chrome'
    const H_VAR = '--djh-chrome-h'
    const SEAT_H_VAR = '--djh-seat-h'
    /** 手机断点：与 swipe-sidebar 的抽屉模式错开一点，899 仍覆盖大屏手机。 */
    const MQ = '(max-width: 899px)'
    /** 会话页唯一滚动容器（片段匹配，别用哈希类名）。 */
    const SCROLLER = 'div[class*="_scrollBody"]'
    /** 顶栏（只认 header 标签，页面里消息区的 div 也叫 *_header，别误伤）。 */
    const HEADER = 'header[class*="_header"]'
    /** 顶栏浮层标记（JS 精确打在会话页那个 header 上，CSS 才动它）。 */
    const OVERLAY_ATTR = 'data-djh-overlay'
    /** 会话根标记（padding-top 只补给这个 root 里的 scrollBody）。 */
    const ROOT_ATTR = 'data-djh-overlay-root'
    /** 底部输入区（sticky 在 scrollBody 里）。 */
    const SEAT = 'div[class*="_composerSeat"]'
    /** 输入区的内层容器（真正的内容高度来源，含输入卡 + 状态行 + 瓷砖面板）。 */
    const STACK = 'div[class*="_composerStack"]'
    /** 输入框所在的整块（点它/聚焦它都算「用户要打字」）。 */
    const COMPOSER = 'div[class*="_composerSeat"], div[class*="_composerStack"]'
    /** 向下累积多少 px 才收起。 */
    const DOWN_ACC = 26
    /** 顶部这么近就永远显示。 */
    const TOP_ZONE = 6
    /** 切换状态后的静默窗口（躲开 scroll anchoring 补偿）。 */
    const IGNORE_MS = 320
    /** 手指/滚轮停止这么久之后的滚动 = 程序性滚动，不算「往下读」。 */
    const GESTURE_MS = 1200
    /** 输入框交互后的强制显示窗口。 */
    const LOCK_MS = 1500
    /** 软键盘避让：键盘低于这个高度就不算（浏览器地址栏/工具栏抖动只有 40–60px）。 */
    const KB_MIN = 120
    /** 键盘弹/收之后按 120ms 一次连测 1.4s（躲开动画中间态，别把半开的高度记死）。 */
    const KB_TICK_MS = 120
    const KB_SETTLE_MS = 1400
    /** 看门狗：键盘可能「静默收起」（鸿蒙实测：不派 vv.resize，也不派 focusout）。 */
    const KB_WATCH_MS = 400
    /** 键盘高度抖动小于这个值就不重写高度（防 1px 抖动把页面抖起来）。 */
    const KB_JITTER = 12
    /** 冻结态最多能撑多久没有「输入/上屏/真键盘」信号（防用户把键盘收掉后页面一直卡在少一截）。 */
    const KB_HOLD_IDLE_MS = 45000
    /** 冻结高度上限（视口比例）——小艺「语音转文字」面板比键盘矮一截，直接沿用键盘高会把
        输入卡顶到屏幕中间、底下留一大块纯色空白（2026-11-15 主人截图实测：压了 487px，
        面板只占 306px → 181px 黑带）。宁可留一条细缝，也不许顶飞。 */
    const KB_HOLD_MAX_RATIO = 0.5

    /* ── 样式（幂等注入，走 ctx.effect 清理） ──────────────────────── */
    const CSS = [
      '@media (max-width: 899px) {',
      /* 顶栏改浮层：脱离文档流盖在消息区上面 —— 出现/收起都不再推挤页面。 */
      '  header[class*="_header"][data-djh-overlay] {',
      '    position: absolute;',
      '    top: 0;',
      '    left: 0;',
      '    right: 0;',
      '    z-index: 50;',
      '    min-height: 0 !important;',
      '    grid-template-rows: auto !important;',
      '    background: var(--dsw-alias-bg-base);',
      '    transition: transform 220ms cubic-bezier(0.2, 0.7, 0.3, 1), opacity 160ms linear;',
      '    will-change: transform;',
      '  }',
      /* 第 2 行整条删掉：视图 tab（对话/轨迹）+ 右侧「…」更多按钮都在这一层。 */
      '  header[class*="_header"][data-djh-overlay] div[class*="_tabs"] { display: none !important; }',
      /* 安全阀：万一当前不在第一个视图（例：轨迹），把 tab 行放回来，否则手机上回不到「对话」。 */
      '  header[class*="_header"][data-djh-overlay]:has([data-conversation-tabs] [role="tab"][aria-selected="true"]:not(:first-child)) div[class*="_tabs"] { display: flex !important; }',
      /* 左栏抽屉按钮是「框架层」浮层（div[class*="_leadingSeat"]，z-index:15，位置 12,11），
         原来靠 z-index 压在占位顶栏上；顶栏改浮层(50)后会把它整块盖住 → 抬到顶栏之上。 */
      '  div[class*="_leadingSeat"] { z-index: 60 !important; }',
      /* 右侧栏全屏面板（工作区文件/终端等）是布局层 absolute（z=auto）→ 会被顶栏浮层(50)整块盖住，
         它自己的「收起右侧边栏 ✕」按钮(右下 y≈10)点不到 = 回不到对话（2026-11-16 主人手机实测）。
         打开时抬到 55：压过顶栏(50)、仍让位左栏抽屉按钮(60)。 */
      '  div[class*="_rightbarCol"] [data-sidebar-right-open="true"] { z-index: 55 !important; }',
      /* 浮层不占位 → 滚动内容顶部补一条留白，滚到顶时第一条消息仍从顶栏下沿开始。 */
      '  div[data-djh-overlay-root] div[class*="_scrollBody"] { padding-top: var(--djh-chrome-h, 0px) !important; }',
      /* 收起态：整条滑出屏幕 + 淡出，布局零变化。 */
      '  html[data-djh-chrome="hidden"] header[class*="_header"][data-djh-overlay] {',
      '    transform: translateY(-100%);',
      '    opacity: 0;',
      '    pointer-events: none;',
      '  }',
      '  div[class*="_composerSeat"] {',
      '    height: var(--djh-seat-h, auto);',
      '    transition: transform 220ms cubic-bezier(0.2, 0.7, 0.3, 1), opacity 180ms linear, height 220ms cubic-bezier(0.2, 0.7, 0.3, 1);',
      '  }',
      '  html[data-djh-chrome="hidden"] div[class*="_composerSeat"] {',
      '    height: 0 !important;',
      '    min-height: 0 !important;',
      '    padding-top: 0 !important;',
      '    padding-bottom: 0 !important;',
      '    margin-top: 0 !important;',
      '    margin-bottom: 0 !important;',
      '    overflow: hidden;',
      '    opacity: 0;',
      '    pointer-events: none;',
      '  }',
      '  html[data-djh-chrome="hidden"] [data-status-pills-overlay] {',
      '    opacity: 0;',
      '    transition: opacity 160ms linear;',
      '    pointer-events: none;',
      '  }',
      '}',
    ].join('\n')

    return {
      apply(ctx) {
        if (typeof document === 'undefined') return

        /* 幂等：HMR 重跑 factory 时先清掉上一份样式（教训 40）。 */
        document.getElementById(STYLE_ID)?.remove()
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)

        const root = document.documentElement
        const mq = typeof matchMedia === 'function' ? matchMedia(MQ) : null
        let hidden = false
        let lastTop = 0
        let acc = 0
        let ignoreUntil = 0
        let lockUntil = 0
        let lockSource = ''
        let lastIntent = -1e9

        const now = () => performance.now()
        const narrow = () =>
          mq !== null &&
          mq.matches &&
          !root.hasAttribute('data-windows-titlebar')
        const scroller = () => document.querySelector(SCROLLER)

        /* ── 顶栏浮层：精确认「会话页 header」并打标（切会话会重建，得跟着换） ── */
        let overlayHeader = null
        let overlayRoot = null
        const clearOverlay = () => {
          if (overlayHeader) {
            overlayHeader.removeAttribute(OVERLAY_ATTR)
            overlayHeader = null
          }
          if (overlayRoot) {
            overlayRoot.removeAttribute(ROOT_ATTR)
            overlayRoot = null
          }
          root.style.removeProperty(H_VAR)
        }
        /** 认会话页顶栏 → 打浮层标记；非窄屏/非会话页自动摘干净。@returns header|null */
        const syncChrome = () => {
          if (!narrow()) {
            if (overlayHeader || overlayRoot) clearOverlay()
            return null
          }
          const el = scroller()
          const rootEl = el ? el.closest('div[class*="_root"]') : null
          /* 只认 header 标签：消息区里也有 div[class*="_header"]，别误伤。 */
          const header = rootEl ? rootEl.querySelector(HEADER) : null
          if (!rootEl || !header) {
            if (overlayHeader || overlayRoot) clearOverlay()
            return null
          }
          if (header !== overlayHeader) {
            if (overlayHeader) overlayHeader.removeAttribute(OVERLAY_ATTR)
            header.setAttribute(OVERLAY_ATTR, '')
            overlayHeader = header
          }
          if (rootEl !== overlayRoot) {
            if (overlayRoot) overlayRoot.removeAttribute(ROOT_ATTR)
            rootEl.setAttribute(ROOT_ATTR, '')
            overlayRoot = rootEl
          }
          return header
        }

        /* ── 顶栏 / 输入区实际高度 → CSS 变量 ─────────────────────────
           顶栏高度只用来给滚动内容补顶部留白（浮层不占位）；
           输入区高度用来做 0 ↔ 真实高 的过渡。 */
        let ro = null
        let roTarget = null
        let roStackTarget = null
        let lastMeasure = 0
        /** 切换收起/恢复后这段时间内不量输入区高度（会量到过渡中的 0/8px 把变量写坏）。 */
        let measureSkipUntil = 0
        /** 收起/恢复过渡结束后的补量定时器（内容在动画期间变过就纠回来）。 */
        let settleTimer = 0
        const setVar = (name, px) => {
          const prev = parseInt(root.style.getPropertyValue(name) || '0', 10)
          if (prev === px) return
          root.style.setProperty(name, px + 'px')
        }
        /**
         * 输入区「内容自然高度」。
         *
         * ⚠️ 2026-11-15 主人实锤（screenshot_20261115_194932 红圈）：**把输入板收成待机条
         * （折叠）之后，输入框下面留一整块黑色空白**。
         * 根因：`--djh-seat-h` 之前是拿 composerSeat 自己的盒子量的，而 seat 的 CSS 又是
         * `height: var(--djh-seat-h)` —— 一旦量过展开态（128/170），之后内容变矮（折叠成
         * 待机条 116/74），盒子仍被钉在旧值上，再量还是旧值 → 变量只增不减，多出来的高度
         * 就是那块黑框（seat 背景透明，露出页面底色）。反过来量小了还会把统计行顶出屏幕。
         * 解法：先把高度约束临时解开（inline `height:auto!important` 能压过 hidden 那条
         * `height:0!important`），量一次真实内容高度再还原 —— 同一个任务里完成，浏览器不会
         * 中途绘制，不会闪。
         */
        const seatNaturalHeight = (seat) => {
          if (!seat) return 0
          const prevH = seat.style.getPropertyValue('height')
          const prevP = seat.style.getPropertyPriority('height')
          seat.style.setProperty('height', 'auto', 'important')
          const h = Math.round(seat.getBoundingClientRect().height)
          if (prevH) seat.style.setProperty('height', prevH, prevP)
          else seat.style.removeProperty('height')
          return h
        }
        const measureSizes = () => {
          const header = syncChrome()
          const seat = document.querySelector(SEAT)
          /* 输入框内容变高（换行/附件/瓷砖面板）时 seat 自己没变高（被 --djh-seat-h 钉着），
             只有 composerStack 会变 → 也盯着它，内容一变就把变量校回来。 */
          const stack = document.querySelector(STACK)
          /* 切会话后顶栏/输入区会重建：RO 跟着换绑，别盯着旧的。 */
          const anchor = header || seat
          if (ro && anchor && (anchor !== roTarget || stack !== roStackTarget)) {
            ro.disconnect()
            if (header) ro.observe(header)
            if (seat) ro.observe(seat)
            if (stack) ro.observe(stack)
            roTarget = anchor
            roStackTarget = stack
          }
          if (!narrow()) return
          /* 浮层收起只做 transform，不改布局 → 任何时刻量到的都是真实高。
             用 ceil：留白宁可多 1px，也别让第一条消息钻到顶栏底下。 */
          if (header) {
            const h = Math.ceil(header.getBoundingClientRect().height)
            if (h > 0) setVar(H_VAR, h)
          }
          /* 收起态/过渡中量 seat 会量坏变量（实测恢复动画中途量到 8px → 输入框卡在 8px）。 */
          if (seat && !hidden && now() >= measureSkipUntil) {
            const h = seatNaturalHeight(seat)
            if (h > 0) setVar(SEAT_H_VAR, h)
          }
        }

        /* ── 状态切换（只切属性，布局靠 CSS 浮层） ────────────────────── */
        const setHidden = (next) => {
          const want = next && narrow()
          if (want === hidden) return
          hidden = want
          if (!hidden) acc = 0
          /* 抬手前把真实高度再记一次（标题换行/输入框内容变化都会改高度）。 */
          const header = want ? syncChrome() : overlayHeader
          if (header) {
            const h = Math.round(header.getBoundingClientRect().height)
            if (h > 0) root.style.setProperty(H_VAR, h + 'px')
          }
          /* 收起/恢复两个方向都先用「内容自然高度」刷新变量：恢复时它决定从 0 展开到多高，
             收起时它决定要不要多留一截黑框（2026-11-15 主人红圈那个）。 */
          const seat = document.querySelector(SEAT)
          const sh = seatNaturalHeight(seat)
          if (sh > 0) root.style.setProperty(SEAT_H_VAR, sh + 'px')
          ignoreUntil = now() + IGNORE_MS
          /* 收起/恢复的 220ms 过渡里别量输入区（否则会量到 0 或半高写坏 --djh-seat-h）。 */
          measureSkipUntil = now() + 300
          root.setAttribute(ATTR, hidden ? 'hidden' : 'shown')
          /* 过渡结束后补量一次：内容若在动画期间变过（键盘/附件条），把变量纠回来。 */
          clearTimeout(settleTimer)
          settleTimer = setTimeout(() => {
            settleTimer = 0
            measureSizes()
          }, 360)
        }

        /* ── 滚动判定 ──────────────────────────────────────────────── */
        const onScroll = (event) => {
          const el = event.target
          if (!el || el.nodeType !== 1 || typeof el.matches !== 'function') return
          if (!el.matches(SCROLLER)) return

          const t = now()
          const top = el.scrollTop
          const dy = top - lastTop
          lastTop = top

          /* 冻结态下手指真的在滚 → 用户要看内容了，把页面还回去。 */
          if (kbHold && t - lastIntent < GESTURE_MS) kbReleaseHold('scroll')

          if (!narrow()) {
            if (hidden) setHidden(false)
            return
          }
          /* 静默窗/输入框锁：只跟位置，不判定（免得把锚定补偿当上滑）。 */
          if (t < ignoreUntil || t < lockUntil) return
          if (t - lastMeasure > 400) {
            lastMeasure = t
            measureSizes()
          }
          if (top <= TOP_ZONE) {
            acc = 0
            setHidden(false)
            return
          }
          /* 不是手指/滚轮在动 → 程序性滚动（发消息后贴底、打开会话定位）。 */
          if (t - lastIntent > GESTURE_MS) return

          if (dy > 0) {
            acc = acc > 0 ? acc + dy : dy
            if (acc >= DOWN_ACC) {
              acc = 0
              setHidden(true)
            }
          } else if (dy < 0) {
            acc = 0
            setHidden(false)
          }
        }

        /* ── 用户意图：触摸 / 滚轮 / 指针 ──────────────────────────── */
        const markIntent = () => {
          lastIntent = now()
        }

        /* ── 点输入框要打字 → 强制显示；收起时点消息区以外 → 弹回 ────── */
        const onComposerTouch = (event) => {
          const t = event.target
          if (!t || t.nodeType !== 1 || typeof t.closest !== 'function') return
          /* 收起态的 comoser 是 pointer-events:none，点不到；点到了就算要打字。 */
          if (t.closest(COMPOSER)) {
            lockUntil = now() + LOCK_MS
            lockSource = 'pointer:' + String(t.className || t.tagName).slice(0, 40)
            /* 主动点输入框 = 又要打字/说话 → 解除「冻结否决」。 */
            kbVeto = false
            setHidden(false)
            return
          }
          /* 点输入区以外：输入法要是已经没了，就是「我看完了」→ 解除冻结立刻还原
             （别让页面停在少一截的状态；键盘还在的话交给 vv 自己收）。 */
          if (kbHold && kbMeasure() === 0) kbReleaseHold('outside-tap')
          /* 收起态点消息区以外的地方（左栏抽屉、右栏、标题栏…）→ 说明要找功能，弹回来。 */
          if (hidden && !t.closest(SCROLLER)) setHidden(false)
        }

        const onFocusIn = (event) => {
          const t = event.target
          if (!t || t.nodeType !== 1 || typeof t.closest !== 'function') return
          if (!t.closest(COMPOSER)) return
          /* 只显示、不锁：DSH 在切会话/数据更新时会自动聚焦输入框（实测 headless
             反复 "focus:uV2eYG_input"），要是这里也锁 1.5s，「往下读」就永远被吞掉。
             真正的「用户要打字」由 pointerdown 那条锁住。 */
          setHidden(false)
        }

        /* ── 视口跨断点 / 切会话 ──────────────────────────────────── */
        const onViewport = () => {
          if (!narrow()) {
            setHidden(false)
            measureSizes()
            return
          }
          const el = scroller()
          lastTop = el ? el.scrollTop : 0
          acc = 0
          measureSizes()
        }

        /* ── DOM 变动兜底：切会话/换视图会重建 header 与 scrollBody ──
           RO 只盯旧元素（删了不会回调），靠 300ms 节流的 MutationObserver
           把浮层标记跟过去；离开会话页（找不到 scrollBody）就摘干净。 */
        let mo = null
        let moTimer = 0
        const onMutations = () => {
          if (moTimer) return
          moTimer = setTimeout(() => {
            moTimer = 0
            measureSizes()
          }, 300)
        }

        /* ── 软键盘避让（2026-11-15 主人：「点了一下输入框，键盘弹出来把输入框盖住一半」）──
           手机浏览器默认「键盘浮在页面上」：布局视口（innerHeight）不变，只有 visualViewport 变矮，
           而 composerSeat 贴着布局视口底部 → 整个被键盘盖住。治法是量出键盘高度，把布局根
           （overflow:hidden 且高度≈视口的那个祖先）压成「可视高度」，scrollBody 少这么多，
           输入区自然坐到键盘上沿；键盘收起立刻还原。
           量法：键盘高 ≈ innerHeight - visualViewport.height - visualViewport.offsetTop。
           ≤120px 不算（浏览器地址栏/工具栏抖动只有 40–60px，别把内容顶上去）。

           ⚠️ 2026-11-15 第二版（主人真机实锤）：键盘「自己退回去」之后整页卡在少了一截的状态
           ——底下一条黑、输入框悬在半空（截图 `screenshot_20261115_190708`）。根因是旧版只靠
           `visualViewport.resize` + `focusout` 还原，而鸿蒙浏览器键盘收起时可以**一个事件都不派**
           （headless 复现：把 vv.height 改回去、不派事件，旧版 kbHeight 永远停在键盘打开时的值）。
           这一版三层自愈：
             ①事件后连测 1.4s（每 120ms）：键盘动画到一半时量的高度也会被后几拍纠正；
             ②常驻看门狗（400ms）：只要量到键盘没了（或高度变了 >12px）就立刻还原/重压；
             ③页面隐藏/切后台/转屏/回前台一律重新量——后台期间不压，回来再压。 */
        /* ── 2026-11-15 第三版：小艺「语音转文字」悬浮面板 ───────────────
           主人截图 `screenshot_20261115_194947`（djh.dagaichat.com，鸿蒙浏览器）：
           点输入法里的语音 → 键盘收起、换成一块**悬浮的语音面板**，页面收不到任何信号
           （visualViewport 不缩、也不派 resize），输入框下半截被面板压住。

           实测推演：面板出来时页面还是满高 —— 布局零变化，输入区停在页中/页底 →
           面板一盖就少半块。所以光靠量 vv 治不了这种「静默输入法」，得三手一起上：

           ①**冻结（kbHold）**：键盘没了、但焦点还留在输入框 → 不还原，把上次量到的
             键盘高（+8px 余量）当作面板高顶住。用户点页面别处 / 滚动 / 失焦 / 切后台
             才算「真的不要输入法」，立刻还原（否则就又变成「整页卡在少一截」）。
           ②**抬升（kbLift）**：压完再量一次输入区，整块还盖住就 translateY 抬上去 ——
             欢迎页那种「内容垂直居中」的布局，压 root 只能抬一半，靠它补足差额，保证
             「整个输入框都看得见」（主人原话）。
           ③**compositionstart**：语音转文字正在上屏 = 输入法一定在。没量到过键盘
             （面板直接以语音模式起来）就按 0.45 视口高先估一个。 */
        let kbHeight = 0
        let kbRootEl = null
        let kbSavedStyle = null
        /** 最近一次量到的键盘高（冻结时当面板高用）。 */
        let kbLast = 0
        /** 冻结态：键盘没了但焦点还在输入框（大概率是悬浮语音面板）。 */
        let kbHold = false
        /** 冻结否决：用户明确表示不要输入法了 → 下次真量到键盘之前不再冻结。 */
        let kbVeto = false
        /** 最近一次「真的在输入/上屏」的时刻（语音转文字上屏不一定立刻进 DOM）。 */
        let kbTypingAt = -1e9
        /** 最近一次真的量到键盘的时刻（输入法从键盘切成语音面板时靠它接住）。 */
        let kbLastSeenAt = -1e9
        /** 额外上移量（压完还盖住时把 composerSeat 再抬上去）。 */
        let kbLift = 0
        /** 最近几次「键盘高度 → 压成多高」的轨迹（自检口用，别在界面上显示）。 */
        const kbLog = []
        const kbNote = (next, h) => {
          kbLog.push(next + '→' + (h || 'restore') + '@' + Math.round(window.innerHeight))
          if (kbLog.length > 12) kbLog.shift()
        }
        const kbTimers = []
        const kbClearTimers = () => {
          while (kbTimers.length) clearTimeout(kbTimers.pop())
        }
        const kbMeasure = () => {
          const vv = window.visualViewport
          if (!vv || !narrow()) return 0
          if (document.visibilityState === 'hidden') return 0
          const h = Math.round(window.innerHeight - vv.height - (vv.offsetTop || 0))
          return h >= KB_MIN ? h : 0
        }
        const kbFindRoot = () => {
          const seat = document.querySelector(SEAT)
          if (!seat) return null
          const vh = window.innerHeight
          let n = seat.parentElement
          while (n && n !== document.body) {
            const cs = getComputedStyle(n)
            const r = n.getBoundingClientRect()
            if ((cs.overflow === 'hidden' || cs.overflow === 'clip') && r.height >= vh - 2) return n
            n = n.parentElement
          }
          /* 兜底：会话根（视口切换/布局过渡中途上面那条判据可能量不到满高，别就此放弃压）。 */
          const sb = document.querySelector(SCROLLER)
          const rootEl = sb ? sb.closest('div[class*="_root"]') : null
          return rootEl || null
        }
        /** 焦点还在输入区里？（冻结的前提；也挡掉「自动 focus」的误判——那条由 kbVeto 管）。 */
        const kbFocused = () => {
          const a = document.activeElement
          if (!a || a.nodeType !== 1 || typeof a.closest !== 'function') return false
          return narrow() && !!a.closest(COMPOSER)
        }
        /** 输入区「自然」下沿：量之前先摘掉我们自己加的 transform，免得量到抬过的位置。 */
        const kbComposerBottom = () => {
          const seat = document.querySelector(SEAT)
          if (!seat) return null
          const saved = seat.style.getPropertyValue('transform')
          if (saved) seat.style.removeProperty('transform')
          const r = seat.getBoundingClientRect()
          let bottom = r.bottom
          /* 卡片（输入框本体）有时比 seat 更高，取两者的下沿。 */
          const card = document.querySelector('[data-composer-card="true"]')
          if (card) {
            const c = card.getBoundingClientRect()
            if (c.height > 0) bottom = Math.max(bottom, c.bottom)
          }
          if (saved) seat.style.setProperty('transform', saved, 'important')
          return bottom
        }
        const kbSetLift = (px) => {
          const seat = document.querySelector(SEAT)
          if (!seat) {
            kbLift = 0
            return
          }
          const want = Math.max(0, Math.round(px))
          if (want === kbLift) return
          kbLift = want
          if (want > 0) {
            seat.style.setProperty('transform', 'translateY(-' + want + 'px)', 'important')
            kbNote('lift', want + 'px')
          } else {
            seat.style.removeProperty('transform')
          }
        }
        /** 保险：整块输入区必须在输入法上沿之上（压 root 抬不起居中的布局时靠它补）。 */
        const kbGuard = () => {
          if (kbHeight <= 0 || !narrow()) {
            if (kbLift) kbSetLift(0)
            return
          }
          const bottom = kbComposerBottom()
          if (bottom === null) return
          /* 量的是「不带 transform」的自然位置 → 需要的抬升量就是差值本身（不能再累加）。 */
          const over = bottom - (window.innerHeight - kbHeight)
          if (over > 1) kbSetLift(over)
          else if (over < -1) kbSetLift(0)
        }
        /** 输入框里现在有字吗（含 contenteditable）。发完消息/清空后不该继续冻结。 */
        const kbHasText = () => {
          const seat = document.querySelector(SEAT)
          if (!seat) return false
          const a = document.activeElement
          const cands = []
          if (a && seat.contains(a)) cands.push(a)
          const inp = seat.querySelector('textarea, input, [contenteditable="true"], [contenteditable=""]')
          if (inp) cands.push(inp)
          for (const el of cands) {
            if (typeof el.value === 'string' && el.value.trim()) return true
            if (el.isContentEditable && String(el.innerText || '').trim()) return true
          }
          return false
        }
        /** 真的在输入/上屏（语音转文字的中间态可能还没进 DOM，靠事件时间兜住）。 */
        const kbTyping = () => now() - kbTypingAt < 15000
        /* 冻结的前提：焦点在输入框，并且「有字 / 刚在输入 / 刚量到键盘」三者之一。
           最后一项是键盘→语音面板那一瞬间的接续（手还没开始说话，框里是空的）。 */
        const kbHoldable = () =>
          kbFocused() && (kbHasText() || kbTyping() || now() - kbLastSeenAt < 90000)
        const kbApply = (next) => {
          /* 冻结时用上次键盘高 + 8px 余量（语音面板一般和键盘差不多高，宽一点点更稳），
             但**按视口一半封顶**：语音面板经常比键盘矮一截，照抄键盘高会把输入卡顶到
             屏幕中间、底下留一条纯色黑带（v0.057 主人截图实锤 181px）。 */
          const heldRaw = kbHold ? (kbLast >= KB_MIN ? kbLast + 8 : Math.round(window.innerHeight * 0.45)) : 0
          const holdCap = Math.round(window.innerHeight * KB_HOLD_MAX_RATIO)
          const held = heldRaw > 0 ? Math.min(heldRaw, holdCap) : 0
          const want = next > 0 ? next : held
          if (want <= 0) {
            if (kbHeight !== 0 || kbRootEl) {
              kbHeight = 0
              kbRestore()
            }
            if (kbLift) kbSetLift(0)
            return
          }
          /* ⚠️ 容器只在「还没压」的时候找：压过之后它高度已经变矮，kbFindRoot 的
             「高度≈视口」判据会失配 → 返回 null → 高度留在旧值上（实测就是这样卡在中间态的）。 */
          if (!kbRootEl || !kbRootEl.isConnected) {
            const el = kbFindRoot()
            if (!el) {
              kbHeight = want
              kbGuard()
              return
            }
            kbRootEl = el
            kbSavedStyle = { height: el.style.height, maxHeight: el.style.maxHeight }
          }
          kbHeight = want
          const h = Math.max(200, window.innerHeight - want) + 'px'
          if (kbRootEl.style.getPropertyValue('height') !== h) {
            kbRootEl.style.setProperty('height', h, 'important')
            kbRootEl.style.setProperty('max-height', h, 'important')
            kbNote(next > 0 ? next : 'hold' + want, h)
          }
          kbGuard()
        }
        /** 判定：vv 有信号按 vv；vv 说没有但焦点还在输入框 → 冻结顶住；否则还原。 */
        const kbDecide = () => {
          const next = kbMeasure()
          if (next > 0) {
            kbLast = next
            kbLastSeenAt = now()
            kbVeto = false
            if (kbHold) {
              kbHold = false
              kbNote('hold-off:kb', next)
            }
            kbApply(next)
            return
          }
          if (kbHold) {
            /* 长时间没有任何输入信号 → 多半不是语音面板，是用户把键盘收了在阅读：
               还回去，别让页面一直卡在少一截（教训 52 那种「底下一条黑」）。 */
            if (now() - Math.max(kbTypingAt, kbLastSeenAt) > KB_HOLD_IDLE_MS) {
              kbReleaseHold('idle')
              return
            }
            if (!kbHoldable()) {
              kbReleaseHold('blur')
              return
            }
            kbApply(0)
            return
          }
          if (!kbVeto && kbHoldable() && kbLast >= KB_MIN) {
            kbHold = true
            kbNote('hold@' + kbLast, '')
            kbApply(0)
            return
          }
          kbApply(0)
        }
        /** 解除冻结（用户点别处/滚动/失焦/切后台）：立刻还原，并禁止再自动冻结一轮。 */
        const kbReleaseHold = (why) => {
          if (!kbHold && kbHeight === 0) return
          kbHold = false
          kbVeto = true
          kbNote('hold-off:' + why, 0)
          kbApply(0)
        }
        const kbRestore = () => {
          if (kbRootEl) {
            kbRootEl.style.removeProperty('height')
            kbRootEl.style.removeProperty('max-height')
            if (kbSavedStyle) {
              if (kbSavedStyle.height) kbRootEl.style.height = kbSavedStyle.height
              if (kbSavedStyle.maxHeight) kbRootEl.style.maxHeight = kbSavedStyle.maxHeight
            }
          }
          kbSavedStyle = null
          kbRootEl = null
          kbHeight = 0
        }
        /* 键盘弹/收有动画：连测 1.4s（120ms 一拍），不会停在中间态。 */
        const kbSync = () => {
          kbClearTimers()
          const t0 = now()
          const tick = () => {
            kbDecide()
            if (now() - t0 < KB_SETTLE_MS) kbTimers.push(setTimeout(tick, KB_TICK_MS))
          }
          tick()
        }
        /* 看门狗：键盘静默收起（没有任何事件）时唯一能救回来的路；
           冻结态下还负责「焦点没了就还回去」。 */
        let kbWatch = 0
        const kbWatchTick = () => {
          if (document.visibilityState === 'hidden' || !narrow()) return
          const next = kbMeasure()
          if (next > 0) {
            if (kbHeight === 0 || Math.abs(next - kbHeight) >= KB_JITTER) kbDecide()
            else kbGuard()
            return
          }
          if (kbHold || kbHeight > 0) {
            kbDecide()
            return
          }
          kbGuard()
        }
        const onVv = () => {
          /* 键盘弹出时若输入区被「往下读」收起了，先弹回来。 */
          if (kbMeasure() > 0 && hidden) setHidden(false)
          kbSync()
        }
        const onKbFocus = (event) => {
          const t = event.target
          if (t && t.nodeType === 1 && typeof t.closest === 'function' && t.closest(COMPOSER)) kbSync()
        }
        /* 失焦后连测两拍：有些浏览器先派 focusout、键盘动画后才收完。 */
        const onKbBlur = () => {
          kbSync()
          kbTimers.push(
            setTimeout(() => kbDecide(), 700),
            setTimeout(() => kbDecide(), 1200),
          )
        }
        const onVisibility = () => {
          if (document.visibilityState === 'hidden') {
            kbClearTimers()
            kbHold = false
            kbVeto = false
            kbRestore()
            kbSetLift(0)
          } else {
            kbSync()
          }
        }
        /* 语音转文字正在上屏 = 输入法一定在。面板直接以语音模式起来（没开键盘、
           vv 也没缩）时，这是唯一的信号 → 按上次键盘高/0.45 视口先顶住。 */
        const onComposition = (event) => {
          const t = event && event.target
          if (t && t.nodeType === 1 && typeof t.closest === 'function' && t.closest(COMPOSER)) {
            kbTypingAt = now()
          }
          if (!narrow() || !kbFocused()) return
          if (kbMeasure() > 0) return
          kbVeto = false
          if (!kbHold) {
            kbHold = true
            kbNote('hold:composition@' + (kbLast || 'est'), '')
          }
          kbApply(0)
          kbSync()
        }
        /* 任何输入（含输入法上屏）都算「正在用输入法」→ 冻结判定要用。 */
        const onComposerInput = (event) => {
          const t = event && event.target
          if (!t || t.nodeType !== 1 || typeof t.closest !== 'function') return
          if (t.closest(COMPOSER)) kbTypingAt = now()
        }

        /* ── 挂监听 ──────────────────────────────────────────────── */
        const scrollOpts = { capture: true, passive: true }
        document.addEventListener('scroll', onScroll, scrollOpts)
        document.addEventListener('touchstart', markIntent, scrollOpts)
        document.addEventListener('touchmove', markIntent, scrollOpts)
        document.addEventListener('wheel', markIntent, scrollOpts)
        document.addEventListener('pointerdown', onComposerTouch, { capture: true, passive: true })
        document.addEventListener('focusin', onFocusIn, true)
        document.addEventListener('focusin', onKbFocus, true)
        document.addEventListener('focusout', onKbBlur, true)
        document.addEventListener('compositionstart', onComposition, true)
        document.addEventListener('compositionupdate', onComposition, true)
        document.addEventListener('input', onComposerInput, true)
        window.addEventListener('resize', onViewport)
        window.addEventListener('orientationchange', kbSync)
        window.addEventListener('pageshow', kbSync)
        document.addEventListener('visibilitychange', onVisibility)
        const vv = window.visualViewport
        if (vv) {
          vv.addEventListener('resize', onVv)
          vv.addEventListener('scroll', onVv)
        }
        kbWatch = setInterval(kbWatchTick, KB_WATCH_MS)
        if (mq) {
          if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onViewport)
          else if (typeof mq.addListener === 'function') mq.addListener(onViewport)
        }
        if (typeof ResizeObserver === 'function') {
          /* 输入框变高（加附件/多行）会把下沿往下推 → 每次尺寸变化都重校一次抬升。 */
          ro = new ResizeObserver(() => {
            measureSizes()
            kbGuard()
          })
          const header = syncChrome()
          if (header) ro.observe(header)
          const seat = document.querySelector(SEAT)
          if (seat) ro.observe(seat)
          const stack = document.querySelector(STACK)
          if (stack) ro.observe(stack)
          roTarget = header || seat || null
          roStackTarget = stack
        }
        measureSizes()
        if (typeof MutationObserver === 'function') {
          mo = new MutationObserver(onMutations)
          mo.observe(document.body, { childList: true, subtree: true })
        }
        /* 首次进来跟上当前滚动位置（切会话后已在底部时不误判）。 */
        {
          const el = scroller()
          lastTop = el ? el.scrollTop : 0
        }

        ctx.effect(
          () => () => {
            document.removeEventListener('scroll', onScroll, scrollOpts)
            document.removeEventListener('touchstart', markIntent, scrollOpts)
            document.removeEventListener('touchmove', markIntent, scrollOpts)
            document.removeEventListener('wheel', markIntent, scrollOpts)
            document.removeEventListener('pointerdown', onComposerTouch, true)
            document.removeEventListener('focusin', onFocusIn, true)
            document.removeEventListener('focusin', onKbFocus, true)
            document.removeEventListener('focusout', onKbBlur, true)
            document.removeEventListener('compositionstart', onComposition, true)
            document.removeEventListener('compositionupdate', onComposition, true)
            document.removeEventListener('input', onComposerInput, true)
            window.removeEventListener('resize', onViewport)
            window.removeEventListener('orientationchange', kbSync)
            window.removeEventListener('pageshow', kbSync)
            document.removeEventListener('visibilitychange', onVisibility)
            if (vv) {
              vv.removeEventListener('resize', onVv)
              vv.removeEventListener('scroll', onVv)
            }
            if (kbWatch) {
              clearInterval(kbWatch)
              kbWatch = 0
            }
            kbClearTimers()
            kbHold = false
            kbVeto = false
            kbRestore()
            kbSetLift(0)
            if (mq) {
              if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onViewport)
              else if (typeof mq.removeListener === 'function') mq.removeListener(onViewport)
            }
            if (ro) {
              ro.disconnect()
              ro = null
            }
            if (mo) {
              mo.disconnect()
              mo = null
            }
            if (moTimer) {
              clearTimeout(moTimer)
              moTimer = 0
            }
            if (settleTimer) {
              clearTimeout(settleTimer)
              settleTimer = 0
            }
            clearOverlay()
            root.removeAttribute(ATTR)
            root.style.removeProperty(H_VAR)
            root.style.removeProperty(SEAT_H_VAR)
            style.remove()
            if (window.__dshScrollHideChrome && window.__dshScrollHideChrome.__mine === STYLE_ID) {
              delete window.__dshScrollHideChrome
            }
          },
          'scroll-hide-chrome: style + listeners',
        )

        /* 自检口（headless/UI 断言用，不占界面）。 */
        window.__dshScrollHideChrome = {
          __mine: STYLE_ID,
          hidden: () => hidden,
          enabled: () => narrow(),
          top: () => {
            const el = scroller()
            return el ? el.scrollTop : null
          },
          force: (v) => setHidden(v !== false),
          /** 自检用：顶栏浮层状态（是否打标 / 高度 / 是否是绝对定位 / tab 行还在不在）。 */
          chrome: () => {
            const header = overlayHeader
            const scrollBody = scroller()
            return {
              overlay: !!header,
              headerH: header ? Math.round(header.getBoundingClientRect().height) : null,
              position: header ? getComputedStyle(header).position : null,
              tabsVisible: (function () {
                const t = header ? header.querySelector('[data-conversation-tabs]') : null
                if (!t) return false
                const wrap = t.closest('div[class*="_tabs"]')
                const el = wrap || t
                return getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0
              })(),
              padTop: scrollBody ? getComputedStyle(scrollBody).paddingTop : null,
              rootMarked: !!overlayRoot,
            }
          },
          kb: () => kbHeight,
          kbSync: () => { kbSync(); return kbHeight },
          /** 自检用：伪造一次「焦点还在输入框」的冻结判定（headless 里没法真的弹输入法）。 */
          kbHold: (on) => {
            kbHold = on !== false
            kbVeto = false
            kbApply(0)
            return kbHold
          },
          kbState: () => ({
            kbHeight,
            hold: kbHold,
            veto: kbVeto,
            lift: kbLift,
            last: kbLast,
            focused: kbFocused(),
            clamped: !!kbRootEl,
            root: kbRootEl ? String(kbRootEl.className || '').slice(0, 48) : null,
            rootH: kbRootEl ? Math.round(kbRootEl.getBoundingClientRect().height) : null,
            rootInline: kbRootEl ? kbRootEl.style.height || '' : '',
            applied: kbLog.slice(),
          }),
          debug: () => ({ lastIntent, acc, lastTop, ignoreUntil, lockUntil, lockSource, hidden, kb: kbHeight, now: now() }),
        }
      },
    }
  },
})
