/**
 * @local/dsh-butler-rotate（Client 半）—— 大管家换脑后的页面侧收尾
 *
 * 宿主插件（index.js）换完脑会留下状态：新 butler 会话 id + 上一条被归档的老会话 id。
 * 这里每 5 秒读一次 `/butler-rotate-api/state`：
 *   1) 把新会话标成「大管家」（window.__dshButlerMode.mark，⭐ 徽章/桥 whoami 名单都认它），
 *      把老会话从名单里拿掉；
 *   2) 如果页面当前正停在刚被归档的老会话上，自动跳到新会话（否则主人在已归档会话里
 *      说话会被 agent/pre-step 的归档门禁拒掉）。
 *
 * 纯被动探测，不注入任何 DOM。测试模式（state.testMode=true）下什么都不做，
 * 防止验证时误动主人的页面。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-butler-rotate',
  factory() {
    const STATE_ROUTE = '/butler-rotate-api/state'
    const POLL_MS = 5000
    /** 换脑过去这么久之后，页面不再自动跳（防重启后乱跳）。 */
    const AUTO_OPEN_WINDOW_MS = 10 * 60 * 1000

    function bare(id) {
      return String(id || '').replace(/^session:/, '').replace(/^session-/, '')
    }

    function butlerMode() {
      return typeof window.__dshButlerMode === 'object' && window.__dshButlerMode !== null
        ? window.__dshButlerMode
        : null
    }

    /** 页面当前主视图的会话 id（与 orb-bridge client 同一判据）。 */
    function currentSessionId(ctx) {
      try {
        const snapshot = ctx.sessions.list.getSnapshot()
        const row = Object.values(snapshot.byId).find(
          (candidate) => (candidate.retainedBy && candidate.retainedBy.mainView ? candidate.retainedBy.mainView : 0) > 0,
        )
        return row ? String(row.id) : ''
      } catch {
        return ''
      }
    }

    async function fetchState() {
      try {
        const res = await fetch(STATE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          credentials: 'same-origin',
        })
        if (!res.ok) return null
        const body = await res.json()
        return body && body.ok && body.value ? body.value : null
      } catch {
        return null
      }
    }

    function tick(ctx) {
      const handled = { at: 0 }
      return async () => {
        const state = await fetchState()
        if (!state) return
        if (state.testMode) return // 测试换脑：不动主人的页面和 ⭐ 名单
        const mode = butlerMode()
        const last = state.lastRotation
        if (last && last.testMode === true) return // 最近一次是测试换脑：同样忽略
        if (mode) {
          if (state.butler) mode.mark(state.butler)
          if (last && last.oldSessionId) mode.unmark(last.oldSessionId)
        }
        if (!last || !last.at || !state.butler) return
        if (last.at <= handled.at) return
        if (Date.now() - last.at > AUTO_OPEN_WINDOW_MS) return
        handled.at = last.at
        const current = currentSessionId(ctx)
        const oldId = last.oldSessionId ? bare(last.oldSessionId) : ''
        if (current !== '' && bare(current) !== oldId) return
        const ui = ctx.get('uiWorkspace')
        if (ui && typeof ui.openSession === 'function') {
          try {
            ui.openSession(state.butler)
          } catch {
            /* 导航失败就算了，下一轮再试 */
          }
        }
      }
    }

    return {
      inject: ['sessions'],
      apply(ctx) {
        const run = tick(ctx)
        let timer = 0
        window.__dshButlerRotateLoaded = true
        ctx.effect(
          () => () => {
            delete window.__dshButlerRotateLoaded
          },
          'butler-rotate: debug marker',
        )
        const kick = setTimeout(() => {
          void run()
        }, 1500)
        timer = window.setInterval(() => {
          if (!document.hidden) void run()
        }, POLL_MS)
        const onVisible = () => {
          if (!document.hidden) void run()
        }
        document.addEventListener('visibilitychange', onVisible)
        ctx.effect(
          () => () => {
            window.clearInterval(timer)
            clearTimeout(kick)
            document.removeEventListener('visibilitychange', onVisible)
          },
          'butler-rotate: state poller',
        )
      },
    }
  },
})
