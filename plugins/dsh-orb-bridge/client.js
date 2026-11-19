/**
 * @local/dsh-orb-bridge（Client 半）
 *
 * 一件事：大管家会话登记——桥需要知道「大管家会话」id 才能把星闪球的话投进去。
 * 会话 id 名单在 localStorage（dsh-butler-mode 维护），这里盯当前打开的会话，
 * 一旦它在大管家名单里 → POST /whoami 登记（只在变化时上报）。
 *
 * 2026-11-18 v0.150：原来的「设置页 → 提示词」已下线——世界观/角色卡合并进 Agent 预设的 persona，
 * 不再单独维护一份文本（避免两处真相打架）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-orb-bridge',
  factory(require) {
    const BRIDGE = 'http://127.0.0.1:9780'
    const STORE_KEY = 'dsh-butler-mode:butlers'
    const POLL_MS = 4000

    function butlerIds() {
      try {
        const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]')
        return raw instanceof Array ? new Set(raw.filter((x) => typeof x === 'string').map((x) => String(x))) : new Set()
      } catch {
        return new Set()
      }
    }

    function bareId(id) {
      return String(id || '').replace(/^session-/, '')
    }

    return {
      inject: ['sessions', 'slots'],
      apply(ctx) {
        let lastReported = ''
        async function tick() {
          try {
            const snapshot = ctx.sessions.list.getSnapshot()
            const current = Object.values(snapshot.byId).find((row) => (row.retainedBy.mainView ?? 0) > 0)
            if (!current) return
            const ids = butlerIds()
            const isButler = ids.has(bareId(current.id)) || ids.has(String(current.id)) || ids.has(`session-${bareId(current.id)}`)
            const toReport = isButler ? String(current.id) : ''
            if (toReport && toReport === lastReported) return
            if (!toReport) return // 不上报清空：主人切走页面时球仍指向上一个大管家
            lastReported = toReport
            await fetch(`${BRIDGE}/whoami`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: toReport }),
            })
          } catch {
            /* 桥不在就算了，下一轮再试 */
          }
        }
        void tick()
        const timer = window.setInterval(() => {
          if (!document.hidden) void tick()
        }, POLL_MS)
        ctx.effect(() => () => window.clearInterval(timer), 'orb-bridge: whoami poller')


      },
    }
  },
})
