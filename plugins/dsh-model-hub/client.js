/**
 * 模型中心（Client 半）—— 设置 › 供应商 一级目录 + 三扇独立小窗
 *
 * 界面结构照 little DJ 经典版搬：
 *   设置 → 供应商 → 供应商列表小窗 → 点供应商 → Key 小窗
 *                       └─ 顶部「📊 模型对比」→ 比价大屏
 * 小窗是真正的浏览器窗口（window.open），不是页内浮层。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-model-hub',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    // react-dom/client 在宿主模块表里可用（官方设置壳自己也在用 createPortal）
    let createRoot = null
    try {
      createRoot = require('react-dom/client').createRoot
    } catch {
      createRoot = require('react-dom').createRoot
    }

    // ────────────────── 主题令牌 ──────────────────
    const TOKEN_NAMES = [
      '--dsw-alias-bg-base',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-overlay',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-brand-primary',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-state-error-primary',
      '--dsw-alias-state-idle-primary',
      '--dsw-alias-state-success-primary',
      '--dsw-alias-state-warn-primary',
    ]

    function tokenSnapshot() {
      // 主题令牌挂在 <body> 上（不是 <html>），所以要从 body 读，否则整份样式全空
      const source = document.body || document.documentElement
      const cs = getComputedStyle(source)
      const parts = []
      for (const name of TOKEN_NAMES) {
        const v = cs.getPropertyValue(name).trim()
        if (v) parts.push(name + ':' + v + ';')
      }
      return ':root{' + parts.join('') + '}'
    }

    // ────────────────── 后端调用 ──────────────────
    async function call(endpoint, payload) {
      const res = await fetch('/model-hub-api/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
        credentials: 'same-origin',
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const body = await res.json()
      if (!body || body.ok !== true) {
        throw new Error(body && body.error ? body.error.message : '调用失败')
      }
      return body.value
    }

    // ────────────────── 小工具 ──────────────────
    function el(tag, cls, text) {
      const node = document.createElement(tag)
      if (cls) node.className = cls
      if (text != null) node.textContent = String(text)
      return node
    }
    function clear(node) {
      while (node.firstChild) node.removeChild(node.firstChild)
    }
    function num(v) {
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    }
    function fmtPrice(v) {
      if (v == null) return '—'
      return String(Math.round(v * 10000) / 10000)
    }
    function fmtTime(iso) {
      if (!iso) return '从未'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso)
      const p = (n) => String(n).padStart(2, '0')
      return (
        d.getFullYear() +
        '-' +
        p(d.getMonth() + 1) +
        '-' +
        p(d.getDate()) +
        ' ' +
        p(d.getHours()) +
        ':' +
        p(d.getMinutes())
      )
    }

    const RATE_KEY = 'dsh.modelHub.rate'
    const UNIT_KEY = 'dsh.modelHub.unit'
    function readRate() {
      const v = parseFloat(localStorage.getItem(RATE_KEY) || '')
      return Number.isFinite(v) && v > 0 ? v : 0
    }
    function readUnitCny() {
      return localStorage.getItem(UNIT_KEY) === '1'
    }

    // ────────────────── 窗口管理 ──────────────────
    const SPECS = {
      pricing: { w: 1280, h: 880, title: '模型比价' },
      key: { w: 680, h: 560, title: 'API Key' },
      tops: { w: 720, h: 760, title: '模型榜单' },
    }
    const openWindows = new Map()

    // 小窗居中：window.open 不带 left/top 时，Windows 上的 Chrome 会把窗口丢到屏幕左上角 (0,0)。
    // 这里按可视区算正中，窗口比屏幕还大时先夹到屏幕内，再兜底不小于 320。
    function centeredSpec(w, h) {
      const aw = window.screen && window.screen.availWidth ? window.screen.availWidth : 1280
      const ah = window.screen && window.screen.availHeight ? window.screen.availHeight : 800
      const W = Math.min(w, Math.max(320, aw - 40))
      const H = Math.min(h, Math.max(320, ah - 80))
      const left = Math.max(0, Math.round((aw - W) / 2))
      const top = Math.max(0, Math.round((ah - H) / 2))
      return { w: W, h: H, left, top }
    }

    function openWindow(kind, params) {
      const spec = SPECS[kind]
      const key = kind + (params && params.provider ? ':' + params.provider : '')
      const geo = centeredSpec(spec.w, spec.h)
      const existing = openWindows.get(key)
      if (existing && !existing.win.closed) {
        // 复用已有小窗：只有它还卡在左上角 (0,0) 时才挪回正中，用户自己拖过的位置要尊重。
        try {
          if (Math.abs(existing.win.screenX) <= 2 && Math.abs(existing.win.screenY) <= 2) {
            existing.win.moveTo(geo.left, geo.top)
          }
        } catch (e) {
          /* 跨窗口访问被拒时忽略，位置保持原样 */
        }
        existing.win.focus()
        void existing.render()
        return
      }
      const name = 'dsh_model_hub_' + key.replace(/[^a-z0-9_:-]/gi, '_')
      const win = window.open(
        'about:blank',
        name,
        'width=' +
          geo.w +
          ',height=' +
          geo.h +
          ',left=' +
          geo.left +
          ',top=' +
          geo.top +
          ',menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes',
      )
      if (!win) {
        window.alert('弹窗被浏览器拦住了：请允许本站弹窗，再点一次。')
        return
      }
      const app = createWindowApp(win, kind, params)
      openWindows.set(key, app)
      app.mount()
    }

    function syncAllThemes() {
      for (const app of openWindows.values()) {
        if (!app.win.closed) app.syncTheme()
      }
    }

    function refreshListWindow() {
      for (const [k, app] of openWindows) {
        if (app.win.closed) openWindows.delete(k)
      }
    }

    const BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
 font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
 font-size:13px;line-height:1.55}
#app{height:100%;display:flex;flex-direction:column;min-height:0}
.top{display:flex;align-items:center;gap:10px;padding:14px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.title{font-size:15px;font-weight:600}
.sub{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.spacer{flex:1 1 auto}
.body{flex:1 1 auto;overflow:auto;padding:12px 16px 16px;min-height:0}
.foot{flex:0 0 auto;padding:10px 16px 14px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11.5px}
button{font:inherit;color:inherit;cursor:pointer}
.btn{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 11px;font-size:12.5px}
.btn:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2)}
.btn:disabled{opacity:.5;cursor:default}
.btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base);font-weight:600}
.btn.ghost{background:transparent;border-color:transparent;padding:4px 7px}
.btn.ghost:hover{background:var(--dsw-alias-bg-layer-2)}
.btn.tiny{font-size:11.5px;padding:3px 8px;border-radius:7px}
.row{display:flex;align-items:center;gap:10px}
.card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;margin-bottom:10px}
.card.click{cursor:pointer}
.card.click:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;display:inline-block;vertical-align:middle}
.dot.on{background:var(--dsw-alias-state-success-primary)}
.dot.off{background:var(--dsw-alias-state-idle-primary)}
.dot.warn{background:var(--dsw-alias-state-warn-primary)}
.hint{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.err{color:var(--dsw-alias-state-error-primary);font-size:12px}
.ok{color:var(--dsw-alias-state-success-primary);font-size:12px}
input,select{font:inherit;color:inherit;background:var(--dsw-alias-bg-base);
 border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 9px;outline:none;min-width:0}
input:focus,select:focus{border-color:var(--dsw-alias-brand-primary)}
input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.7}
.empty{color:var(--dsw-alias-label-secondary);text-align:center;padding:26px 10px;font-size:12.5px}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
th{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-base);font-weight:600;font-size:11.5px;
 color:var(--dsw-alias-label-secondary);white-space:nowrap;
 box-shadow:0 1px 0 var(--dsw-alias-border-l1)}
