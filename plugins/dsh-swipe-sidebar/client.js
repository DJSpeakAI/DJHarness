/**
 * 手机端左栏滑动手势（Client 半，无 Host 逻辑）—— 参数与机制整体照抄 little DJ
 * （little DJ ui/index.html 的 task174–177：edgeSwipeJudge / sideCloseJudge / 返回哨兵）。
 *
 * little DJ 在主人同一台手机上实测出来的结论，原样搬过来：
 *   ⚠️ 最物理的左边 ≤12px 是「系统手势死区」——那一小条由系统接手，滑动会被翻成
 *      history.back()，页面的 touch 事件根本收不到、preventDefault 也无效。
 *   所以走两条路：
 *     ① 触摸热区：起手 x 在 12–64px（y ≥ 44px，避开顶部按钮带），右滑 ≥40px 且横向
 *        明显大于纵向（dx > dy*1.6）→ 开左栏；
 *     ② 返回哨兵：页面进来先往历史栈垫一条同文档哨兵；系统把「左缘右滑」翻成返回时，
 *        popstate 里把这次返回翻译成「开左栏」而不是离开页面（连滑两下 ≈ 真想返回）。
 *        little DJ 原文：「鸿蒙/移动浏览器把左缘右滑抢成 history.back()（主人 2026-11-10
 *        实测：滑动=返回上一页），页面 touch 事件收不到、preventDefault 无效」。
 *
 * 只在 <768px 抽屉模式（`[data-sidebar-drawer]`）生效；桌面宽屏连哨兵都不垫。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-swipe-sidebar',
  factory() {
    /* ── 参数：与 little DJ task176/177 同口径 ───────────────────────── */
    /** 热区左界（≤12px 是系统死区，交给返回哨兵兜底）。 */
    const HOT_MIN_X = 12
    /** 热区右界：再往右算内容区，不算边缘手势。 */
    const HOT_MAX_X = 64
    /** 热区上界：顶部按钮带（y < 44）不参与，免得抢开关按钮的点击。 */
    const HOT_MIN_Y = 44
    /** 右滑开左栏阈值（little DJ task176 从 46 收到 40，更跟手）。 */
    const OPEN_DX = 40
    /** 横向主导比例：dx 必须大于 dy*1.6，否则算列表滚动。 */
    const OPEN_RATIO = 1.6
    /** 左滑收左栏阈值。 */
    const CLOSE_DX = 46
    /** 收起时同样要求横向主导。 */
    const CLOSE_RATIO = 1.6
    /** 明显反向或已经变竖滑 → 放弃本次跟踪。 */
    const ABORT_DX = -12
    const ABORT_DY = 26
    /** 历史栈哨兵标记 + 快速二次返回（逃生门）窗口。 */
    const SENTINEL = 'dshSidebarSentinel'
    const ESCAPE_MS = 450
    const ESCAPE_STICKY_MS = 5000

    /** 触摸起手点是不是落在交互元素/代码块上（little DJ 同款护栏）。 */
    const INTERACTIVE =
      'button,a,input,textarea,select,[contenteditable="true"],pre,code'

    /** 现在是不是「抽屉模式」（<768px 的窄屏，且不是 Windows 标题栏壳）。 */
    const drawerMode = () =>
      document.querySelector('[data-sidebar-drawer]') !== null
    /** 右栏是不是正以全屏形态占满（左栏被它盖住，滑出来也看不见）。 */
    const rightbarFullscreen = () =>
      document.querySelector('[data-rightbar-fullscreen]') !== null
    /** 抽屉模式下的左栏根节点（收起时也在 DOM 里，只是没有 aria-modal）。 */
    const drawerNode = () =>
      document.querySelector('[data-shortcut-modal="sidebar"]')
    /** 左栏抽屉当前是否展开。 */
    const drawerOpen = () => {
      const node = drawerNode()
      return node !== null && node.getAttribute('aria-modal') === 'true'
    }
    /**
     * 有没有别的弹层正开着（设置、模型、插件页等）。
     * 有些关闭状态的弹窗仍留在 DOM 里，所以按几何尺寸筛「真的开着」的；
     * 收起状态的抽屉根节点自身被排除在外。
     */
    const otherModalOpen = () => {
      const nodes = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
      for (const node of nodes) {
        if (node.hasAttribute('data-shortcut-modal')) continue
        const rect = node.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) return true
      }
      return false
    }

    return {
      inject: ['layout'],
      apply(ctx) {
        if (typeof document === 'undefined') return

        /* ── 手势状态机 ─────────────────────────────────────────────── */
        /** null = 没在跟踪；否则 { mode: 'open' | 'close', x, y, at }。 */
        let gesture = null

        const reset = () => {
          gesture = null
        }

        /** 只在「期望状态 ≠ 实际状态」时切，避免与点按钮/动画互顶。 */
        const switchTo = (wantOpen) => {
          gesture = null
          if (wantOpen === drawerOpen()) return
          ctx.layout.toggleSidebar()
        }

        /** little DJ edgeSwipeJudge 的等价物（在跟踪过程中边走边判）。 */
        const openSwipe = (dx, dy) =>
          dx >= OPEN_DX && dx > dy * OPEN_RATIO
        /** little DJ sideCloseJudge 的等价物。 */
        const closeSwipe = (dx, dy) =>
          dx <= -CLOSE_DX && -dx > dy * CLOSE_RATIO

        const onStart = (event) => {
          reset()
          if (event.touches.length !== 1) return
          if (!drawerMode()) return
          const touch = event.touches[0]

          if (drawerOpen()) {
            /* 开着：从哪儿起手都行，向左滑就收（遮罩上的横滑也算）。 */
            gesture = { mode: 'close', x: touch.clientX, y: touch.clientY }
            return
          }
          /* 关着：只认 12–64px 热区，且避开顶部按钮带与交互元素。 */
          if (touch.clientX < HOT_MIN_X || touch.clientX > HOT_MAX_X) return
          if (touch.clientY < HOT_MIN_Y) return
          const target = event.target
          if (target && target.closest && target.closest(INTERACTIVE)) return
          if (otherModalOpen()) return
          if (rightbarFullscreen()) return
          gesture = { mode: 'open', x: touch.clientX, y: touch.clientY }
        }

        const onMove = (event) => {
          if (gesture === null) return
          if (event.touches.length !== 1) {
            reset()
            return
          }
          const touch = event.touches[0]
          const dx = touch.clientX - gesture.x
          const dy = Math.abs(touch.clientY - gesture.y)
          if (gesture.mode === 'open') {
            if (openSwipe(dx, dy)) {
              switchTo(true)
              /* 手势已消化，别让页面顺便滚一下（little DJ 同样 preventDefault）。 */
              if (event.cancelable) event.preventDefault()
            } else if (dx < ABORT_DX || dy > ABORT_DY) {
              reset()
            }
            return
          }
          if (closeSwipe(dx, dy)) {
            switchTo(false)
            if (event.cancelable) event.preventDefault()
          } else if (dx > 12 || dy > ABORT_DY) {
            reset()
          }
        }

        /* ── 返回哨兵：把系统的「左缘右滑=返回」翻译成「开左栏」 ────────── */
        let exitUntil = 0
        let lastBackAt = 0
        /* 判模式用视口查询而不是 DOM：插件 apply 时布局还没挂载，等 DOM 会错过
           首屏那次垫哨兵（而首屏正是最需要它的时候）。Windows 标题栏壳不参与。 */
        const narrow =
          typeof matchMedia === 'function' ? matchMedia('(max-width: 767px)') : null
        const sentinelWanted = () =>
          narrow !== null &&
          narrow.matches &&
          !document.documentElement.hasAttribute('data-windows-titlebar')
        const armSentinel = () => {
          if (!sentinelWanted()) return
          try {
            if (history.state && history.state[SENTINEL] === 1) return
            const state = Object.assign({}, history.state || {})
            state[SENTINEL] = 1
            history.pushState(state, '')
          } catch (e) {
            /* 隐私模式/沙箱禁止 history 时无声退化为纯触摸热区。 */
          }
        }
        const onPopState = () => {
          if (!drawerMode()) return
          const now = Date.now()
          if (now < exitUntil) return
          /* 快速二次返回 = 真想退出（little DJ 逃生门）：放行并开 5s 粘性窗。 */
          if (now - lastBackAt < ESCAPE_MS) {
            lastBackAt = 0
            exitUntil = now + ESCAPE_STICKY_MS
            return
          }
          lastBackAt = now
          armSentinel()
          if (drawerOpen()) {
            switchTo(false)
            return
          }
          if (otherModalOpen() || rightbarFullscreen()) return
          switchTo(true)
        }

        const opts = { capture: true, passive: true }
        const moveOpts = { capture: true, passive: false }
        document.addEventListener('touchstart', onStart, opts)
        document.addEventListener('touchmove', onMove, moveOpts)
        document.addEventListener('touchend', reset, opts)
        document.addEventListener('touchcancel', reset, opts)
        window.addEventListener('popstate', onPopState)
        armSentinel()

        /* 视口跨过 768px 进入/离开抽屉模式时，补垫哨兵。 */
        const onViewport = () => armSentinel()
        if (narrow) {
          if (typeof narrow.addEventListener === 'function') narrow.addEventListener('change', onViewport)
          else if (typeof narrow.addListener === 'function') narrow.addListener(onViewport)
        }

        ctx.effect(
          () => () => {
            document.removeEventListener('touchstart', onStart, opts)
            document.removeEventListener('touchmove', onMove, moveOpts)
            document.removeEventListener('touchend', reset, opts)
            document.removeEventListener('touchcancel', reset, opts)
            window.removeEventListener('popstate', onPopState)
            if (narrow) {
              if (typeof narrow.removeEventListener === 'function') narrow.removeEventListener('change', onViewport)
              else if (typeof narrow.removeListener === 'function') narrow.removeListener(onViewport)
            }
          },
          'swipe-sidebar: touch listeners + back sentinel',
        )

        /* 自检口（headless/UI 断言用，不占界面）。 */
        window.__dshSwipeSidebar = {
          mode: () => (drawerMode() ? 'drawer' : 'wide'),
          open: () => drawerOpen(),
          sentinel: () => !!(history.state && history.state[SENTINEL] === 1),
        }
      },
    }
  },
})
