/**
 * 休息模式（Client 半）—— 输入框工具行左侧那颗 ☾ 胶囊：
 *
 *   [☾ 在线]     点击 → 休息中（AI 自主决断，不再来问主人）
 *   [☾ 休息中]   点击 → 在线（AI 不懂就问）
 *
 * 真相在宿主（/rest-mode-api），这里只做显示 + 切换；宿主把它写进系统提示词，
 * 所以点完**下一轮**就生效。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-rest-mode',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    // ────────────────── 共享 store（多挂载点只发一份请求） ──────────────────
    const store = { state: null, subs: new Set(), timer: null }

    function notify() {
      for (const fn of store.subs) fn(store.state)
    }

    function apply(next) {
      store.state = next
      notify()
    }

    async function call(endpoint, payload) {
      const res = await fetch('/rest-mode-api/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
        credentials: 'same-origin',
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const body = await res.json()
      if (!body || !body.ok || !body.value) {
        throw new Error((body && body.error && body.error.message) || '请求失败')
      }
      return body.value
    }

    async function loadOnce() {
      try {
        apply(await call('state'))
      } catch {
        /* 失败保旧值：界面继续显示上一次的状态 */
      }
    }

    function ensureStore() {
      if (store.timer) return
      void loadOnce()
      store.timer = window.setInterval(() => {
        if (!document.hidden) void loadOnce()
      }, 15000)
    }

    function useRestState() {
      const [state, setState] = useState(store.state)
      useEffect(() => {
        ensureStore()
        const fn = (next) => setState(next)
        store.subs.add(fn)
        if (store.state) setState(store.state)
        return () => {
          store.subs.delete(fn)
        }
      }, [])
      return state
    }

    // ────────────────── 按钮 ──────────────────
    function RestButton() {
      const state = useRestState()
      const [busy, setBusy] = useState(false)
      const [hover, setHover] = useState(false)
      const on = !!(state && state.on)
      const unknown = state == null

      async function toggle() {
        if (busy) return
        setBusy(true)
        try {
          apply(await call('toggle', { on: !on }))
        } catch {
          /* 失败就保持原状，下一次轮询会纠正 */
        } finally {
          setBusy(false)
        }
      }

      const label = unknown ? '…' : on ? '休息中' : '在线'
      const title = unknown
        ? '休息模式状态未知'
        : on
          ? '休息中：AI 自主决断，不再来问你（点击恢复在线）'
          : '在线：AI 不懂就问你。点击进入休息模式（AI 自己决断）'

      // 休息中 = 暖黄警示（模仿 little DJ 的 .syspill.warn：琥珀字 + 琥珀描边 + 淡琥珀底）。
      // 颜色全部从主题 token 派生：暗色下提亮、亮色下压深，两边对比度都够。
      const amber = 'var(--dsw-alias-state-warn-primary)'
      const amberText = 'color-mix(in srgb, ' + amber + ' 72%, var(--dsw-alias-label-primary))'
      const amberBorder = 'color-mix(in srgb, ' + amber + ' 55%, transparent)'
      const amberBg = 'color-mix(in srgb, ' + amber + ' ' + (hover ? 26 : 14) + '%, transparent)'

      return h(
        'button',
        {
          type: 'button',
          title,
          'aria-label': title,
          'aria-pressed': on,
          'data-rest-mode': on ? 'on' : 'off',
          disabled: busy || unknown,
          onClick: toggle,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            height: 28,
            padding: '0 8px',
            borderRadius: 8,
            border: '1px solid ' + (on ? amberBorder : 'var(--dsw-alias-border-l1)'),
            background: on
              ? amberBg
              : hover
                ? 'var(--dsw-alias-bg-layer-2)'
                : 'transparent',
            color: on ? amberText : 'var(--dsw-alias-label-secondary)',
            cursor: busy || unknown ? 'default' : 'pointer',
            font: 'inherit',
            fontSize: 12,
            lineHeight: 1,
            fontWeight: on ? 600 : 'inherit',
            whiteSpace: 'nowrap',
            opacity: busy ? 0.6 : 1,
          },
        },
        h('span', { 'aria-hidden': true, style: { fontSize: 13 } }, on ? '☾' : '☀'),
        h('span', null, label),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 官方规范：factory 级共享资源也必须挂 ctx.effect，HMR 重跑才不叠轮询
        ctx.effect(
          () => () => {
            if (store.timer) {
              window.clearInterval(store.timer)
              store.timer = 0
            }
          },
          'rest-mode: store poll timer',
        )
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'rest-mode', order: 40 },
            () => h(RestButton, null),
          ),
        )
      },
    }
  },
})
