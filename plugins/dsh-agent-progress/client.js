/**
 * 并行子代理进度面板（Client 半）—— 学 Cursor 的多 agent 作战屏：
 * 每个 lead/会话一行卡片，下面的队友/子代理实时显示 running/inactive/provisioning/failed，
 * 2s 轮询（面板不可见时暂停）。入口在「DJH 插件」专区的卡片（plugin-hub 里加）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-agent-progress',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect

    const PANEL_ID = 'agent-progress'
    const POLL_MS = 2000

    /* 雷达/信号图标 */
    function RadarIcon({ size }) {
      const s = size || 20
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: s, height: s, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'aria-hidden': 'true' },
        h('circle', { cx: 12, cy: 12, r: 2.2, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M12 6.5a5.5 5.5 0 0 1 5.5 5.5M12 2.5a9.5 9.5 0 0 1 9.5 9.5' }),
        h('path', { d: 'M12 6.5A5.5 5.5 0 0 0 6.5 12M12 2.5A9.5 9.5 0 0 0 2.5 12' }),
      )
    }

    const STATUS_COLOR = {
      running: '#34c759',
      inactive: '#8e8e93',
      provisioning: '#d8a13a',
      failed: '#e0533d',
    }
    const STATUS_TEXT = {
      running: '跑着',
      inactive: '待命',
      provisioning: '创建中',
      failed: '失败',
    }

    async function loadState() {
      const res = await fetch('/agent-progress-api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        credentials: 'same-origin',
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const body = await res.json()
      if (!body || body.ok !== true) throw new Error(body && body.error ? body.error : '读取失败')
      return body.value || { roots: [] }
    }

    function StatusDot({ status }) {
      const color = STATUS_COLOR[status] || STATUS_COLOR.inactive
      return h(
        'span',
        {
          'data-agent-status': status,
          title: STATUS_TEXT[status] || status,
          style: {
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: color,
            flexShrink: 0,
            boxShadow: status === 'running' ? '0 0 0 0 ' + color : 'none',
            animation: status === 'running' ? 'djh-ap-pulse 1.6s infinite' : 'none',
          },
        },
      )
    }

    function shortId(id) {
      return typeof id === 'string' && id.length > 14 ? id.slice(0, 12) + '…' : String(id || '')
    }

    function AgentRow({ row }) {
      const name = row.name || row.title || shortId(row.id)
      return h(
        'div',
        {
          'data-agent-row': name,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '9px 14px',
            borderRadius: 10,
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l1)',
            marginBottom: 8,
          },
        },
        h(StatusDot, { status: row.status }),
        h(
          'span',
          { style: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: name + ' · ' + shortId(row.id) },
          name,
        ),
        row.role && row.role !== 'teammate'
          ? h('span', { style: { fontSize: 11, padding: '1px 7px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)', flexShrink: 0 } }, row.role === 'lead' ? 'lead' : row.role)
          : null,
        row.error
          ? h('span', { style: { fontSize: 12, color: '#e0533d', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1 }, title: row.error }, row.error)
          : null,
        h(
          'span',
          { style: { marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', flexShrink: 0, display: 'inline-flex', gap: 8, alignItems: 'center' } },
          row.model ? h('span', null, row.model) : null,
          h('span', { style: { color: STATUS_COLOR[row.status] || undefined, fontWeight: 600 } }, STATUS_TEXT[row.status] || row.status),
        ),
      )
    }

    function TeamCard({ root }) {
      const kids = root.children || []
      const running = kids.filter((k) => k.status === 'running').length
      return h(
        'div',
        {
          'data-agent-team': root.title || root.id,
          style: {
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 14,
            padding: 14,
            marginBottom: 14,
            background: 'var(--dsw-alias-bg-base)',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: kids.length ? 10 : 0 } },
          h(StatusDot, { status: root.status }),
          h('span', { style: { fontSize: 15, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: root.title || root.id }, root.title || shortId(root.id)),
          h(
            'span',
            { style: { marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', flexShrink: 0 } },
            kids.length ? kids.length + ' 个下线 · ' + running + ' 在跑 · ' : '',
            root.model || '',
          ),
        ),
        kids.map((k, i) => h(AgentRow, { key: k.id || i, row: k })),
      )
    }

    function ProgressPage(props) {
      const onBack = (props && props.onBack) || null
      const [state, setState] = useState(null)
      const [error, setError] = useState('')

      useEffect(() => {
        let alive = true
        let timer = null
        const tick = () => {
          if (document.hidden) return
          loadState()
            .then((v) => {
              if (!alive) return
              setError('')
              setState(v)
            })
            .catch((e) => alive && setError(String(e && e.message ? e.message : e)))
        }
        tick()
        timer = window.setInterval(tick, POLL_MS)
        const onVis = () => {
          if (!document.hidden) tick()
        }
        document.addEventListener('visibilitychange', onVis)
        return () => {
          alive = false
          if (timer) window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVis)
        }
      }, [])

      const roots = (state && state.roots) || []
      const allKids = roots.reduce((n, r) => n + (r.children ? r.children.length : 0), 0)
      const running = roots.reduce(
        (n, r) => n + (r.status === 'running' ? 1 : 0) + (r.children || []).filter((k) => k.status === 'running').length,
        0,
      )

      const header = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 } },
        onBack
          ? h(
              'button',
              {
                onClick: onBack,
                title: '返回插件专区',
                'aria-label': '返回插件专区',
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  cursor: 'pointer',
                  flexShrink: 0,
                  padding: 0,
                },
              },
              h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, h('path', { d: 'M15 5l-7 7 7 7' })),
            )
          : null,
        h('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-primary)' } }, h(RadarIcon, { size: 22 })),
        h('div', { style: { fontSize: 20, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.2 } }, '并行 agent 进度'),
        h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginLeft: 2 } }, state ? roots.length + ' 个会话 · ' + allKids + ' 个下线 · ' + running + ' 在跑 · 2s 刷新' : '加载中…'),
      )

      let body
      if (error) {
        body = h('div', { style: { padding: '40px 0', textAlign: 'center', color: '#e0533d' } }, '读取失败：' + error)
      } else if (!state) {
        body = h('div', { style: { padding: '40px 0', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)' } }, '正在加载…')
      } else if (!roots.length) {
        body = h('div', { style: { padding: '40px 0', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)' } }, '现在没有活着的 agent 会话。开一个会话、派个子代理或组个队，这里就会亮起来。')
      } else {
        body = roots.map((r, i) => h(TeamCard, { key: r.id || i, root: r }))
      }

      return h(
        'div',
        { style: { width: '100%', minWidth: 0, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
        h(
          'div',
          { style: { flex: 1, minHeight: 0, overflowY: 'auto', scrollbarGutter: 'stable' } },
          h('div', { style: { maxWidth: 860, margin: '0 auto', padding: '22px 20px 48px' } }, header, body),
        ),
      )
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        /* 跑动的小绿点脉冲动画（幂等：带 data 标记） */
        if (!document.getElementById('djh-agent-progress-style')) {
          const style = document.createElement('style')
          style.id = 'djh-agent-progress-style'
          style.textContent =
            '@keyframes djh-ap-pulse{0%{box-shadow:0 0 0 0 rgba(52,199,89,.5)}70%{box-shadow:0 0 0 7px rgba(52,199,89,0)}100%{box-shadow:0 0 0 0 rgba(52,199,89,0)}}'
          document.head.appendChild(style)
          ctx.effect(() => () => style.remove(), 'agent-progress: pulse style')
        }

        ctx.slots.inject(
          'main',
          () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID }, () =>
              h(ProgressPage, {
                onBack: () => {
                  try {
                    ctx.layout && ctx.layout.selectPanel('djh-plugins')
                  } catch {}
                },
              }),
            ),
          'agent-progress: main panel',
        )
      },
    }
  },
})