td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
th.n{text-align:right}
.prov{color:var(--dsw-alias-brand-primary);cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px}
tr:hover td{background:var(--dsw-alias-bg-layer-1)}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.toolbar input[type=search]{width:230px}
.keyitem{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px dashed var(--dsw-alias-border-l1)}
.keyitem:last-child{border-bottom:none}
.badge{font-size:11px;padding:1px 7px;border-radius:20px;background:var(--dsw-alias-bg-layer-2);
 border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.badge.live{color:var(--dsw-alias-bg-base);background:var(--dsw-alias-brand-primary);border-color:transparent;font-weight:600}
`

    // ────────────────── 窗口实例 ──────────────────
    function createWindowApp(win, kind, params) {
      let themeStyle = null

      function mount() {
        const doc = win.document
        doc.open()
        doc.write(
          '<!doctype html><html><head><meta charset="utf-8"><title>' +
            SPECS[kind].title +
            '</title><style id="dshmh-theme"></style><style id="dshmh-base">' +
            BASE_CSS +
            '</style></head><body><div id="app"></div></body></html>',
        )
        doc.close()
        themeStyle = doc.getElementById('dshmh-theme')
        syncTheme()
        win.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') win.close()
          /* Alt+A → 转发给主窗口的截图插件（dsh-screenshot）。这扇小窗是
             window.open 的独立文档，主窗口插件在这里收不到键盘；截图抓的
             是整个桌面（含本小窗），所以在主窗里框选即可。 */
          if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'a' || e.key === 'A' || e.code === 'KeyA')) {
            e.preventDefault()
            /* BroadcastChannel 优先：不依赖 opener（部分环境弹窗的 opener 是 null），
               主窗口的 dsh-screenshot 监听 'djh-screenshot' 频道。opener 直调作兜底。 */
            try {
              const ch = new BroadcastChannel('djh-screenshot')
              ch.postMessage({ type: 'start' })
              ch.close()
            } catch {}
            try {
              const opener = window.opener
              if (opener && typeof opener.__DSH_SCREENSHOT_START__ === 'function') opener.__DSH_SCREENSHOT_START__()
            } catch {}
          }
        })
        void render()
      }

      function syncTheme() {
        try {
          if (themeStyle) themeStyle.textContent = tokenSnapshot()
        } catch {
          /* 窗口已关闭 */
        }
      }

      async function render() {
        if (win.closed) return
        const root = win.document.getElementById('app')
        if (!root) return
        try {
          if (kind === 'pricing') await renderPricing(root, win)
          else if (kind === 'tops') await renderTops(root, win)
          else await renderKey(root, win, params && params.provider)
        } catch (e) {
          clear(root)
          const body = el('div', 'body')
          body.appendChild(el('div', 'err', '加载失败：' + String((e && e.message) || e)))
          root.appendChild(body)
        }
      }

      return { win, render, mount, syncTheme }
    }

    // ────────────────── 窗口：模型榜单（2026-11-19 主人要的胶囊弹窗） ──────────────────
    // 三张榜：🏆 最强 · 💰 性价比 · 🎁 免费最强，各 5 个。
    // 数据全部来自「已配好 Key 的供应商 × 比价库」实时计算：模型库任务跑完/Key 变动，
    // 下次打开自动就是新榜，不用手动更新。
    async function renderTops(root, win) {
      const data = await call('tops')
      clear(root)

      const top = el('div', 'top')
      top.appendChild(el('div', 'title', '🏆 模型榜单'))
      top.appendChild(el('div', 'sub', data.updatedAt ? '比价库更新于 ' + fmtTime(data.updatedAt) : '比价库还没数据'))
      top.appendChild(el('div', 'spacer'))
      const closeBtn = el('button', 'btn ghost', '✕')
      closeBtn.title = '关闭'
      closeBtn.onclick = () => win.close()
      top.appendChild(closeBtn)
      root.appendChild(top)

      const body = el('div', 'body')
      root.appendChild(body)

      const CAP_ICON = { vision: '👁', video: '🎬', audio: '🔊', tools: '🔧', reasoning: '🧠' }
      const sections = [
        { key: 'strong', icon: '🏆', title: '最强模型', hint: '已配 Key 的供应商里按官方旗舰定位排（价格高≈定位高，能力标签做平手判定）' },
        { key: 'value', icon: '💰', title: '性价比最高', hint: '非免费模型里按「输入 + 3×输出」综合花费从低到高' },
        { key: 'free', icon: '🎁', title: '免费中能力最高', hint: '0 元档里按能力标签 + 官方定位排' },
        {
          key: 'nsfw',
          icon: '🔞',
          title: 'NSFW 专区',
          hint: '全网比价库里带成人/角色扮演/NSFW 绘图标记的模型（unmoderated 不算），同族去重，按血统档位优先+同档综合花费排（Cydonia/Euryale 系在前，老古董 MythoMax 沉底）',
        },
      ]
      for (const sec of sections) {
        const card = el('div', 'card')
        const head = el('div', 'row')
        head.appendChild(el('div', 'title', sec.icon + ' ' + sec.title + ' TOP5'))
        head.appendChild(el('div', 'spacer'))
        card.appendChild(head)
        card.appendChild(el('div', 'hint', sec.hint))
        const list = data[sec.key] || []
        if (!list.length) {
          const empty = el('div', 'hint', sec.key === 'free' ? '暂时没有免费模型' : '暂无数据')
          empty.style.marginTop = '8px'
          card.appendChild(empty)
        } else {
          const ol = el('ol')
          ol.style.cssText = 'margin:8px 0 0;padding-left:22px;display:flex;flex-direction:column;gap:6px'
          list.forEach((m, i) => {
            const li = el('li')
            const line1 = el('div', 'row')
            const name = el('span', null, m.name)
            name.style.fontWeight = i === 0 ? '600' : '400'
            line1.appendChild(name)
            const prov = el('span', 'badge', m.provider)
            line1.appendChild(prov)
            const price = el('span', 'hint', m.price || '')
            price.style.marginLeft = 'auto'
            price.style.whiteSpace = 'nowrap'
            line1.appendChild(price)
            li.appendChild(line1)
            const meta = [
              m.nsfwTags && m.nsfwTags.length ? m.nsfwTags.join('·') : m.caps && m.caps.length ? m.caps.map((c) => CAP_ICON[c] || c).join(' ') : null,
              m.ctx ? '上下文 ' + m.ctx : null,
            ]
              .filter(Boolean)
              .join(' · ')
            const line2 = el('div', 'hint', meta)
            line2.style.fontSize = '11px'
            if (m.desc) line2.title = m.desc
            li.appendChild(line2)
            ol.appendChild(li)
          })
          card.appendChild(ol)
        }
        body.appendChild(card)
      }

      const foot = el('div', 'foot')
      foot.textContent =
        '范围：' +
        (data.usableProviders && data.usableProviders.length ? data.usableProviders.join('、') : '（还没配任何 API Key）') +
        (data.nsfwCount ? ' · NSFW 全网库共 ' + data.nsfwCount + ' 个' : '') +
        ' · 榜单由模型库任务自动更新，打开即最新'
      root.appendChild(foot)
    }

    // ────────────────── 窗口 2：比价大屏 ──────────────────
    function priceGroups(m) {
      const p = m.price || {}
      const g = (o) => ({ offpeak: num(o && o.offpeak), peak: num(o && o.peak) })
      return { unit: p.unit || '元', hit: g(p.inputHit), miss: g(p.inputMiss), out: g(p.output) }
    }
    function priceCell(g, unit, toCny) {
      const rate = readRate()
      const conv = (v) => (unit === '积分' && toCny && rate > 0 ? v * rate : v)
      const a = g.offpeak
      const b = g.peak
      if (a == null && b == null) return '—'
      // 免费档（如硅基两款千问）：输入/输出都是 0 → 直接写「免费」不写 0
      if (a === 0 && b === 0) return '免费'
      if (a != null && b != null && a !== b) return fmtPrice(conv(a)) + ' / ' + fmtPrice(conv(b))
      return fmtPrice(conv(a != null ? a : b))
    }

    async function renderPricing(root, win) {
      const [state, prices] = await Promise.all([call('state'), call('pricing.latest')])
      const linked = {}
      for (const p of state.providers) linked[p.id] = !!p.routed
      const keyByProviderKey = { deepseek: 'deepseek', 'zhipuai-coding-plan': 'zhipu-plan', volc: 'volc', aliyun: 'aliyun', siliconflow: 'siliconflow', modelscope: 'modelscope' }
      // 比价行的模型走哪条路由查别名（GLM 按量已撤，不再出现在比价表）
      const routeByProviderKey = {
        deepseek: 'deepseek-official',
        'zhipuai-coding-plan': 'zai-coding-cn',
        volc: 'volc-ark-cn',
        aliyun: 'aliyun-dashscope',
        siliconflow: 'siliconflow-cn',
        modelscope: 'modelscope-cn',
      }
      const aliasOf = (prov, modelName) => {
        const routeId = routeByProviderKey[prov.providerKey]
        if (!routeId || !modelName) return ''
        const k = routeId + ':' + String(modelName).toLowerCase()
        return state.aliases && Object.prototype.hasOwnProperty.call(state.aliases, k) ? state.aliases[k] : ''
      }

      let q = ''
      let cat = ''
      let nsfwSel = ''
      let link = ''
      let toCny = readUnitCny()
      const providers = (prices.providers || []).filter((p) => p && Array.isArray(p.models))

      clear(root)

      // ── 顶栏一行(照小 DJ:标题+更新时间+工具+刷新挤同一行,不再三行) ──
      const toolbar = el('div', 'toolbar')
      const title = el('div', null, '模型比价')
      title.style.fontWeight = '600'
      title.style.fontSize = '13.5px'
      title.style.whiteSpace = 'nowrap'
      toolbar.appendChild(title)
      const sub = el('div', 'hint', prices.updatedAt ? '更新于 ' + fmtTime(prices.updatedAt) : '还没有数据')
      sub.style.whiteSpace = 'nowrap'
      toolbar.appendChild(sub)
      toolbar.appendChild(el('div', 'spacer'))

      const search = el('input')
      search.type = 'search'
      search.placeholder = '搜索供应商 / 模型，如 deepseek'
      search.oninput = () => {
        q = search.value.trim().toLowerCase()
        paint()
      }
      toolbar.appendChild(search)

      const mkSelect = (items, onChange) => {
        const sel = el('select')
        for (const [v, label] of items) {
          const o = el('option', null, label)
          o.value = v
          sel.appendChild(o)
        }
        sel.onchange = () => onChange(sel.value)
        return sel
      }
      toolbar.appendChild(
        mkSelect(
          [
            ['', '全部类别'],
            ['text', '文本'],
            ['image', '图像'],
            ['audio', '音频'],
          ],
          (v) => {
            cat = v
            paint()
          },
        ),
      )
      toolbar.appendChild(
        mkSelect(
          [
            ['', '全部内容等级'],
            ['any', '🔞 仅 NSFW'],
            ['adult', '成人内容'],
            ['roleplay', '角色扮演'],
            ['nsfw-image', 'NSFW绘图'],
            ['unmoderated', '低审查(≠NSFW)'],
          ],
          (v) => {
            nsfwSel = v
            paint()
          },
        ),
      )
      toolbar.appendChild(
        mkSelect(
          [
            ['', '全部接入状态'],
            ['yes', '仅已接入'],
            ['no', '仅未接入'],
          ],
          (v) => {
            link = v
            paint()
          },
        ),
      )
      const unitBtn = el('button', 'btn', toCny ? '⇄ 显示积分' : '⇄ 显示元')
      unitBtn.title = '积分制（GLM Token Plan）按自定汇率折算成元显示；点击切换'
      unitBtn.onclick = () => {
        if (!toCny && !readRate()) {
          const s = window.prompt('1 积分约等于多少元？（用于把 Token Plan 积分折算成元，只存本机）', '0.005')
          const r = parseFloat(s)
          if (!(r > 0)) return
          localStorage.setItem(RATE_KEY, String(r))
        }
        toCny = !toCny
        localStorage.setItem(UNIT_KEY, toCny ? '1' : '0')
        unitBtn.textContent = toCny ? '⇄ 显示积分' : '⇄ 显示元'
        paint()
      }
      toolbar.appendChild(unitBtn)
      const refreshBtn = el('button', 'btn primary', '⟳ 立即刷新')
      toolbar.appendChild(refreshBtn)
      root.appendChild(toolbar)

      const body = el('div')
      body.style.flex = '1 1 auto'
      body.style.overflow = 'auto'
      body.style.minHeight = '0'
      root.appendChild(body)

      const footer = el('div', 'foot')
      root.appendChild(footer)

      // ── 列定义：顺序+宽度存 localStorage，可拖表头换位、拖右缘改宽 ──
      const DEFAULT_COLS = [
        { k: 'prov', label: '供应商' },
        { k: 'model', label: '模型' },
        { k: 'caps', label: '能力' },
        { k: 'nsfw', label: 'NSFW' },
        { k: 'alias', label: '别名' },
        { k: 'ctx', label: '上下文' },
        { k: 'hit', label: '输入·缓存命中', num: true },
        { k: 'miss', label: '输入·未命中', num: true },
        { k: 'out', label: '输出', num: true },
        { k: 'link', label: '接入' },
        { k: 'api', label: '接口' },
      ]
      const COLS_KEY = 'dsh.modelHub.cols'
      function loadCols() {
        let saved = null
        try {
          saved = JSON.parse(localStorage.getItem(COLS_KEY) || 'null')
        } catch {
          saved = null
        }
        const byK = new Map(DEFAULT_COLS.map((c) => [c.k, c]))
        let order = Array.isArray(saved && saved.order) ? saved.order.filter((k) => byK.has(k)) : []
        for (const c of DEFAULT_COLS) if (!order.includes(c.k)) order.push(c.k)
        const widths = saved && typeof saved.widths === 'object' && saved.widths ? saved.widths : {}
        return { order, widths }
      }
      function saveCols() {
        localStorage.setItem(COLS_KEY, JSON.stringify({ order: colState.order, widths: colState.widths }))
      }
      const colState = loadCols()

      // ── 别名白名单（比价表内联编辑的数据源，pi-ai 家可写；deepseek 官方只读） ──
      const EDITABLE_PROVIDERS = ['deepseek', 'zhipu-plan', 'volc', 'aliyun', 'siliconflow']
      const activeBy = {}
      const catalogBy = {}
      for (const pid of EDITABLE_PROVIDERS) {
        try {
          const r = await call('models.list', { provider: pid })
          activeBy[pid] = r.active || []
          catalogBy[pid] = r.catalog || []
        } catch {
          activeBy[pid] = []
          catalogBy[pid] = []
        }
      }
      const normId = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.]/g, '')
      function matchModelId(pid, modelName) {
        const pool = [...activeBy[pid], ...catalogBy[pid]]
        const n = normId(modelName)
        const hit = pool.filter((m) => normId(m.id) === n || normId(m.name) === n)[0]
        return hit ? hit.id : String(modelName || '').toLowerCase()
      }
      async function saveAlias(pid, modelName, newAlias, inputEl) {
        const cur = activeBy[pid].map((m) => ({ id: m.id, alias: m.name }))
        const id = matchModelId(pid, modelName)
        const i = cur.findIndex((r) => r.id === id)
        const v = String(newAlias || '').trim()
        if (v) {
          if (i >= 0) cur[i] = { id, alias: v }
          else cur.push({ id, alias: v })
        } else if (i >= 0) {
          cur.splice(i, 1)
        }
        try {
          await call('models.set', { provider: pid, models: cur })
          footer.textContent = '✅ 已保存：' + (v ? '「' + id + '」别名 = ' + v : '「' + id + '」已移出别名单（不再出现在模型选择器）')
          await renderPricing(root, win)
        } catch (e) {
          footer.textContent = '❌ 保存失败：' + String((e && e.message) || e)
          if (inputEl) inputEl.style.borderColor = 'var(--dsw-alias-state-error-primary)'
        }
      }

      function aliasCell(prov, m, alias) {
        const pid = keyByProviderKey[prov.providerKey] || ''
        const td = el('td')
        if (!EDITABLE_PROVIDERS.includes(pid)) {
          const s = el('span', 'hint', '（只读）')
          td.appendChild(s)
          return td
        }
        const inp = el('input')
        inp.value = alias || ''
        inp.placeholder = '起别名'
        inp.title = '别名可选：填了 = 模型选择器里显示这个名字；清空保存 = 移出选择器。'
        inp.maxLength = 64
        inp.autocomplete = 'off'
        inp.style.flex = '1 1 auto'
        inp.style.minWidth = '72px'
        inp.style.padding = '3px 7px'
        inp.style.fontSize = '12px'
        const saveBtn = el('button', 'btn tiny', '保存')
        saveBtn.title = '保存别名（回车也行）'
        let done = false
        const commit = () => {
          if (done) return
          done = true
          saveBtn.disabled = true
          saveBtn.textContent = '…'
          void saveAlias(pid, m.name, inp.value, inp).then(() => {
            saveBtn.disabled = false
            saveBtn.textContent = '保存'
          })
        }
        saveBtn.onclick = commit
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            done = true
            inp.value = alias || ''
          }
          e.stopPropagation()
        })
        inp.addEventListener('blur', () => {
          // 失焦时只有真改过才保存（点「保存」按钮引起的失焦不重复触发：done 已置位）
          if (!done && inp.value.trim() !== (alias || '').trim()) commit()
        })
        const box = el('div')
        box.style.display = 'flex'
        box.style.gap = '4px'
        box.style.alignItems = 'center'
        box.appendChild(inp)
        box.appendChild(saveBtn)
        td.appendChild(box)
        return td
      }

      function rowCell(col, prov, m, alias, isLinked, shown) {
        switch (col.k) {
          case 'prov': {
            const tdProv = el('td')
            const pid = keyByProviderKey[prov.providerKey] || ''
            const provSpan = el('span', 'prov', prov.provider)
            if (pid) {
              provSpan.title = '点开管理这家的 API Key'
              provSpan.onclick = () => openWindow('key', { provider: pid })
            } else {
              provSpan.style.color = 'var(--dsw-alias-label-secondary)'
              provSpan.style.cursor = 'default'
              provSpan.style.textDecoration = 'none'
            }
            tdProv.appendChild(provSpan)
            return tdProv
          }
          case 'model': {
            const tdM = el('td', null, m.name)
            // models.dev 带的模型介绍：悬停 tooltip 展示，不占列宽
            if (m.description || m.releaseDate) {
              tdM.title = [m.description, m.releaseDate ? '发布 ' + m.releaseDate : ''].filter(Boolean).join('\n')
            }
            return tdM
          }
          case 'caps': {
            // 能力标签（2026-11-18 学 models.dev）：👁视觉 🎬视频 🔊音频 🔧工具 🧠推理
            const CAP_ICON = { vision: '👁', video: '🎬', audio: '🔊', tools: '🔧', reasoning: '🧠' }
            const CAP_NAME = { vision: '视觉', video: '视频', audio: '音频', tools: '工具调用', reasoning: '推理' }
            const tdC = el('td')
            if (m.caps && m.caps.length) {
              tdC.title = m.caps.map((c) => CAP_NAME[c] || c).join(' · ')
              tdC.textContent = m.caps.map((c) => CAP_ICON[c] || '·').join(' ')
            } else tdC.textContent = '—'
            tdC.style.whiteSpace = 'nowrap'
            return tdC
          }
          case 'nsfw': {
            // NSFW 标记（2026-11-19 主人拍板「专门一列，还要分种类」）
            // 真 NSFW（粉色）：成人内容 · 角色扮演 · NSFW绘图；弱标记（灰）：🔞低审查(OR is_moderated=false，≠NSFW)
            const NSFW_TAG = {
              unmoderated: '🔞低审查',
              adult: '成人内容',
              roleplay: '角色扮演',
              'nsfw-image': 'NSFW绘图',
            }
            const tdN = el('td')
            const tags = m.nsfw || []
            const hard = tags.filter((t) => t !== 'unmoderated')
            if (tags.length) {
              tdN.textContent = tags.map((t) => NSFW_TAG[t] || t).join('·')
              tdN.style.color = hard.length ? '#ff7eb6' : 'var(--dsw-alias-label-secondary)'
              tdN.title =
                tags.map((t) => NSFW_TAG[t] || t).join(' · ') +
                '\n成人/角色扮演/绘图=官方描述关键词+社区公认NSFW血统；低审查=OpenRouter is_moderated=false（不额外加审，不等于NSFW）。仅供比价参考，能不能用取决于各平台条款。'
            } else tdN.textContent = '—'
            tdN.style.whiteSpace = 'nowrap'
            return tdN
          }
          case 'alias':
            return aliasCell(prov, m, alias)
          case 'ctx':
            return el('td', null, m.contextText || '—')
          case 'hit':
          case 'miss':
          case 'out': {
            const pr = priceGroups(m)
            // 工具类计费单位（元/小时、元/万字符…）跟在数字后面；积分按原逻辑
            const suffix =
              pr.unit === '积分'
                ? toCny
                  ? ''
                  : ' 积分'
                : pr.unit && pr.unit !== '元'
                  ? ' ' + pr.unit
                  : ''
            const g = col.k === 'hit' ? pr.hit : col.k === 'miss' ? pr.miss : pr.out
            return el('td', 'n', priceCell(g, pr.unit, toCny) + suffix)
          }
          case 'link': {
            const tdLink = el('td')
            const dot = el('span', 'dot ' + (isLinked ? 'on' : 'off'))
            dot.title = isLinked ? '已接入（有可用 Key）' : '未接入（还没有可用 Key）'
            tdLink.appendChild(dot)
            return tdLink
          }
          case 'api': {
            const api = el('td', 'mono', prov.api || '—')
            api.style.color = 'var(--dsw-alias-label-secondary)'
            api.style.fontSize = '11px'
            if (prov.apiFull) api.title = prov.apiFull
            return api
          }
          default:
            return el('td')
        }
      }

      function paint() {
        clear(body)
        if (!providers.length) {
          body.appendChild(el('div', 'empty', prices.lastError || '还没有比价数据，点右上「⟳ 立即刷新」抓一次。'))
          footer.textContent = '数据源：DeepSeek 官方 / GLM Token Plan（每 3 天 08:00 自动刷新）· 火山方舟（内置快照）'
          return
        }
        const byK = new Map(DEFAULT_COLS.map((c) => [c.k, c]))
        const cols = colState.order.map((k) => byK.get(k))

        // 默认列宽（fixed 布局必须有宽度来源；拖动后以 localStorage 为准）
        const DEFAULT_WIDTHS = { prov: 96, model: 190, alias: 200, ctx: 80, hit: 108, miss: 108, out: 84, link: 56, api: 200 }
        const table = el('table')
        table.style.tableLayout = 'fixed'
        table.style.width = '100%'
        // 列宽：<colgroup> 每列都有 explicit width（auto 布局下改宽会被挤回去）
        const cg = el('colgroup')
        for (const c of cols) {
          const col = el('col')
          col.style.width = (colState.widths[c.k] || DEFAULT_WIDTHS[c.k] || 100) + 'px'
          cg.appendChild(col)
        }
        table.appendChild(cg)

        const thead = el('thead')
        const hr = el('tr')
        cols.forEach((c, ci) => {
          const th = el('th', c.num ? 'n' : null)
          th.style.userSelect = 'none'
          th.appendChild(el('span', null, c.label))
          // 拖表头换列序：拖到哪个表头的位置就插到那里（长拖也跟手）
          th.draggable = false
          th.style.cursor = 'grab'
          th.title = '按住左右拖动可调整这一列的位置'
          th.addEventListener('mousedown', (e) => {
            if (e.target.__isResize) return
            const startX = e.clientX
            let dragging = false
            const onMove = (ev) => {
              if (!dragging && Math.abs(ev.clientX - startX) > 6) {
                dragging = true
                th.style.cursor = 'grabbing'
                Array.from(hr.children).forEach((t) => (t.style.opacity = '0.55'))
                th.style.opacity = '1'
              }
              if (dragging) {
                Array.from(hr.children).forEach((t) => {
                  t.style.outline = ''
                })
                // 目标列 = clientX 落在哪个 th 上
                const target = [...hr.children].find((t) => {
                  const r = t.getBoundingClientRect()
                  return ev.clientX >= r.left && ev.clientX <= r.right
                })
                if (target && target !== th) target.style.outline = '2px solid var(--dsw-alias-brand-primary)'
              }
            }
            const onUp = (ev) => {
              win.document.removeEventListener('mousemove', onMove)
              win.document.removeEventListener('mouseup', onUp)
              Array.from(hr.children).forEach((t) => {
                t.style.opacity = ''
                t.style.outline = ''
              })
              th.style.cursor = 'grab'
              if (!dragging) return
              const target = [...hr.children].find((t) => {
                const r = t.getBoundingClientRect()
                return ev.clientX >= r.left && ev.clientX <= r.right
              })
              const to = target ? [...hr.children].indexOf(target) : ci
              if (to < 0 || to >= cols.length || to === ci) return
              const order = colState.order.slice()
              const [moved] = order.splice(ci, 1)
              order.splice(to, 0, moved)
              colState.order = order
              saveCols()
              paint()
            }
            win.document.addEventListener('mousemove', onMove)
            win.document.addEventListener('mouseup', onUp)
          })
          // 右缘 resize 柄（常显淡色细线，悬停变亮）
          const handle = el('div')
          handle.__isResize = true
          handle.title = '拖动改列宽'
          handle.style.cssText =
            'position:absolute;right:0;top:0;width:9px;height:100%;cursor:col-resize;user-select:none;'
          const bar = el('div')
          bar.style.cssText =
            'position:absolute;right:0;top:3px;bottom:3px;width:2px;background:var(--dsw-alias-border-l2);opacity:.7;border-radius:1px;pointer-events:none'
          handle.appendChild(bar)
          handle.addEventListener('mouseenter', () => (bar.style.background = 'var(--dsw-alias-brand-primary)'))
          handle.addEventListener('mouseleave', () => (bar.style.background = 'var(--dsw-alias-border-l2)'))
          handle.addEventListener('mousedown', (e) => {
            e.stopPropagation()
            const startX = e.clientX
            const thEl = handle.parentElement
            const startW = thEl.getBoundingClientRect().width
            const onMove = (ev) => {
              const w = Math.max(48, Math.round(startW + ev.clientX - startX))
              thEl.style.width = w + 'px'
              if (cg.children[ci]) cg.children[ci].style.width = w + 'px'
            }
            const onUp = () => {
              win.document.removeEventListener('mousemove', onMove)
              win.document.removeEventListener('mouseup', onUp)
              colState.widths[c.k] = Math.round(thEl.getBoundingClientRect().width)
              saveCols()
            }
            win.document.addEventListener('mousemove', onMove)
            win.document.addEventListener('mouseup', onUp)
          })
          th.appendChild(handle)
          hr.appendChild(th)
        })
        thead.appendChild(hr)
        table.appendChild(thead)

        const tbody = el('tbody')
        let shown = 0
        for (const prov of providers) {
          const pid = keyByProviderKey[prov.providerKey] || ''
          const isLinked = pid ? !!linked[pid] : false
          if (link === 'yes' && !isLinked) continue
          if (link === 'no' && isLinked) continue
          for (const m of prov.models) {
            if (cat && (m.category || 'text') !== cat) continue
            const mTags = m.nsfw || []
            // 「仅 NSFW」=有真 NSFW 标签（成人/角色扮演/绘图）；纯「低审查」不算
            if (nsfwSel === 'any' && !mTags.some((t) => t !== 'unmoderated')) continue
            if (nsfwSel && nsfwSel !== 'any' && !mTags.includes(nsfwSel)) continue
            const alias = aliasOf(prov, m.name)
            if (q && (prov.provider + ' ' + m.name + ' ' + alias).toLowerCase().indexOf(q) < 0) continue
            shown++
            const tr = el('tr')
            for (const col of cols) tr.appendChild(rowCell(col, prov, m, alias, isLinked, shown))
            tbody.appendChild(tr)
          }
        }
        table.appendChild(tbody)
        if (!shown) body.appendChild(el('div', 'empty', '没有匹配的模型'))
        else body.appendChild(table)

        const notes = providers.filter((p) => p.note).map((p) => p.provider + '：' + p.note)
        const errs = (prices.errors || []).slice()
        footer.textContent = [
          '共 ' + shown + ' 行 · 非高峰 / 高峰 两个价用「 / 」分隔',
          '别名列直接输入保存（回车/点别处）：填了=挂进模型选择器，清空=移出',
          notes.join(' ｜ '),
          errs.length ? '抓取告警：' + errs.join('；') : '',
        ]
          .filter(Boolean)
          .join(' ｜ ')
      }

      refreshBtn.onclick = async () => {
        refreshBtn.disabled = true
        refreshBtn.textContent = '正在抓取…'
        try {
          const r = await call('pricing.refresh')
          if (r && r.started === false) {
            refreshBtn.textContent = '已在刷新中…'
          }
        } catch (e) {
          refreshBtn.disabled = false
          refreshBtn.textContent = '⟳ 立即刷新'
          footer.textContent = '启动失败：' + String((e && e.message) || e)
          return
        }
        let tries = 0
        const timer = setInterval(async () => {
          tries++
          try {
            const latest = await call('pricing.latest')
            if (!latest.running || tries > 30) {
              clearInterval(timer)
              if (!win.closed) await renderPricing(root, win)
            }
          } catch {
            clearInterval(timer)
            refreshBtn.disabled = false
            refreshBtn.textContent = '⟳ 立即刷新'
          }
        }, 2500)
      }

      paint()
    }

    // ────────────────── 窗口 3：供应商 Key 编辑 ──────────────────
    async function renderKey(root, win, providerId) {
      const state = await call('state')
      const provider = (state.providers || []).filter((p) => p.id === providerId)[0]
      clear(root)
      if (!provider) {
        const body = el('div', 'body')
        body.appendChild(el('div', 'empty', '这个供应商不在了'))
        root.appendChild(body)
        return
      }

      const top = el('div', 'top')
      top.appendChild(el('div', 'title', provider.title))
      top.appendChild(el('div', 'sub', provider.api))
      top.appendChild(el('div', 'spacer'))
      const closeBtn = el('button', 'btn ghost', '✕')
      closeBtn.title = '关闭'
      closeBtn.onclick = () => win.close()
      top.appendChild(closeBtn)
      root.appendChild(top)

      const body = el('div', 'body')
      root.appendChild(body)

      const active = provider.items.filter((k) => k.active)[0]

      const status = el('div', 'card')
      const srow = el('div', 'row')
      srow.appendChild(el('span', 'dot ' + (provider.routed ? 'on' : provider.linked ? 'warn' : 'off')))
      srow.appendChild(el('div', null, active ? '当前使用：' + active.alias : provider.linked ? 'DSH 里已有一把 Key（不是本面板加的）' : '还没有配置 Key'))
      srow.appendChild(el('div', 'spacer'))
      const refreshBal = el('button', 'btn tiny', '刷新余额')
      refreshBal.disabled = !provider.linked
      srow.appendChild(refreshBal)
      status.appendChild(srow)
      const routeLine = el(
        'div',
        'hint',
        provider.routed && (provider.items.length || provider.linked)
          ? '已接入模型选择器（' + provider.routeId + '）'
          : provider.routed
            ? '已挂在模型选择器里（' + provider.routeId + '），但还没有 Key —— 加一把才能真调用'
            : provider.items.length || provider.linked
              ? '有 Key，但路由没挂上（模型选择器里还看不到）'
              : '还没有 Key —— 加一把才能用',
      )
      routeLine.style.marginTop = '4px'
      status.appendChild(routeLine)
      if (active && active.masked) {
        const masked = el('div', 'hint mono', active.masked)
        masked.style.marginTop = '4px'
        status.appendChild(masked)
      }
      const message = el('div', 'hint', '')
      message.style.marginTop = '6px'
      status.appendChild(message)
      body.appendChild(status)

      const say = (text, kindName) => {
        message.textContent = text
        message.className = kindName || 'hint'
      }

      refreshBal.onclick = async () => {
        refreshBal.disabled = true
        say('查询中…')
        try {
          const r = await call('keys.balance', { provider: provider.id })
          if (r.ok) say('余额 / 额度：' + r.message, 'hint')
          else say('查询失败：' + (r.message || '未知原因'), 'err')
        } catch (e) {
          say('查询失败：' + String((e && e.message) || e), 'err')
        } finally {
          refreshBal.disabled = false
        }
      }

      const listTitle = el('div', 'title', 'Key 列表')
      listTitle.style.fontSize = '12.5px'
      body.appendChild(listTitle)
      const listWrap = el('div')
      body.appendChild(listWrap)

      if (!provider.items.length) {
        listWrap.appendChild(el('div', 'empty', '还没有 Key，在下面添加一把'))
      } else {
        for (const item of provider.items) {
          const row = el('div', 'keyitem')
          row.appendChild(el('span', 'dot ' + (item.configured ? 'on' : 'warn')))
          const alias = el('div', null, item.alias)
          alias.style.minWidth = '72px'
          row.appendChild(alias)
          row.appendChild(el('div', 'mono hint', item.masked || '（密文缺失）'))
          row.appendChild(el('div', 'spacer'))

          if (item.active) {
            row.appendChild(el('span', 'badge live', '使用中'))
          } else {
            const useBtn = el('button', 'btn tiny', '切换到这把')
            useBtn.onclick = async () => {
              useBtn.disabled = true
              try {
                await call('keys.activate', { provider: provider.id, id: item.id })
                refreshListWindow()
                await renderKey(root, win, provider.id)
              } catch (e) {
                useBtn.disabled = false
                say(String((e && e.message) || e), 'err')
              }
            }
            row.appendChild(useBtn)
          }

          const testBtn = el('button', 'btn tiny', '测试')
          testBtn.onclick = async () => {
            testBtn.disabled = true
            testBtn.textContent = '测试中…'
            try {
              const r = await call('keys.test', { provider: provider.id, id: item.id })
              say((r.ok ? '✅ 连通正常' : '❌ ' + r.message) + '（' + item.alias + '）', r.ok ? 'ok' : 'err')
            } catch (e) {
              say('❌ ' + String((e && e.message) || e), 'err')
            } finally {
              testBtn.disabled = false
              testBtn.textContent = '测试'
            }
          }
          row.appendChild(testBtn)

          const delBtn = el('button', 'btn tiny ghost', '删除')
          delBtn.onclick = async () => {
            if (!window.confirm('删除「' + item.alias + '」这把 Key？（只删本机记录，不影响供应商账号）')) return
            delBtn.disabled = true
            try {
              await call('keys.remove', { provider: provider.id, id: item.id })
              refreshListWindow()
              await renderKey(root, win, provider.id)
            } catch (e) {
              delBtn.disabled = false
              say(String((e && e.message) || e), 'err')
            }
          }
          row.appendChild(delBtn)
          listWrap.appendChild(row)
        }
      }

      const addCard = el('div', 'card')
      addCard.style.marginTop = '14px'
      const addTitle = el('div', 'title', '添加 Key')
      addTitle.style.fontSize = '12.5px'
      addCard.appendChild(addTitle)
      const form = el('div', 'row')
      form.style.marginTop = '8px'
      const aliasInp = el('input')
      aliasInp.placeholder = '别名（可空）'
      aliasInp.style.width = '150px'
      const keyInp = el('input')
      keyInp.type = 'password'
      keyInp.placeholder = 'API Key（' + provider.keyHint + '）'
      keyInp.style.flex = '1 1 auto'
      keyInp.autocomplete = 'new-password'
      const saveBtn = el('button', 'btn primary', '保存')
      form.appendChild(aliasInp)
      form.appendChild(keyInp)
      form.appendChild(saveBtn)
      addCard.appendChild(form)
      const addHint = el('div', 'hint', '第一把 Key 会自动设为使用中；之后的 Key 存下来，点「切换到这把」才生效。')
      addHint.style.marginTop = '6px'
      addCard.appendChild(addHint)
      body.appendChild(addCard)

      const save = async () => {
        saveBtn.disabled = true
        saveBtn.textContent = '保存中…'
        try {
          await call('keys.add', { provider: provider.id, alias: aliasInp.value, key: keyInp.value })
          refreshListWindow()
          await renderKey(root, win, provider.id)
        } catch (e) {
          addHint.textContent = '保存失败：' + String((e && e.message) || e)
          addHint.className = 'err'
        } finally {
          saveBtn.disabled = false
          saveBtn.textContent = '保存'
        }
      }
      saveBtn.onclick = save
      keyInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void save()
      })

      // 2026-11-18 主人定案：Key 小窗只管 Key，三家同款（DeepSeek 样式）。
      // 模型/别名的编辑收口到「模型比价」大屏的别名列（内联编辑仍在）。
      const foot = el('div', 'foot')
      foot.textContent = 'Key 存在 DSH 凭据库；「使用中」那把会写进 ' + provider.envRef + '，模型选择器立刻可用。'
      root.appendChild(foot)

      if (provider.linked) void refreshBal.onclick()
    }

    // ────────────────── 角色卡里的「模型」行（主人 2026-11-19 拍板） ──────────────────
    // 主人原话：「就直接把上面那个 API 放到这个角色下面呀，上下分开算嘚儿啊」——
    // 撤掉页面顶部那块独立的「🎭 角色模型」，模型下拉直接嵌进设置 › 角色 的每张角色卡里。
    // 三个角色的模型来源不变：
    //   项目经理 = 宿主默认模型（点「新会话」建的就是它）
    //   大管家   = 换脑配置 butler-rotate.json
    //   星闪球   = 语音陪聊/播报 role-models.json
    //
    // 共享 store：roles.state 会去 llm.listModels()，三张卡各拉一次太浪费，拉一次三张卡共用。
    const roleStore = { data: null, error: '', at: 0, loading: false, subs: new Set() }
    function roleStoreNotify() {
      roleStore.subs.forEach((fn) => {
        try {
          fn()
        } catch {
          /* 单个订阅者报错不影响其他人 */
        }
      })
    }
    function roleStoreLoad(force) {
      if (!force && roleStore.data && Date.now() - roleStore.at < 15000) return
      if (roleStore.loading) return
      roleStore.loading = true
      call('roles.state')
        .then((value) => {
          roleStore.data = value
          roleStore.error = ''
          roleStore.at = Date.now()
        })
        .catch((e) => {
          roleStore.error = String((e && e.message) || e)
        })
        .finally(() => {
          roleStore.loading = false
          roleStoreNotify()
        })
    }

    const roleRowStyle = {
      borderTop: '1px solid var(--dsw-alias-border-l1)',
      padding: '7px 12px 9px',
      display: 'flex',
      flexDirection: 'column',
      gap: 5,
      minWidth: 0,
    }
    const roleBarStyle = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }
    const roleCapStyle = { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', flex: '0 0 auto' }
    const roleSelectStyle = {
      font: 'inherit',
      fontSize: 11.5,
      color: 'inherit',
      background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 7,
      padding: '3px 6px',
      flex: '1 1 auto',
      minWidth: 0,
    }
    const roleBtnStyle = {
      font: 'inherit',
      fontSize: 11.5,
      cursor: 'pointer',
      color: 'inherit',
      background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 7,
      padding: '3px 9px',
      flex: '0 0 auto',
    }
    const roleNoteStyle = { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: '15px', minWidth: 0, overflowWrap: 'anywhere' }

    /** 一张角色卡底部的模型行：下拉 + 保存 + 当前值。 */
    function RoleModelRow({ role }) {
      const [draft, setDraft] = useState(null)
      const [saving, setSaving] = useState(false)
      const [msg, setMsg] = useState('')
      const [, bump] = useState(0)

      useEffect(() => {
        const fn = () => bump((n) => n + 1)
        roleStore.subs.add(fn)
        roleStoreLoad()
        return () => roleStore.subs.delete(fn)
      }, [])

      const data = roleStore.data
      const info = data && Array.isArray(data.roles) ? data.roles.find((r) => r.id === role) : null
      const models = (data && data.models) || []

      if (!info) {
        return h(
          'div',
          { style: roleRowStyle },
          h(
            'div',
            { style: roleStore.error ? { ...roleNoteStyle, color: 'var(--dsw-alias-state-error-primary)' } : roleNoteStyle },
            roleStore.error ? '读取失败：' + roleStore.error : '加载中…',
          ),
        )
      }

      const current = info.provider + ':' + info.model
      const value = draft != null ? draft : current
      const options = models.slice()
      if (!options.some((m) => m.provider + ':' + m.model === current)) {
        options.unshift({ provider: info.provider, model: info.model, label: info.model + '（当前）' })
      }

      async function save() {
        const at = value.indexOf(':')
        if (at <= 0) return
        setSaving(true)
        setMsg('')
        try {
          const result = await call('roles.set', { role, provider: value.slice(0, at), model: value.slice(at + 1) })
          setMsg('✅ 已保存' + (result && result.note ? '（' + result.note + '）' : ''))
          setDraft(null)
          roleStoreLoad(true)
        } catch (e) {
          setMsg('保存失败：' + String((e && e.message) || e))
        } finally {
          setSaving(false)
        }
      }

      return h(
        'div',
        { style: roleRowStyle },
        h(
          'div',
          { style: roleBarStyle },
          h('span', { style: roleCapStyle }, '模型'),
          h(
            'select',
            {
              style: roleSelectStyle,
              value,
              'aria-label': '模型：' + info.label,
              onChange: (e) => setDraft(e.target.value),
            },
            options.map((m) =>
              h('option', { key: m.provider + ':' + m.model, value: m.provider + ':' + m.model }, (m.label || m.model) + ' · ' + m.provider),
            ),
          ),
          h(
            'button',
            { type: 'button', style: { ...roleBtnStyle, cursor: saving ? 'wait' : 'pointer' }, disabled: saving, onClick: () => void save() },
            saving ? '保存中…' : '保存',
          ),
        ),
        msg
          ? h('div', { style: roleNoteStyle }, msg)
          : h('div', { style: { ...roleNoteStyle, opacity: 0.8 } }, '当前：' + info.model + ' · ' + info.source),
      )
    }

    // ────────────────── 设置 › 供应商（一级入口是「设置」，这里是一级目录） ──────────────────
    // 模型中心不再是输入框旁边那个独立按钮（输入框右下角本来就有模型选择器），
    // 供应商管理降级成「设置」面板里的一个一级目录。
    function SuppliersSection() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [tick, setTick] = useState(0)
      const [hover, setHover] = useState('')

      useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const snapshot = await call('state')
            if (!alive) return
            setState(snapshot)
            setError('')
          } catch (e) {
            if (alive) setError(String((e && e.message) || e))
          }
        })()
        return () => {
          alive = false
        }
      }, [tick])

      const styles = {
        btn: {
          font: 'inherit',
          color: 'inherit',
          cursor: 'pointer',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 8,
          padding: '5px 11px',
          fontSize: 12.5,
          lineHeight: '18px',
          flex: '0 0 auto',
          whiteSpace: 'nowrap',
        },
        card: {
          display: 'block',
          width: '100%',
          textAlign: 'left',
          font: 'inherit',
          color: 'inherit',
          background: 'var(--dsw-alias-bg-layer-1)',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 12,
          padding: '12px 14px',
          marginBottom: 10,
          cursor: 'pointer',
        },
        row: { display: 'flex', alignItems: 'center', gap: 10 },
        title: { fontSize: 13, fontWeight: 600 },
        hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11.5 },
        badge: {
          fontSize: 11,
          padding: '1px 7px',
          borderRadius: 20,
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l1)',
          color: 'var(--dsw-alias-label-secondary)',
          whiteSpace: 'nowrap',
        },
      }

      const dot = (kind) =>
        h('span', {
          style: {
            width: 8,
            height: 8,
            borderRadius: '50%',
            display: 'inline-block',
            flex: '0 0 auto',
            background:
              kind === 'on'
                ? 'var(--dsw-alias-state-success-primary)'
                : kind === 'warn'
                  ? 'var(--dsw-alias-state-warn-primary)'
                  : 'var(--dsw-alias-state-idle-primary)',
          },
        })

      const providers = (state && state.providers) || []

      return h(
        'div',
        { style: { padding: '2px 0 24px' } },
        h(
          'div',
          { style: { ...styles.row, alignItems: 'flex-start', marginBottom: 14 } },
          h(
            'div',
            { style: { ...styles.hint, flex: '1 1 auto', minWidth: 0, lineHeight: '17px' } },
            '每家的 API Key 单独管理：Key 存进 DSH 凭据库后，模型选择器里立刻能用。会话右上角的齿轮是同一批数据的快捷入口。',
          ),
          h(
            'button',
            {
              type: 'button',
              style: {
                font: 'inherit',
                color: 'var(--dsw-alias-bg-base)',
                cursor: 'pointer',
                background: 'var(--dsw-alias-brand-primary)',
                border: 'none',
                borderRadius: 20,
                padding: '5px 13px',
                fontSize: 12.5,
                fontWeight: 600,
                lineHeight: '18px',
                flex: '0 0 auto',
                whiteSpace: 'nowrap',
              },
              onClick: () => openWindow('tops'),
            },
            '🏆 模型榜单',
          ),
          h(
            'button',
            { type: 'button', style: styles.btn, onClick: () => openWindow('pricing') },
            '📊 模型比价',
          ),
        ),
        error
          ? h(
              'div',
              { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, marginBottom: 10 } },
              '加载失败：' + error,
            )
          : null,
        state == null
          ? h('div', { style: { ...styles.hint, padding: '18px 0' } }, '加载中…')
          : providers.map((p) => {
              const isHover = hover === p.id
              return h(
                'button',
                {
                  key: p.id,
                  type: 'button',
                  style: isHover
                    ? {
                        ...styles.card,
                        borderColor: 'var(--dsw-alias-border-l2)',
                        background: 'var(--dsw-alias-bg-layer-2)',
                      }
                    : styles.card,
                  onMouseEnter: () => setHover(p.id),
                  onMouseLeave: () => setHover(''),
                  onClick: () => openWindow('key', { provider: p.id }),
                },
                h(
                  'div',
                  { style: styles.row },
                  dot(p.routed ? 'on' : p.linked ? 'warn' : 'off'),
                  h('div', { style: styles.title }, p.title),
                  h('div', { style: { flex: '1 1 auto' } }),
                  h('span', { style: styles.badge }, p.items.length ? p.items.length + ' 个 Key' : p.linked ? '已有 Key（系统配置）' : '尚未添加 Key'),
                  h('span', { style: styles.hint }, '›'),
                ),
                h(
                  'div',
                  { style: { ...styles.hint, marginTop: 3, paddingLeft: 17 } },
                  p.api +
                    (p.routed
                      ? ' · 已接入模型选择器'
                      : p.linked
                        ? ' · 有 Key 但路由没挂上'
                        : ' · 未接入'),
                ),
              )
            }),
        h(
          'div',
          { style: { ...styles.row, marginTop: 6 } },
          h(
            'div',
            { style: { ...styles.hint, flex: '1 1 auto', minWidth: 0 } },
            '模型价格对比单独开一扇「模型比价」窗口。',
          ),
          h(
            'button',
            { type: 'button', style: styles.btn, onClick: () => setTick(tick + 1) },
            '刷新列表',
          ),
        ),
      )
    }

    const DICT = {
      zh: {
        'section.label': '模型',
      },
      en: {
        'section.label': 'Models',
      },
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('modelHub', DICT))

        const t = (key) => {
          try {
            const value = ctx.locale.bind('modelHub')(key)
            return value == null ? key : String(value)
          } catch {
            return key
          }
        }

        // 设置面板里的一级目录：顶掉原生「模型」(API) 页，换成模型中心的供应商管理
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'models',
              order: 10,
              // 2026-11-15：DSH 0.2.2-rc.1 的官方 settings-models 也注册了 id "models"
              //（priority 默认 0），两者硬冲突导致整个 UI 启动失败
              //（"Failed to load plugins: invalid plugin … received undefined"）。
              // 注册时给更低 priority 即可按影子机制顶掉官方分区（lowest renders）。
              priority: -1,
              label: () => t('section.label'),
            },
            (ownerProps) => h(SuppliersSection, { ...(ownerProps || {}) }),
          ),
        )

        // ────────────────── 设置 › 角色（原「Agent 预设」）──────────────────
        // 官方页没开内部插槽，这里用 DOM 注入：
        //   ① nav 里文字是「Agent 预设 / Agent presets」的按钮 → 文字改「角色」并打标记
        //   ② 分区里残留的标题文字「Agent 预设」→ 同步改「角色」
        //   ③ butler/orb 两张角色卡（li[data-agent-preset-id]）底部嵌一行「模型 + 保存」；
        //      pm 卡不配模型（跟输入框走，只放说明行），见下 CARD_ROLES 注释。
        //      ——主人 2026-11-19：别再在页面顶部单开一块「角色模型」，上下分开看着傻。
        // 幂等：卡片由官方 React 渲染，行被重渲染吞掉时观察器会补回来（教训 40）。
        ctx.effect(() => {
          const ROW_FLAG = 'data-djh-role-model'
          const NOTE_FLAG = 'data-djh-role-note'
          const NAV_FLAG = 'data-djh-role-nav'
          /** 官方角色卡 id → 有模型可配的角色。
           *  主人 2026-11-19：项目经理（pm）不在这配模型——PM 跟着会话输入框里选的模型走，
           *  模型由主人在输入框临时指定（PM 对他负责），所以 pm 卡只放说明行、不配模型。 */
          const CARD_ROLES = ['butler', 'orb']
          /** li → { node, root } */
          const mounted = new Map()

          const isAgentPresetText = (text) => {
            const t = String(text || '').trim()
            return t === 'Agent 预设' || t === 'Agent presets'
          }

          const dropRow = (li) => {
            const item = mounted.get(li)
            if (item) {
              try {
                item.root.unmount()
              } catch {}
              item.node.remove()
              mounted.delete(li)
              return
            }
            // 没登记的残留节点（HMR/上一轮遗留）也清掉
            if (li && li.querySelector) li.querySelectorAll('[' + ROW_FLAG + ']').forEach((n) => n.remove())
          }

          const unmountAll = () => {
            Array.from(mounted.keys()).forEach(dropRow)
            mounted.clear()
            if (dtMounted) {
              try { dtMounted.root.unmount() } catch {}
              if (dtMounted.node.isConnected) dtMounted.node.remove()
              dtMounted = null
            }
            document.querySelectorAll('[' + DT_FLAG + ']').forEach((n) => n.remove())
            document.querySelectorAll('[' + ROW_FLAG + ']').forEach((n) => n.remove())
            document.querySelectorAll('[' + NOTE_FLAG + ']').forEach((n) => n.remove())
          }

          /** 官方卡片里的动作行（查看配置/编辑等）；模型行插在它前面，动作图标留在卡底 */
          const footOf = (li) => li.querySelector('[class*="cardFoot"]')

          const ensureRow = (li, roleId) => {
            const existing = li.querySelector('[' + ROW_FLAG + ']')
            const item = mounted.get(li)
            if (existing && item && item.node === existing && item.node.isConnected) return
            if (item) dropRow(li)
            else if (existing) existing.remove()
            const node = el('div')
            node.setAttribute(ROW_FLAG, roleId)
            const foot = footOf(li)
            if (foot) li.insertBefore(node, foot)
            else li.appendChild(node)
            const root = createRoot(node)
            root.render(h(RoleModelRow, { role: roleId }))
            mounted.set(li, { node, root })
          }

          /** 没有模型可配的卡，放一行说明把卡片撑齐（不然卡底一大块空白）。 */
          const NOTE_TEXT = {
            pm: '模型不固定：跟着会话输入框里选的模型走（主人说了算），这张卡不单独设。',
            standard: '模型不固定：大管家派单时按任务挑，这张卡不单独设。',
          }
          const ensureNote = (li, text) => {
            const note = li.querySelector('[' + NOTE_FLAG + ']')
            if (note) {
              note.textContent = text
              return
            }
            const n = el('div')
            n.setAttribute(NOTE_FLAG, '1')
            n.style.cssText =
              'border-top:1px solid var(--dsw-alias-border-l1);padding:7px 12px 9px;font-size:11px;' +
              'line-height:15px;color:var(--dsw-alias-label-secondary);'
            n.textContent = text
            const foot = footOf(li)
            if (foot) li.insertBefore(n, foot)
            else li.appendChild(n)
          }

          /** DeepTutor 卡（2026-11-19 主人拍板）：学习外挂的模型选择，样式贴官方角色卡。 */
          const DT_FLAG = 'data-djh-deeptutor-card'
          let dtMounted = null
          const ensureDeeptutorCard = (dialog) => {
            const existing = dialog.querySelector('[' + DT_FLAG + ']')
            if (existing && dtMounted && dtMounted.node === existing && existing.isConnected) return
            if (dtMounted) {
              try { dtMounted.root.unmount() } catch {}
              if (dtMounted.node.isConnected) dtMounted.node.remove()
              dtMounted = null
            }
            const orbLi = dialog.querySelector('li[data-agent-preset-id="orb"]')
            if (!orbLi || !orbLi.parentElement) return
            const li = el('li')
            li.setAttribute(DT_FLAG, '1')
            li.style.cssText =
              'position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;' +
              'background:var(--dsw-alias-bg-layer-1);overflow:hidden;min-width:0;display:flex;flex-direction:column;'
            orbLi.parentElement.appendChild(li)
            const root = createRoot(li)
            root.render(h(DeeptutorCard))
            dtMounted = { node: li, root }
          }

          function DeeptutorCard() {
            const [state, setState] = useState(null)
            const [draft, setDraft] = useState(null)
            const [saving, setSaving] = useState(false)
            const [msg, setMsg] = useState('')
            useEffect(() => {
              call('deeptutor.state').then(setState).catch((e) => setState({ error: String((e && e.message) || e) }))
            }, [])
            const models = (state && state.models) || []
            const current = (state && state.current) || ''
            const value = draft != null ? draft : current
            const options = models.slice()
            if (current && !options.some((m) => m.model === current)) {
              options.unshift({ model: current, label: current + '（当前）' })
            }
            async function save() {
              setSaving(true)
              setMsg('')
              try {
                const result = await call('deeptutor.set', { model: value })
                setMsg('✅ 已保存' + (result && result.note ? '（' + result.note + '）' : ''))
                setDraft(null)
                const fresh = await call('deeptutor.state')
                setState(fresh)
              } catch (e) {
                setMsg('保存失败：' + String((e && e.message) || e))
              } finally {
                setSaving(false)
              }
            }
            const headStyle = { padding: '18px 18px 0' }
            const titleStyle = { fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', display: 'flex', alignItems: 'center', gap: 8 }
            const chipStyle = {
              fontSize: 11, padding: '2px 8px', borderRadius: 999,
              background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)',
              border: '1px solid var(--dsw-alias-border-l1)',
            }
            const hintStyle = { fontSize: 12.5, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', marginTop: 8 }
            return h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 } },
              h('div', { style: headStyle },
                h('div', { style: titleStyle }, '🎓 DeepTutor', h('span', { style: chipStyle }, '学习外挂')),
                h('div', { style: hintStyle },
                  '概型论学习助手（E:\\deeptutor）：带读教材、出数学动画。模型在这里切——问数学用 DeepSeek，看图/动画审查用 GLM-4.1V。',
                ),
              ),
              h('div', { style: { ...roleRowStyle, marginTop: 'auto' } },
                state && state.error
                  ? h('div', { style: { ...roleNoteStyle, color: 'var(--dsw-alias-state-error-primary)' } }, state.error)
                  : !state
                    ? h('div', { style: roleNoteStyle }, '加载中…')
                    : h(
                      'div',
                      { style: roleBarStyle },
                      h('span', { style: roleCapStyle }, '模型'),
                      h(
                        'select',
                        { style: roleSelectStyle, value, 'aria-label': 'DeepTutor 模型', onChange: (e) => setDraft(e.target.value) },
                        options.map((m) => h('option', { key: m.model, value: m.model }, (m.label || m.model) + ' · ' + (m.provider || ''))),
                      ),
                      h(
                        'button',
                        { type: 'button', style: { ...roleBtnStyle, cursor: saving ? 'wait' : 'pointer' }, disabled: saving, onClick: () => void save() },
                        saving ? '保存中…' : '保存',
                      ),
                    ),
                msg
                  ? h('div', { style: roleNoteStyle }, msg)
                  : state && state.current
                    ? h('div', { style: { ...roleNoteStyle, opacity: 0.8 } }, '当前：' + state.current + ' · model_catalog.json（下一次调用即用）')
                    : null,
              ),
            )
          }

          const sync = () => {
            try {
              const dialog = document.querySelector('[data-shortcut-modal="settings"]')
              if (!dialog) {
                unmountAll()
                return
              }

              // ① nav 改名 + 打标记（按文字找 label span，不能按 span:last-child——图标容器里还有嵌套空 span）
              dialog.querySelectorAll('nav button').forEach((btn) => {
                const spans = Array.from(btn.querySelectorAll('span'))
                const labelSpan =
                  spans.find((s) => isAgentPresetText(s.textContent)) || spans.filter((s) => s.textContent && s.textContent.trim()).pop()
                if (!labelSpan) return
                if (btn.hasAttribute(NAV_FLAG)) {
                  if (labelSpan.textContent !== '角色' && !isAgentPresetText(labelSpan.textContent)) btn.removeAttribute(NAV_FLAG)
                }
                if (isAgentPresetText(labelSpan.textContent)) {
                  btn.setAttribute(NAV_FLAG, '1')
                  labelSpan.textContent = '角色'
                }
              })

              const active = dialog.querySelector('nav button[aria-current="true"]')
              const isRoleSection = !!(active && active.hasAttribute(NAV_FLAG))
              const host = dialog.querySelector('[class*="options"]')

              if (!isRoleSection || !host) {
                unmountAll()
                return
              }

              // ② 卡片没了/被 React 重渲染换掉 → 先清理，再按需补挂
              Array.from(mounted.entries()).forEach(([li, item]) => {
                if (!li.isConnected || !item.node.isConnected) dropRow(li)
              })
              dialog.querySelectorAll('[' + NOTE_FLAG + ']').forEach((n) => {
                if (!n.closest('li[data-agent-preset-id]')) n.remove()
              })
              CARD_ROLES.forEach((roleId) => {
                const li = dialog.querySelector('li[data-agent-preset-id="' + roleId + '"]')
                if (li) ensureRow(li, roleId)
              })
              ensureDeeptutorCard(dialog)

              Object.keys(NOTE_TEXT).forEach((roleId) => {
                const li = dialog.querySelector('li[data-agent-preset-id="' + roleId + '"]')
                if (li) ensureNote(li, NOTE_TEXT[roleId])
              })

              // ③ 分区内残留标题改名（React 重渲染会被打回，观察器再改回来）
              const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
              let node
              while ((node = walker.nextNode())) {
                if (isAgentPresetText(node.nodeValue)) node.nodeValue = '角色'
              }
            } catch (e) {
              console.error('[dsh-model-hub] role-tab sync error:', e)
            }
          }

          // 全站 mutation 都会触发，节流 150ms 防刷屏
          let scheduled = false
          const obs = new MutationObserver(() => {
            if (scheduled) return
            scheduled = true
            setTimeout(() => {
              scheduled = false
              sync()
            }, 150)
          })
          obs.observe(document.body, { childList: true, subtree: true, characterData: true })
          sync()

          return () => {
            obs.disconnect()
            unmountAll()
          }
        })

        ctx.effect(() => {
          // ── 输入框模型菜单价格角标（2026-11-19 v0.177，主人要「价格呈现在模型旁边」）──
          // 官方模型选择菜单项 = [role="menuitemradio"]（见 evals/opencode-task-refactor.txt）。
          // 价格来自 /model-hub-api state（比价缓存 + 别名账本），10 分钟刷新。
          // 幂等：已打 data-djh-price-tag 的项跳过；菜单是官方 React 临时挂载的，HMR/重开都安全。
          const TAG = 'data-djh-price-tag'
          const priceMap = new Map() // 归一化模型名 → {text, title}
          // 魔搭免费模型的余额（魔粒）——主人 2026-11-19：「说是免费其实有余额，把余额也放在这里」
          let msBalance = null // { value: Number|null, stale: Boolean, at: Number }
          async function loadMsBalance() {
            try {
              const r = await fetch('/status-pills-api/ms', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ force: true }),
                credentials: 'same-origin',
              })
              const j = await r.json()
              const v = j && j.ok && j.value
              if (v) {
                msBalance = {
                  value: v.magicube == null ? null : Number(v.magicube),
                  earned: Number(v.earned) || 0,
                  stale: !!v.stale,
                  at: Date.now(),
                }
                sweep(true)
              }
            } catch {
              /* 取不到就不写余额，不影响价格角标 */
            }
          }
          const norm = (s) =>
            String(s || '')
              .toLowerCase()
              .replace(/\s+/g, '')
              .replace(/（[^）]*）/g, '')
              .replace(/\([^)]*\)/g, '')
          const fmtPair = (a, b) => {
            const f = (v) => (v == null ? null : v === 0 ? '0' : v >= 100 ? String(Math.round(v)) : String(v))
            const x = f(a)
            const y = f(b)
            if (x == null && y == null) return null
            if (x != null && y != null && x !== y) return x + '/' + y
            return x != null ? x : y
          }
          async function loadPrices() {
            try {
              const state = await call('state')
              const addKey = (k, entry) => {
                // 不许覆盖：正式价目家在前，后写的（目录家）一律让位——
                // v0.177.1 教训：models.dev 目录里 'deepseek-v4-pro'/'glm-5.3' 同 id 条目
                // 价格字段缺失 → 被误判免费且覆盖了 DeepSeek/GLM 正确价（主人抓包怒斥）
                if (k && !priceMap.has(norm(k))) priceMap.set(norm(k), entry)
              }
              for (const prov of state.prices || []) {
                // 只信人工维护的价目家；providerKey 为空的是 models.dev 抓的大目录，
                // 价格字段经常缺 → 误判免费，宁可 miss 也不乱标
                if (!prov || !prov.providerKey) continue
                for (const m of prov.models || []) {
                  const p = m.price || {}
                  const unit = p.unit || '元'
                  const miss = p.inputMiss || {}
                  const hit = p.inputHit || {}
                  const out = p.output || {}
                  const hasNum =
                    num(miss.offpeak) != null ||
                    num(miss.peak) != null ||
                    num(out.offpeak) != null ||
                    num(out.peak) != null
                  if (!hasNum) continue
                  const free = !!(m.free || ((miss.offpeak || 0) === 0 && (out.offpeak || 0) === 0 && unit === '元'))
                  const pair = fmtPair(num(miss.offpeak), num(out.offpeak))
                  const text = free ? '免费' : pair ? (unit === '积分' ? '积分 ' : '¥') + pair : null
                  if (!text) continue
                  const titleBits = []
                  titleBits.push('输入（缓存未命中）：' + fmtPair(num(miss.offpeak), num(miss.peak)) + ' ' + unit + '/百万')
                  titleBits.push('缓存命中：' + (num(hit.offpeak) != null ? num(hit.offpeak) + ' ' + unit : '—') + '/百万')
                  titleBits.push('输出：' + (num(out.offpeak) != null ? num(out.offpeak) + ' ' + unit : '—') + '/百万')
                  if (num(miss.peak) != null && num(miss.peak) !== num(miss.offpeak)) titleBits.push('峰值输入 ' + num(miss.peak) + ' ' + unit + '（平时按谷价）')
                  titleBits.push('口径：元或积分 / 每百万 tokens；数据来自模型中心比价表')
                  const entry = { text, title: titleBits.join('\n'), ms: prov.providerKey === 'modelscope' }
                  addKey(m.name, entry)
                  addKey(String(m.id || ''), entry)
                }
              }
              for (const [routeModel, alias] of Object.entries(state.aliases || {})) {
                const idPart = routeModel.split(':').pop() || ''
                // 价目表里静态家只有 name 没有 id（如硅基只有「Qwen3-8B（免费·硅基）」）
                // → 路由 id 'qwen/qwen3-8b' 先整查，再剥命名空间前缀兜底
                const src = priceMap.get(norm(idPart)) || priceMap.get(norm(idPart.split('/').pop()))
                if (src && alias) addKey(alias, src)
              }
              sweep()
            } catch {
              /* 没数据就不标，不打扰 */
            }
          }
          function sweep(refresh) {
            let items
            try {
              items = document.querySelectorAll('[role="menuitemradio"]')
            } catch {
              return
            }
            for (const item of items) {
              if (!(item instanceof Element)) continue
              if (item.hasAttribute(TAG) && !refresh) continue
              const label = norm(item.textContent)
              if (!label) continue
              const hit = priceMap.get(label)
              if (!hit) continue
              item.setAttribute(TAG, '1')
              let span = item.querySelector(':scope > span[' + TAG + ']')
              if (!span) {
                span = document.createElement('span')
                span.setAttribute(TAG, '1')
                span.style.cssText =
                  'margin-left:auto;padding-left:10px;font-size:11px;line-height:1;opacity:.62;white-space:nowrap;flex:0 0 auto;'
                item.appendChild(span)
              }
              // 魔搭免费模型：价格后面补「· 魔粒 N」（余额见底就换行提示充值）
              let text = hit.text
              let title = hit.title
              if (hit.ms) {
                const bal = msBalance
                if (bal) {
                  const n = bal.value
                  const today = bal.earned ? ' · 今+' + bal.earned : ''
                  text = bal.stale ? text + ' · 魔粒 —' : text + ' · 魔粒 ' + (n == null ? '—' : n) + today
                  title +=
                    '\n—\n魔搭魔粒余额：' +
                    (bal.stale ? '今天还没登录（数字可能不准）' : n == null ? '没读到' : n + ' 粒') +
                    (bal.earned ? '（今天已发 +' + bal.earned + '）' : '') +
                    '\n按次扣：轻量 0.5 / 主流 1 / 旗舰 2 粒一次；余额见底后这些「免费」模型会调不动'
                }
              }
              span.textContent = text
              span.title = title
              const cs = getComputedStyle(item)
              if (cs.display && cs.display !== 'flex') {
                item.style.display = 'flex'
                item.style.alignItems = 'center'
              }
            }
          }
          const obs = new MutationObserver(() => sweep())
          if (document.body) obs.observe(document.body, { childList: true, subtree: true })
          sweep()
          loadPrices()
          const iv = setInterval(loadPrices, 10 * 60 * 1000)
          const ivMs = setInterval(loadMsBalance, 5 * 60 * 1000)
          void loadMsBalance()
          return () => {
            obs.disconnect()
            clearInterval(iv)
            clearInterval(ivMs)
            document.querySelectorAll('[' + TAG + ']').forEach((n) => {
              if (n.hasAttribute(TAG)) n.removeAttribute(TAG)
              if (n.getAttribute('data-djh-price-tag') != null) n.removeAttribute('data-djh-price-tag')
              if (n.tagName === 'SPAN') n.remove()
            })
          }
        })

        ctx.effect(() => {
          const obs = new MutationObserver(() => syncAllThemes())
          const target = document.documentElement
          obs.observe(target, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
          if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
          const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
          const onChange = () => syncAllThemes()
          if (mq && mq.addEventListener) mq.addEventListener('change', onChange)
          return () => {
            obs.disconnect()
            if (mq && mq.removeEventListener) mq.removeEventListener('change', onChange)
          }
        })
      },
    }
  },
})
