/**
 * AI 新闻（Client 半）—— 左栏「AI 新闻」入口 + 中央新闻面板。
 *
 * 数据来自 Host 半 /ai-news-api（读 apps/ai-news/news.json，每天 09:00 自动更新）。
 * 面板：顶部日期页签（最近 7 天）→ 新闻列表（标签、标题、一句话中文摘要、来源）。
 * 点标题开原文；点「追问」带着这条新闻开一个新会话展开聊。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-ai-news',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect

    const PANEL_ID = 'ai-news'

    async function loadNews() {
      const res = await fetch('/ai-news-api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        credentials: 'same-origin',
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const body = await res.json()
      if (!body || body.ok !== true) throw new Error('读取失败')
      return body.value || { days: [] }
    }

    function fmtDate(iso, todayStr) {
      if (!iso) return ''
      if (iso === todayStr) return '今天'
      const y = parseInt(todayStr.slice(0, 4), 10)
      const m = parseInt(todayStr.slice(5, 7), 10)
      const d = parseInt(todayStr.slice(8, 10), 10)
      const yesterday = new Date(y, m - 1, d - 1)
      const p = (n) => String(n).padStart(2, '0')
      const yStr = yesterday.getFullYear() + '-' + p(yesterday.getMonth() + 1) + '-' + p(yesterday.getDate())
      if (iso === yStr) return '昨天'
      return iso.slice(5).replace('-', ' 月 ') + ' 日'
    }

    const TAG_COLORS = {
      模型: '#7aa2f7',
      国内: '#e0af68',
      公司: '#bb9af7',
      产品: '#7dcfff',
      芯片: '#f7768e',
      研究: '#9ece6a',
      安全: '#ff9e64',
      其他: '#565f89',
    }

    /* 返回箭头（矢量，不依赖字体） */
    function BackIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M15 5l-7 7 7 7' }),
      )
    }

    /* 报纸图标（替代 📰 emoji，跨平台一致且能跟主题色走） */
    function NewsIcon({ size }) {
      const s = size || 20
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: s, height: s, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h10A1.5 1.5 0 0 1 17 5.5V8h1.5A1.5 1.5 0 0 1 20 9.5v8A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-12Z' }),
        h('path', { d: 'M7 8h6M7 11h6M7 14h6M17 11v5' }),
      )
    }

    const backBtnStyle = {
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
    }

    /* 宝藏雷达标签色（新星/Agent/MCP/市场） */
    const REPO_TAG_COLORS = {
      精选: '#7aa2f7',
      新星: '#9ece6a',
      Agent: '#bb9af7',
      MCP: '#e0af68',
      市场: '#f7768e',
    }

    const VIEWS = [
      { key: 'news', label: '📰 新闻' },
      { key: 'repos', label: '💎 宝藏雷达' },
      { key: 'weekly', label: '📅 周报' },
    ]

    function NewsPanel(props) {
      const onBack = (props && props.onBack) || null
      const [view, setView] = useState('news')
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [selNews, setSelNews] = useState('')
      const [selRepos, setSelRepos] = useState('')

      useEffect(() => {
        let alive = true
        loadNews()
          .then((v) => {
            if (!alive) return
            setData(v)
            const nd = (v.news && v.news.days ? v.news.days : []).slice().sort((a, b) => (a.date < b.date ? 1 : -1))
            const rd = (v.repos && v.repos.days ? v.repos.days : []).slice().sort((a, b) => (a.date < b.date ? 1 : -1))
            if (nd.length) setSelNews(nd[0].date)
            if (rd.length) setSelRepos(rd[0].date)
            /* 没有新闻但有雷达时，默认落在雷达页签 */
            if (!nd.length && rd.length) setView('repos')
          })
          .catch((e) => alive && setError(String(e && e.message ? e.message : e)))
        return () => {
          alive = false
        }
      }, [])

      const now = new Date()
      const p = (n) => String(n).padStart(2, '0')
      const todayStr = now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate())

      /* 标题栏：返回钮 + 图标 + 标题 + 计数，全部排一行 */
      const header = (title, count) =>
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 } },
          onBack
            ? h(
                'button',
                {
                  onClick: onBack,
                  title: '返回插件页',
                  'aria-label': '返回插件页',
                  style: backBtnStyle,
                  onMouseEnter: (e) => {
                    e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2)'
                  },
                  onMouseLeave: (e) => {
                    e.currentTarget.style.background = 'transparent'
                  },
                },
                h(BackIcon),
              )
            : null,
          h('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-primary)' } }, h(NewsIcon, { size: 20 })),
          h('div', { style: { fontSize: 20, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.2 } }, title),
          count == null
            ? null
            : h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginLeft: 2 } }, '每天 9:00 更新 · ' + count + ' 条'),
        )

      const shell = (inner) =>
        h(
          'div',
          { style: { width: '100%', minWidth: 0, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
          h(
            'div',
            { style: { flex: 1, minHeight: 0, overflowY: 'auto', scrollbarGutter: 'stable' } },
            h('div', { style: { maxWidth: 860, margin: '0 auto', padding: '22px 20px 48px' } }, inner),
          ),
        )

      /* 三个顶层页签（新闻 / 宝藏雷达 / 周报） */
      const viewTabs = h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 6,
            marginBottom: 14,
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
            paddingBottom: 10,
            flexWrap: 'wrap',
          },
        },
        VIEWS.map((v) =>
          h(
            'button',
            {
              key: v.key,
              onClick: () => setView(v.key),
              style: {
                padding: '6px 14px',
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
                background: view === v.key ? 'var(--dsw-alias-button-floating-fill)' : 'transparent',
                color: view === v.key ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
                fontWeight: view === v.key ? 600 : 400,
              },
            },
            v.label,
          ),
        ),
      )

      if (error) {
        return shell(
          h(
            'div',
            { style: { color: 'var(--dsw-alias-label-secondary)' } },
            header('AI 新闻', null),
            h('div', { style: { padding: '40px 0', textAlign: 'center' } }, '加载失败：' + error),
          ),
        )
      }
      if (!data) {
        return shell(
          h(
            'div',
            { style: { color: 'var(--dsw-alias-label-secondary)' } },
            header('AI 新闻', null),
            h('div', { style: { padding: '40px 0', textAlign: 'center' } }, '正在加载…'),
          ),
        )
      }

      const newsDays = ((data.news && data.news.days) || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1))
      const reposDays = ((data.repos && data.repos.days) || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1))
      const weeks = ((data.weekly && data.weekly.weeks) || []).slice()

      /* 日期页签（新闻/雷达共用一套样式） */
      const dateTab = (d, sel, setSel) =>
        h(
          'button',
          {
            key: d.date,
            onClick: () => setSel(d.date),
            style: {
              padding: '6px 14px',
              borderRadius: 8,
              border: 'none',
              cursor: 'pointer',
              fontSize: 13,
              background: d.date === sel ? 'var(--dsw-alias-button-floating-fill)' : 'transparent',
              color: d.date === sel ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
              fontWeight: d.date === sel ? 600 : 400,
            },
          },
          fmtDate(d.date, todayStr),
        )

      /* 通用条目卡片（新闻与雷达共用；tagColors 决定彩条颜色） */
      const itemCard = (tagColors, askPrefix) => (it, i) =>
        h(
          'div',
          {
            key: i,
            style: {
              padding: '14px 16px',
              borderRadius: 12,
              background: 'var(--dsw-alias-bg-layer-1)',
              border: '1px solid var(--dsw-alias-border-l1)',
              marginBottom: 10,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
            h(
              'span',
              {
                style: {
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 6,
                  color: '#fff',
                  background: tagColors[it.tag] || tagColors['其他'] || '#565f89',
                  flexShrink: 0,
                },
              },
              it.tag || '其他',
            ),
            h(
              'a',
              {
                href: it.url,
                target: '_blank',
                rel: 'noreferrer',
                style: {
                  fontSize: 15,
                  fontWeight: 600,
                  color: 'var(--dsw-alias-label-primary)',
                  textDecoration: 'none',
                  flex: 1,
                },
              },
              it.title,
            ),
          ),
          h(
            'div',
            { style: { fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
            it.summary,
          ),
          it.takeaway
            ? h(
                'div',
                { style: { fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 8, padding: '8px 10px', marginBottom: 8 } },
                '🎯 值得抄：' + it.takeaway,
              )
            : null,
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            h('span', null, '来源：' + (it.source || '—')),
            h(
              'button',
              {
                onClick: () => {
                  try {
                    window.__DSH_AI_NEWS_ASK__ && window.__DSH_AI_NEWS_ASK__(it, askPrefix)
                  } catch {}
                },
                style: {
                  marginLeft: 'auto',
                  fontSize: 12,
                  padding: '4px 12px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-primary)',
                },
              },
              '💬 追问',
            ),
          ),
        )

      const newsItem = itemCard(TAG_COLORS, '')
      const repoItem = itemCard(REPO_TAG_COLORS, '（宝藏雷达追问）请深入研究这个开源项目：架构、核心理念、能借鉴到主人项目里的点。项目：')

      /* ── 视图一：AI 新闻 ── */
      let body = null
      if (view === 'news') {
        if (!newsDays.length) {
          body = h('div', { style: { padding: '40px 0', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)' } }, '还没有新闻。每天早上 9 点自动更新。')
        } else {
          const current = newsDays.find((d) => d.date === selNews) || newsDays[0]
          body = h(
            'div',
            null,
            header('AI 新闻', current.items ? current.items.length : 0),
            viewTabs,
            h('div', { style: { display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' } }, newsDays.map((d) => dateTab(d, selNews, setSelNews))),
            h('div', null, (current.items || []).map(newsItem)),
          )
        }
      } else if (view === 'repos') {
        if (!reposDays.length) {
          body = h('div', { style: { padding: '40px 0', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)' } }, '宝藏雷达还没有数据。每天早上 9:05 自动更新。')
        } else {
          const current = reposDays.find((d) => d.date === selRepos) || reposDays[0]
          body = h(
            'div',
            null,
            header('💎 宝藏雷达', current.items ? current.items.length : 0),
            viewTabs,
            h('div', { style: { display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' } }, reposDays.map((d) => dateTab(d, selRepos, setSelRepos))),
            h('div', null, (current.items || []).map(repoItem)),
          )
        }
      } else {
        if (!weeks.length) {
          body = h('div', { style: { padding: '40px 0', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)' } }, '还没有周报。每周日早上 9:10 自动生成。')
        } else {
          body = h(
            'div',
            null,
            header('📅 本周精选', weeks[0].items ? weeks[0].items.length : 0),
            viewTabs,
            weeks.map((w, wi) =>
              h(
                'div',
                { key: wi, style: { marginBottom: 24 } },
                h(
                  'div',
                  { style: { fontSize: 15, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', margin: '6px 0 12px' } },
                  (w.label || w.week || '本周') + ' · 精选 ' + (w.items || []).length + ' 个',
                ),
                (w.items || []).map((it, i) =>
                  h(
                    'div',
                    {
                      key: i,
                      style: {
                        padding: '14px 16px',
                        borderRadius: 12,
                        background: 'var(--dsw-alias-bg-layer-1)',
                        border: '1px solid var(--dsw-alias-border-l1)',
                        marginBottom: 10,
                      },
                    },
                    h(
                      'div',
                      { style: { marginBottom: 6 } },
                      h(
                        'a',
                        {
                          href: it.url,
                          target: '_blank',
                          rel: 'noreferrer',
                          style: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', textDecoration: 'none' },
                        },
                        it.title,
                      ),
                    ),
                    it.summary
                      ? h('div', { style: { fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 } }, it.summary)
                      : null,
                    it.takeaway
                      ? h(
                          'div',
                          { style: { fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 8, padding: '8px 10px' } },
                          '🎯 值得抄：' + it.takeaway,
                        )
                      : null,
                  ),
                ),
              ),
            ),
          )
        }
      }

      return shell(body)
    }

    function PanelIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h10A1.5 1.5 0 0 1 17 5.5V8h1.5A1.5 1.5 0 0 1 20 9.5v8A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-12Z' }),
        h('path', { d: 'M7 8h6M7 11h6M7 14h6M17 11v5' }),
      )
    }

    return {
      inject: ['slots', 'layout', 'uiWorkspace'],
      apply(ctx) {
        /* ── 通用「返回对话」按钮：给「自动化任务 / 插件」这两页官方面板用。
           定位策略（第三版，最稳）：在页面内容区最上面插一行返回条
           `[← 返回对话]`，占位自己算，然后标题照常排下面。
           不去挤官方 flex 标题行（第一版 insert 会把标题顶到中间）、
           也不浮在角上（第二版与标题不同行、像野按钮）。内容区左内边距天然对齐。 ── */
        /* 插件热重载会重跑 factory：先清掉上一份插进官方面板的返回条，避免叠出两颗 */
        try {
          document.querySelectorAll('[data-djh-back-row]').forEach((el) => el.remove())
        } catch {}

        const btn = document.createElement('button')
        btn.title = '返回对话'
        btn.setAttribute('aria-label', '返回对话')
        btn.innerHTML =
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>' +
          '<span style="margin-left:6px">返回对话</span>'
        btn.style.cssText =
          'display:inline-flex;align-items:center;height:28px;padding:0 10px;border-radius:8px;' +
          'cursor:pointer;font-size:12px;line-height:1;' +
          'border:1px solid var(--dsw-alias-border-l2);background:transparent;' +
          'color:var(--dsw-alias-label-secondary);'
        btn.onmouseenter = () => {
          btn.style.background = 'var(--dsw-alias-bg-layer-2)'
          btn.style.color = 'var(--dsw-alias-label-primary)'
        }
        btn.onmouseleave = () => {
          btn.style.background = 'transparent'
          btn.style.color = 'var(--dsw-alias-label-secondary)'
        }
        btn.onclick = () => {
          try {
            ctx.layout.selectPanel(null)
          } catch {}
        }

        const mountBackButton = () => {
          const main = document.querySelector('[class*="mainPanel"]')
          if (!main) return
          const heading = main.querySelector('[class*="_pageHeading"]')
          if (!heading) {
            btn.style.display = 'none'
            return
          }
          const host =
            main.querySelector('[class*="_pageContent"]') ||
            main.querySelector('[class*="_pageBody"]') ||
            heading.parentElement
          if (!host) return
          let row = host.querySelector(':scope > [data-djh-back-row]')
          if (!row) {
            row = document.createElement('div')
            row.dataset.djhBackRow = '1'
            row.style.cssText = 'display:flex;align-items:center;margin:6px 0 10px;'
            row.appendChild(btn)
            host.insertBefore(row, host.firstElementChild)
          } else if (row.firstElementChild !== btn) {
            row.appendChild(btn)
          }
          btn.style.display = 'inline-flex'
        }

        const observer = new MutationObserver(() => requestAnimationFrame(mountBackButton))
        const startWatch = () => {
          if (!document.body) return
          observer.observe(document.body, { childList: true, subtree: true })
        }
        startWatch()
        mountBackButton()
        /* 官方规范：observer / 全局函数挂 ctx.effect，HMR 重跑不叠 */
        ctx.effect(
          () => () => {
            observer.disconnect()
            try {
              document.querySelectorAll('[data-djh-back-row]').forEach((el) => el.remove())
            } catch {}
            if (window.__DSH_AI_NEWS_ASK__) delete window.__DSH_AI_NEWS_ASK__
          },
          'ai-news: back-button observer + global ask fn',
        )

        /* 「追问」= 带着这条内容开新会话（askPrefix 区分新闻/宝藏雷达） */
        window.__DSH_AI_NEWS_ASK__ = (it, askPrefix) => {
          const prefix = askPrefix || '（AI 新闻追问）请深入了解这条新闻并给我讲讲来龙去脉和影响：'
          try {
            ctx.uiWorkspace.startSession(void 0, {
              prompt: prefix + it.title + '\n' + (it.url || ''),
              whenDraftExists: 'append',
            })
          } catch (e) {
            window.open(it.url, '_blank')
          }
        }

        /* 中央面板：点左栏入口后主区域渲染的新闻页（返回钮在标题栏里） */
        ctx.slots.inject(
          'main',
          () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID }, () =>
              h(NewsPanel, {
                onBack: () => {
                  /* 返回上一层 = DJH 插件专区（AI 新闻入口就在那），专区不在就回对话 */
                  try {
                    ctx.layout.selectPanel('djh-plugins')
                  } catch {
                    try { ctx.layout.selectPanel(null) } catch {}
                  }
                },
              }),
            ),
        )

        /* 左栏入口已收编进「DJH 插件」专区（dsh-plugin-hub，2026-11-15）：
           专区的「AI 新闻」卡片点开 = ctx.layout.selectPanel('ai-news')，
           所以这里不再单独注册导航行（注册 order 5 的那段已删）。 */
      },
    }
  },
})
