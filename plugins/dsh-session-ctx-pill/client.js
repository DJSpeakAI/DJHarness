/**
 * 会话行上下文百分比（Client 半）—— little DJ task189 的移植：
 *
 *   [默认工作区]
 *   ● 在对话中加上上下文百分比     42%  刚刚
 *
 * 位置：`sidebar.session.row.trailing`（行内、时间标签之后、置顶图标之前），
 *       inline 槽，不撑开行高。数据：`/session-ctx-api/state` 20s 轮询 + 页面
 *       重新可见时立刻补一次（共享 store，N 行只发一份请求）。
 * 分级：≤50% 常规灰；50~80% 琥珀；>80% 红。缺源（还没有任何一次请求）不出胶囊。
 *
 * 另外给输入框底下那颗原生「上下文已用 N%」圆环按钮的百分比数字刷成黄色
 * （灰色看不清、主人要求黄色）：结构性选择器，不写哈希类名、不写本地化文案——
 * 只认「带 popup 的按钮 → 里面是圆形进度条 svg → 数字 span」这个形状。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-ctx-pill',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect

    const POLL_MS = 20000

    // ────────────────── 共享轮询 store ──────────────────
    const store = { map: null, subs: new Set(), timer: null, inflight: false }

    function notify() {
      for (const fn of store.subs) fn(store.map)
    }

    async function loadOnce() {
      if (store.inflight) return
      store.inflight = true
      try {
        const res = await fetch('/session-ctx-api/state', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          credentials: 'same-origin',
        })
        if (!res.ok) return
        const body = await res.json()
        if (body && body.ok && body.value && body.value.map) {
          store.map = body.value.map
          notify()
        }
      } catch {
        /* 失败保旧值：下轮再试，界面不闪 */
      } finally {
        store.inflight = false
      }
    }

    function ensureStore() {
      if (store.timer) return
      void loadOnce()
      store.timer = window.setInterval(() => {
        if (!document.hidden) void loadOnce()
      }, POLL_MS)
      store.onVis = () => {
        if (!document.hidden) void loadOnce()
      }
      document.addEventListener('visibilitychange', store.onVis)
    }

    function useCtxMap() {
      const [map, setMap] = useState(store.map)
      useEffect(() => {
        ensureStore()
        const fn = (next) => setMap(next)
        store.subs.add(fn)
        if (store.map) setMap(store.map)
        return () => {
          store.subs.delete(fn)
        }
      }, [])
      return map
    }

    // ────────────────── 格式化 ──────────────────
    function fmtTok(n) {
      const v = Number(n) || 0
      if (v >= 1000000) return (v / 1000000).toFixed(v >= 10000000 ? 0 : 1) + 'M'
      if (v >= 1000) return (v / 1000).toFixed(v >= 100000 ? 0 : 1) + 'K'
      return String(v)
    }

    function level(pct) {
      if (pct > 80) return 'danger'
      if (pct > 50) return 'warn'
      return 'ok'
    }

    const COLORS = {
      ok: { fg: 'var(--dsw-alias-label-tertiary)', bd: 'var(--dsw-alias-border-l1)' },
      warn: { fg: '#d8a13a', bd: 'rgba(216,161,58,.45)' },
      danger: { fg: '#e0533d', bd: 'rgba(224,83,61,.5)' },
    }

    function CtxPill({ sessionId }) {
      const map = useCtxMap()
      const rec = map && map[sessionId]
      if (!rec || !(rec.win > 0)) return null
      const pct = Number(rec.pct) || 0
      const lv = level(pct)
      const c = COLORS[lv]
      return h(
        'span',
        {
          'data-ctx-pill': '1',
          'data-ctx-pct': String(Math.round(pct)),
          title:
            '上下文 ' + pct.toFixed(1) + '%（' + fmtTok(rec.used) + ' / ' + fmtTok(rec.win) + ' tokens）' +
            ' · 口径：最近一次请求实际读入 ÷ 该会话模型窗口 · 50% 起变黄、80% 起变红（80% 就是自动压缩线）· 20s 刷新',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
            height: 14,
            marginLeft: 4,
            padding: '0 4px',
            borderRadius: 99,
            border: '1px solid ' + c.bd,
            color: c.fg,
            fontSize: 10,
            lineHeight: '1',
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: 0,
            cursor: 'default',
            userSelect: 'none',
          },
        },
        Math.round(pct) + '%',
      )
    }

    // 输入框底下那颗「上下文已用 N%」按钮：<button aria-haspopup="dialog">
    //   <svg><circle 轨道/><circle 进度 stroke-dasharray=…/></svg><span>5%</span>
    // 圆环本身保持原生配色，只把数字染成黄色。
    const RING_CSS =
      'button[aria-haspopup="dialog"]:has(> svg > circle[stroke-dasharray]) > span{color:#f2c94c!important}';

    return {
      inject: ['slots'],
      apply(ctx) {
        // 官方规范：factory 级共享 store 的轮询也必须挂 ctx.effect，HMR 重跑才不叠
        ctx.effect(
          () => () => {
            if (store.timer) {
              window.clearInterval(store.timer)
              store.timer = 0
            }
            if (store.onVis) {
              document.removeEventListener('visibilitychange', store.onVis)
              store.onVis = null
            }
          },
          'session-ctx-pill: store poll timer + visibilitychange',
        )
        if (typeof document !== 'undefined') {
          const tag = document.createElement('style');
          tag.dataset.plugin = '@local/dsh-session-ctx-pill';
          tag.dataset.pluginCss = 'ctx-ring-yellow';
          tag.textContent = RING_CSS;
          document.head.appendChild(tag);
          ctx.effect(() => () => {
            tag.remove();
          }, 'session-ctx-pill: ring percent color')
        }
        ctx.slots.inject('sidebar.session.row.trailing', () =>
          ctx.slots.register(
            { name: 'sidebar.session.row.trailing', id: 'session-ctx-pill', order: 5 },
            CtxPill,
          ),
        )
      },
    }
  },
})
