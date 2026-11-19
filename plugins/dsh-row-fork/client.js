/**
 * 会话行「分叉」快捷按钮（Client 半）
 *
 * 主人 2026-11-19 01:22 的需求（录屏原话）：
 *   「我鼠标移动到项目上面…这不是有三个嘛，然后这个是更多，把这个分叉会话放到这个
 *     更多的这个按钮上面，这个更多的按钮往左边移」
 *
 * 左栏会话行 hover 出来的一排按钮官方顺序是：［⋯ 更多］［归档］［置顶］
 * （DOM：⋯ 按钮 + rowQuickActions 槽里的 archive(order 100) / pin(order 200)）。
 * 本插件往 `sidebar.workspaces.session.row.action` 槽里插一颗 order=50 的按钮，
 * 于是视觉顺序变成：
 *
 *     ［⋯ 更多］［⑂ 分叉］［归档］［置顶］
 *
 * ——分叉紧贴在「更多」右边，更多因此往左让出一格。点这颗按钮＝官方那个
 * 「分叉会话」菜单项（Ctrl+S 同一个动作），一次点击就分出新会话并打开它。
 *
 * 为什么不用菜单：主人 2026-11-18 明确「分叉会话用得非常非常多」，多一次点开菜单
 * 就是每天几十次的多余操作。
 *
 * 图标是自己画的 SVG（16×16 描边 + 两个圆点），不引官方图标表：本地插件没有
 * primitives 的稳定 import 口，且 hash 类名不能写死（教训 18）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-row-fork',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const TOAST_ATTR = 'data-djh-row-fork-toast'

    /** 小浮条提示（分叉失败/进行中）：全站只留一个，2.4s 自消。 */
    let toastTimer = 0
    function toast(text) {
      let el = document.querySelector(`[${TOAST_ATTR}]`)
      if (!el) {
        el = document.createElement('div')
        el.setAttribute(TOAST_ATTR, '')
        el.style.cssText = [
          'position:fixed',
          'left:50%',
          'bottom:96px',
          'transform:translateX(-50%)',
          'z-index:2147483000',
          'padding:6px 12px',
          'border-radius:999px',
          'font-size:12px',
          'line-height:18px',
          'color:#fff',
          'background:rgba(32,32,36,.92)',
          'box-shadow:0 4px 16px rgba(0,0,0,.35)',
          'pointer-events:none',
          'white-space:nowrap',
        ].join(';')
        document.body.appendChild(el)
      }
      el.textContent = text
      el.style.opacity = '1'
      if (toastTimer) window.clearTimeout(toastTimer)
      toastTimer = window.setTimeout(() => {
        el.style.opacity = '0'
        el.style.transition = 'opacity .3s'
        toastTimer = window.setTimeout(() => el.remove(), 320)
      }, 2400)
    }

    /** 分叉图标：一条主干分两支，支头两个实心点（16×16，14px 渲染）。 */
    function ForkIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M8 14.1V9.4',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M8 9.4 4.2 5.4',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M8 9.4 11.8 5.4',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 3.6, cy: 4.4, r: 1.5, fill: 'currentColor' }),
        h('circle', { cx: 12.4, cy: 4.4, r: 1.5, fill: 'currentColor' }),
        h('circle', { cx: 8, cy: 14.2, r: 1.3, fill: 'currentColor' }),
      )
    }

    /** 一行的分叉按钮；forkSession 里的「还没答完」这类错误翻成人话。 */
    function makeForkButton(uiWorkspace) {
      return function ForkRowButton({ sessionId }) {
        const [busy, setBusy] = React.useState(false)
        const busyRef = React.useRef(false)

        const onClick = async (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (busyRef.current || !sessionId) return
          busyRef.current = true
          setBusy(true)
          try {
            let childId = await uiWorkspace.forkSession(sessionId)
            if (childId) {
              try {
                await uiWorkspace.openSession(childId)
              } catch (openErr) {
                console.warn('[row-fork] open failed', openErr)
                toast('已分叉，但打开新会话失败')
              }
            }
          } catch (err) {
            const msg = String((err && err.message) || err || '')
            let friendly = '分叉失败'
            if (/migration-required/.test(msg)) friendly = '这条会话要打开一次才能分叉'
            else if (/no completed turn|fork-unavailable|has no completed/i.test(msg)) friendly = '这轮还没答完，分叉不了'
            console.warn('[row-fork] fork failed', err)
            toast(friendly)
          } finally {
            busyRef.current = false
            setBusy(false)
          }
        }

        return h(
          'button',
          {
            type: 'button',
            className: 'djh-row-fork-btn',
            'data-djh-row-fork': '',
            'aria-label': '分叉会话',
            title: '分叉会话',
            'data-busy': busy ? '' : undefined,
            onPointerDown: (event) => event.stopPropagation(),
            onClick,
          },
          h(ForkIcon, null),
        )
      }
    }

    return {
      inject: ['slots', 'uiWorkspace'],
      apply(ctx) {
        // 按钮外观对齐官方 iconButton（24×24、透明底、悬停淡底）：本地插件不写
        // 官方 hash 类名，自带一条最小 CSS，只作用于自己的按钮。
        const css = [
          '.djh-row-fork-btn{width:24px;height:24px;display:inline-flex;align-items:center;',
          'justify-content:center;padding:0;border:0;border-radius:6px;background:transparent;',
          'color:inherit;cursor:pointer;opacity:.82;flex:0 0 auto}',
          '.djh-row-fork-btn:hover{background:rgba(127,127,127,.18);opacity:1}',
          '.djh-row-fork-btn[data-busy]{opacity:.45;cursor:default}',
        ].join('')
        const styleTag = document.createElement('style')
        styleTag.dataset.plugin = '@local/dsh-row-fork'
        styleTag.textContent = css
        document.head.appendChild(styleTag)
        ctx.effect(() => () => {
          styleTag.remove()
          if (toastTimer) window.clearTimeout(toastTimer)
          toastTimer = 0
          const el = document.querySelector(`[${TOAST_ATTR}]`)
          if (el) el.remove()
          delete window.__dshRowFork
        }, 'row-fork: style + toast cleanup')

        // order 50 < archive(100)：排在「归档」前面，即紧贴⋯更多右边。
        ctx.slots.inject('sidebar.workspaces.session.row.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.row.action',
              id: 'row-fork',
              order: 50,
            },
            makeForkButton(ctx.uiWorkspace),
          ),
        )

        window.__dshRowFork = { toast }
      },
    }
  },
})
