/**
 * 插件专区（Client 半）—— 左栏「DJH 插件」入口 + 中央专区页。
 *
 * 官方「插件」页是插件市场（本地自研插件不在市场里 → 一直读不出内容），
 * 这里把官方那颗导航按钮藏掉，换成 DJ 自己的插件专区：
 *   ① 截图标注（Alt+A，微信截图式：红椭圆 + 另存为）
 *   ② AI 新闻（点开跳新闻面板，导航入口收编进专区）
 *   ③ 常驻插件清单（无页面的本地插件也列出来）
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-hub',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect

    const PANEL_ID = 'djh-plugins'

    async function loadPlugins() {
      const res = await fetch('/djh-plugins-api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        credentials: 'same-origin',
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const body = await res.json()
      if (!body || body.ok !== true) throw new Error('读取失败')
      return body.value || { items: [] }
    }

    /* 剪刀+框 图标（截图） */
    function ShotIcon({ size }) {
      const s = size || 22
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: s, height: s, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v6' }),
        h('rect', { x: 3, y: 3, width: 6, height: 5, rx: 1.5 }),
        h('rect', { x: 15, y: 3, width: 6, height: 5, rx: 1.5 }),
        h('ellipse', { cx: 12, cy: 16, rx: 6, ry: 4, stroke: '#ff2d2d' }),
      )
    }

    /* 雷达图标（并行 agent 进度） */
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

    /* 插头图标（专区） */
    function HubIcon({ size }) {
      const s = size || 22
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: s, height: s, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M9 3v5M15 3v5' }),
        h('path', { d: 'M7 8h10v3a5 5 0 0 1-10 0V8Z' }),
        h('path', { d: 'M12 16v5' }),
      )
    }

    function HubPage(props) {
      const onBack = (props && props.onBack) || null
      const [items, setItems] = useState(null)

      useEffect(() => {
        let alive = true
        loadPlugins()
          .then((v) => alive && setItems(v.items || []))
          .catch(() => alive && setItems([]))
        return () => {
          alive = false
        }
      }, [])

      const cardStyle = {
        display: 'block',
        textAlign: 'left',
        width: '100%',
        padding: '18px 20px',
        borderRadius: 14,
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        cursor: 'pointer',
        marginBottom: 12,
        color: 'inherit',
      }

      const startShot = () => {
        try {
          if (window.__DSH_SCREENSHOT_START__) window.__DSH_SCREENSHOT_START__()
        } catch {}
      }

      const openNews = () => {
        try {
          ctxLayoutSelectPanel('ai-news')
        } catch {}
      }
      /* 闭包里拿 ctx：组件渲染在 apply 的 ctx 作用域内（见下方 HubPageWithContext） */

      const header = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 } },
        onBack
          ? h(
              'button',
              {
                onClick: onBack,
                title: '返回对话',
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
        h('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-primary)' } }, h(HubIcon, { size: 22 })),
        h('div', { style: { fontSize: 20, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.2 } }, 'DJH 插件'),
        h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginLeft: 2 } }, '我的插件都在这'),
      )

      const shotCard = h(
        'button',
        { style: cardStyle, onClick: startShot },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 } },
          h('span', { style: { color: '#ff2d2d', display: 'inline-flex' } }, h(ShotIcon, { size: 24 })),
          h('span', { style: { fontSize: 16, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' } }, '截图标注'),
          h('span', { style: { marginLeft: 'auto', fontSize: 11, padding: '2px 8px', borderRadius: 6, background: 'var(--dsw-alias-button-floating-fill)', color: 'var(--dsw-alias-bg-base)', fontWeight: 600 } }, '第 1 号插件'),
        ),
        h('div', { style: { fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } },
          '按 ', h('kbd', { style: { padding: '1px 6px', borderRadius: 4, border: '1px solid var(--dsw-alias-border-l2)', fontFamily: 'inherit' } }, 'Alt+A'), ' 或点这张卡片：抓整屏 → 拖框选区 → 选区下方工具条只有两个工具：⭕ 圈圈（画红椭圆，可多个）和 💾 另存为（弹保存对话框自己选位置；选区里双击=复制进剪贴板，Ctrl+V 直接粘贴）。'),
        h('div', { style: { marginTop: 10 } },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, padding: '7px 16px', borderRadius: 10, background: '#ff2d2d', color: '#fff' } }, '📷 开始截图 (Alt+A)'),
        ),
      )

      const newsCard = h(
        'button',
        { style: cardStyle, onClick: openNews },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 } },
          h('span', { style: { color: 'var(--dsw-alias-label-primary)', display: 'inline-flex' } }, h(HubIcon, { size: 20 })),
          h('span', { style: { fontSize: 16, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' } }, 'AI 新闻'),
          h('span', { style: { marginLeft: 'auto', fontSize: 11, padding: '2px 8px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' } }, '每天 9:00 更新'),
        ),
        h('div', { style: { fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } },
          '最近 7 天的 AI 圈新闻（中文摘要 + 来源链接，可一键追问）。入口已收进插件专区，点这里打开。'),
      )

      const progressCard = h(
        'button',
        { style: cardStyle, onClick: () => ctxLayoutSelectPanel('agent-progress') },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 } },
          h('span', { style: { color: '#34c759', display: 'inline-flex' } }, h(RadarIcon, { size: 20 })),
          h('span', { style: { fontSize: 16, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' } }, '并行 agent 进度'),
          h('span', { style: { marginLeft: 'auto', fontSize: 11, padding: '2px 8px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' } }, '2s 实时'),
        ),
        h('div', { style: { fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } },
          '所有会话/队友/子代理的实时作战屏：谁在跑、谁待命、谁失败，绿点闪烁=正在干活。'),
      )

      return h(
        'div',
        { style: { width: '100%', minWidth: 0, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
        h(
          'div',
          { style: { flex: 1, minHeight: 0, overflowY: 'auto', scrollbarGutter: 'stable' } },
          h('div', { style: { maxWidth: 860, margin: '0 auto', padding: '22px 20px 48px' } },
            header,
            shotCard,
            newsCard,
            progressCard,
            h('div', { style: { marginTop: 20, marginBottom: 8, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } },
              '常驻插件（后台默默工作的，没有页面）'),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
              (items || []).map((p) =>
                h(
                  'span',
                  {
                    key: p.id,
                    title: p.description,
                    style: {
                      fontSize: 12,
                      padding: '4px 10px',
                      borderRadius: 8,
                      background: 'var(--dsw-alias-bg-layer-1)',
                      border: '1px solid var(--dsw-alias-border-l1)',
                      color: 'var(--dsw-alias-label-secondary)',
                    },
                  },
                  p.id + (p.version ? ' · ' + p.version : ''),
                ),
              ),
            ),
          ),
        ),
      )
    }

    /* HubPage 需要拿 ctx.layout.selectPanel —— 用一个 wrapper 把 ctx 塞进 props */
    let selectPanelFn = null
    function ctxLayoutSelectPanel(id) {
      if (selectPanelFn) selectPanelFn(id)
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        selectPanelFn = (id) => {
          try {
            ctx.layout.selectPanel(id)
          } catch {}
        }

        /* 藏掉官方「插件」导航按钮（插件市场页，本地插件不在市场里，一直读不出） */
        const style = document.createElement('style')
        style.dataset.plugin = '@local/dsh-plugin-hub'
        style.textContent = 'nav[class*="_panelList"]>button:nth-of-type(1){display:none!important}'
        document.head.appendChild(style)

        /* 中央专区页 */
        ctx.slots.inject(
          'main',
          () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID }, () =>
              h(HubPage, {
                onBack: () => {
                  try {
                    ctx.layout.selectPanel(null)
                  } catch {}
                },
              }),
            ),
        )

        /* 左栏导航行：排在「自动化任务」(order 10) 后面 */
        ctx.slots.inject(
          'sidebar.panellist',
          () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 11,
                label: () => 'DJH 插件',
              },
              () => h(HubIcon, { size: 16 }),
            ),
        )

        ctx.effect(() => () => {
          style.remove()
          selectPanelFn = null
        })
      },
    }
  },
})
