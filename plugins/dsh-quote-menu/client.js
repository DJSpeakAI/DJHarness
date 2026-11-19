/**
 * 划词菜单（Client 半）
 *
 * 现状：DSH 自带的 @deepseek-ai/dsh-message-quotes 只会弹一颗「引用文本」小胶囊，
 *       点一下把选中文字塞进输入框，没有出处、也没有「换个会话说」这条路。
 * 本插件把它换成两段式菜单：
 *
 *   第一段：「问 AI」/「引用」（PC 右键菜单里还有「复制」，因为我们接管了右键）
 *   第二段：点「引用」之后才展开 ——「当前会话」/「新建会话」
 *
 * 触发方式两端不同：
 *   PC   —— 拖选完**不弹**，右键才弹（竖排菜单，落在鼠标位置）
 *   手机 —— 双击/长按选词后直接弹（横排小胶囊）
 *
 * 落地：
 *   「问 AI」     → 在页面上浮出一个**临时小窗**（不是新页面、不是真弹窗）：
 *                   顶上带模型选择（读的是 composer 那个选择器同一份目录
 *                   ctx.modelDirectories），后台自动把整段会话历史当上下文，
 *                   问完可以接着追问，关掉即丢，**不写进主会话**。
 *   「当前会话」   → inputActions.insertText(出处行) + insertQuote(原文)，插进当前输入框
 *   「新建会话」   → uiWorkspace.forkSession() 分支出完整继承历史的新会话，打开它，
 *                    等输入框就绪后再把同样的「出处行 + 引用块」插进去
 *
 * 整页生效：聊天区、设置弹窗、插件页、右栏文档预览、工具输出……有文字的地方选中就能用；
 * 只有可编辑处（输入框/编辑器）和问 AI 小窗让给浏览器。「引用」仅出现在聊天区消息行上（要标出处）。
 * 官方那颗胶囊用一行 CSS 藏掉，不覆盖它的注册，所以输入框里 QuoteNode 的渲染仍归官方。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-quote-menu',
  factory(require) {
    const React = require('react')

    /** 聊天行的类型属性（chat flow 给每一行打的标记）。 */
    const ROW_ATTR = 'data-chat-flow-kind'
    /** 行类型的显示名。 */
    const KIND_LABEL = {
      user: '你',
      'assistant-step': 'AI',
      'tool-call': '工具',
      'question-reply': '提问',
      'turn-process': '过程',
      'turn-trigger': '触发',
      steering: '插话',
      command: '命令',
      'command-input': '命令',
      'model-retry': '重试',
      'turn-error': '错误',
    }
    /** 问 AI 的后端前缀（与 host index.js 的 ROUTE 必须一致）。 */
    const ASK_API = '/quote-menu-api'

    const CSS = [
      /* 官方那颗「引用文本」胶囊让位给本插件 */
      '[data-slot="conversation.chat.text-interaction"]{display:none!important}',
      '[data-dqh-quote-bar]{position:fixed;left:0;top:0;z-index:2147483000;',
      'background:var(--dsw-alias-button-floating-fill,#2b2b2e);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));',
      'box-shadow:var(--dsw-elevation-panel,0 10px 30px rgba(0,0,0,.45));',
      'color:var(--dsw-alias-label-primary,#f5f6f7);',
      'font:var(--dsw-font-xs-13,13px/1.25 system-ui,-apple-system,"Segoe UI",sans-serif);',
      'visibility:hidden;user-select:none;-webkit-user-select:none}',
      '[data-dqh-quote-bar][data-open]{visibility:visible;animation:dqhBarIn .12s ease-out}',
      /* 手机：横排小胶囊 */
      '[data-dqh-quote-bar][data-mode="pill"]{display:flex;align-items:center;padding:3px;border-radius:999px}',
      '[data-dqh-quote-bar][data-mode="pill"] i{width:1px;height:14px;flex:none;margin:0 1px;',
      'background:var(--dsw-alias-border-l3,rgba(255,255,255,.16))}',
      /* PC 右键：竖排菜单 */
      '[data-dqh-quote-bar][data-mode="menu"]{display:block;padding:4px;border-radius:12px;min-width:136px;',
      'background:color-mix(in srgb,var(--dsw-alias-bg-base,#1a1c1f) 90%,var(--dsw-alias-label-primary,#f9fafb))}',
      '[data-dqh-quote-bar] button{appearance:none;-webkit-appearance:none;border:none;background:transparent;',
      'color:inherit;font:inherit;cursor:pointer;white-space:nowrap;',
      'touch-action:manipulation;line-height:1.2;transition:background .12s}',
      '[data-dqh-quote-bar][data-mode="pill"] button{padding:4px 11px;border-radius:999px}',
      '[data-dqh-quote-bar][data-mode="menu"] button{display:block;width:100%;text-align:left;',
      'padding:7px 12px;border-radius:8px}',
      '[data-dqh-quote-bar] button:hover{background:var(--dsw-alias-button-floating-hover,rgba(255,255,255,.1))}',
      '[data-dqh-quote-bar] button:active{transform:translateY(.5px)}',
      '[data-dqh-quote-bar] button[data-busy]{opacity:.6;cursor:default;pointer-events:none}',
      '[data-dqh-quote-bar] button[data-error]{color:var(--dsw-alias-label-error,#ff6b6b)}',
      '@keyframes dqhBarIn{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}',
      '@media (max-width:520px){[data-dqh-quote-bar][data-mode="pill"]{padding:4px}',
      '[data-dqh-quote-bar][data-mode="pill"] button{padding:8px 14px}}',

      /* ---------- 问 AI 小浮窗 ---------- */
      '[data-dqai-panel]{display:none;flex-direction:column;position:fixed;left:0;top:0;z-index:2147482990;',
      'width:420px;max-width:calc(100vw - 20px);height:min(560px,72vh);border-radius:14px;overflow:hidden;',
      'background:var(--dsw-alias-button-floating-fill,#2c2c2e);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));',
      'box-shadow:var(--dsw-elevation-panel,0 16px 44px rgba(0,0,0,.5));',
      'color:var(--dsw-alias-label-primary,#f5f6f7);',
      'font:var(--dsw-font-sm-14,14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif);',
      'user-select:text;-webkit-user-select:text}',
      '[data-dqai-panel][data-open]{display:flex;animation:dqhBarIn .12s ease-out}',
      '[data-dqai-head]{flex:none;display:flex;align-items:center;gap:6px;padding:7px 8px 7px 12px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09));cursor:move;user-select:none}',
      '[data-dqai-title]{font-size:13px;font-weight:600;letter-spacing:.02em;white-space:nowrap}',
      '[data-dqai-title]::before{content:"✦";margin-right:5px;color:var(--dsw-alias-brand-primary,#4d8cff)}',
      '[data-dqai-model]{margin-left:auto;display:inline-flex;align-items:center;gap:4px;max-width:190px;',
      'padding:3px 7px 3px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));',
      'background:transparent;color:var(--dsw-alias-label-secondary,#a8adb6);font-size:12px;cursor:pointer;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '[data-dqai-model]:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));',
      'color:var(--dsw-alias-label-primary,#f5f6f7)}',
      '[data-dqai-model] i{font-style:normal;opacity:.65;font-size:10px;flex:none}',
      '[data-dqai-close]{flex:none;width:26px;height:26px;border-radius:7px;border:none;background:transparent;',
      'color:var(--dsw-alias-label-secondary,#a8adb6);font:inherit;font-size:13px;cursor:pointer;line-height:1}',
      '[data-dqai-close]:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08));',
      'color:var(--dsw-alias-label-primary,#f5f6f7)}',
      '[data-dqai-models]{display:none;position:absolute;left:8px;right:8px;top:46px;max-height:280px;',
      'overflow:auto;padding:5px;border-radius:10px;z-index:3;',
      'background:var(--dsw-alias-bg-layer-2,#35363a);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));',
      'box-shadow:0 14px 34px rgba(0,0,0,.55)}',
      '[data-dqai-models][data-open]{display:block}',
      '[data-dqai-grp]{padding:6px 8px 3px;font-size:11px;letter-spacing:.04em;',
      'color:var(--dsw-alias-label-secondary,#9096a0)}',
      '[data-dqai-opt]{display:flex;width:100%;align-items:center;gap:8px;padding:6px 9px;border:none;',
      'border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}',
      '[data-dqai-opt]:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.07))}',
      '[data-dqai-opt][data-on]{color:var(--dsw-alias-brand-primary,#4d8cff);font-weight:600}',
      '[data-dqai-empty]{padding:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#9096a0)}',
      '[data-dqai-quote]{flex:none;margin:8px 10px 0;padding:5px 9px;border-radius:6px;',
      'border-left:2px solid var(--dsw-alias-brand-primary,#4d8cff);',
      'background:color-mix(in srgb,var(--dsw-alias-bg-base,#151517) 55%,transparent);',
      'font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary,#a8adb6);',
      'max-height:58px;overflow:hidden;white-space:pre-wrap;word-break:break-word;user-select:none}',
      '[data-dqai-note]{flex:none;padding:4px 12px 0;font-size:11px;',
      'color:var(--dsw-alias-state-warn-primary,#e0a12b)}',
      '[data-dqai-log]{flex:1;min-height:0;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:9px}',
      '[data-dqai-msg]{font-size:13px;line-height:1.62;white-space:pre-wrap;word-break:break-word}',
      '[data-dqai-msg][data-role="user"]{align-self:flex-end;max-width:88%;padding:5px 10px;border-radius:10px;',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d8cff) 20%,var(--dsw-alias-bg-layer-2,#26282c))}',
      '[data-dqai-msg][data-role="assistant"]{align-self:stretch;padding:0 1px}',
      '[data-dqai-msg][data-role="error"]{align-self:stretch;padding:0 1px;',
      'color:var(--dsw-alias-state-error-primary,#ff6b6b)}',
      '[data-dqai-msg][data-pending]::after{content:"▌";opacity:.55;animation:dqhBlink 1s steps(2) infinite}',
      '@keyframes dqhBlink{50%{opacity:0}}',
      '[data-dqai-foot]{flex:none;display:flex;align-items:flex-end;gap:8px;padding:8px 10px 10px;',
      'border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09))}',
      '[data-dqai-input]{flex:1;resize:none;min-height:34px;max-height:120px;padding:7px 10px;border-radius:9px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));',
      'background:var(--dsw-alias-bg-layer-1,#1b1d20);color:inherit;font:inherit;font-size:13px;',
      'line-height:1.45;outline:none;user-select:text;-webkit-user-select:text}',
      '[data-dqai-input]:focus{border-color:var(--dsw-alias-brand-primary,#4d8cff)}',
      '[data-dqai-send]{flex:none;height:34px;padding:0 14px;border-radius:9px;border:none;',
      'background:var(--dsw-alias-brand-primary,#4d8cff);color:var(--dsw-alias-bg-base,#151517);',
      'font:inherit;font-size:13px;font-weight:600;cursor:pointer}',
      '[data-dqai-send][data-mode="stop"]{background:transparent;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.2));color:var(--dsw-alias-label-primary,#f5f6f7)}',
      '[data-dqai-send]:disabled{opacity:.5;cursor:default}',
      '@media (max-width:520px){[data-dqai-panel]{width:calc(100vw - 16px);height:min(62vh,480px)}}',
    ].join('')

    /** 插件内单例状态。 */
    const S = {
      ctx: null,
      sessionId: null,
      inputActions: null,
      /** childSessionId -> { text, at }，等该会话输入框挂载后插入 */
      pending: new Map(),
      bar: null,
      /** 当前要引用的原文 */
      text: '',
      /** 出处行 */
      source: '',
      /** 选区所在的聊天行（不在聊天区就是 null）；只有它在时才有「引用 / 新建会话」 */
      row: null,
      /** 浮条定位锚点：{type:'point',x,y} 或 {type:'rect',rect} */
      anchor: null,
      /** 'pill'（手机横排）| 'menu'（PC 右键竖排） */
      mode: 'pill',
      /** 1 = 只有「问 AI（+ 引用 / 复制）」；2 = 「当前会话 / 新建会话」 */
      stage: 1,
      busy: false,
      selTimer: 0,
      labelTimer: 0,
      /** 最近一次指针类型：mouse / touch / pen */
      lastPointer: 'mouse',
      /** 问 AI 小浮窗的全部状态 */
      ask: {
        panel: null,
        open: false,
        sessionId: null,
        quote: '',
        anchor: null,
        /** [{ role:'user'|'assistant', text, show }]，text 发给模型，show 是屏幕上显示的 */
        turns: [],
        busy: false,
        abort: null,
        /** { provider, model, name } */
        model: null,
        /** [{ id, name, models:[{id,name}] }] */
        groups: null,
        loading: false,
        modelsOpen: false,
        watched: false,
      },
    }

    function esc(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => {
        if (c === '&') return '&amp;'
        if (c === '<') return '&lt;'
        if (c === '>') return '&gt;'
        if (c === '"') return '&quot;'
        return '&#39;'
      })
    }

    /** 当前会话标题（给「引用自《…》」用）。 */
    function titleOf(id) {
      const ctx = S.ctx
      if (!ctx || !id) return ''
      try {
        const snap = ctx.sessions.list.getSnapshot()
        const row = snap && snap.byId ? snap.byId[id] : null
        if (row && typeof row.title === 'string' && row.title.trim()) return row.title.trim()
      } catch {
        /* 列表还没就绪就当没有标题 */
      }
      return ''
    }

    /** 选区所在的元素（文本节点取其父元素）。 */
    function elementOf(range) {
      const node = range.commonAncestorContainer
      const el = node && node.nodeType === 3 ? node.parentElement : node
      return el && el.closest ? el : null
    }

    /** 选区所在的那条聊天行；不是聊天区里的文字就返回 null。 */
    function rowOf(range) {
      const el = elementOf(range)
      if (!el) return null
      return el.closest('[' + ROW_ATTR + ']')
    }

    /** 选区在不在「可编辑的地方」（输入框 / 编辑器）——那里必须让浏览器原生菜单留着，
     *  不然剪切/粘贴/全选就没了。 */
    function editableOf(range) {
      const el = elementOf(range)
      if (!el) return null
      const tag = String(el.tagName || '').toUpperCase()
      if (tag === 'INPUT' || tag === 'TEXTAREA') return el
      const host = el.closest('[contenteditable], [role="textbox"]')
      if (!host) return null
      // contenteditable="false" 的子节点不算
      if (host.tagName === 'INPUT' || host.tagName === 'TEXTAREA') return host
      if (typeof host.isContentEditable === 'boolean' && host.isContentEditable) return host
      return null
    }

    /** 选区在不在「问 AI 小窗」里——小窗里选字要能正常复制，还给浏览器。 */
    function inAskPanel(range) {
      const el = elementOf(range)
      if (!el) return false
      return !!el.closest('[data-dqai-panel]')
    }

    /** 出处行：引用自《标题》· 第 N 轮 · 谁 */
    function sourceLine(row) {
      const title = titleOf(S.sessionId) || '当前会话'
      const turn = row ? row.getAttribute('data-chat-turn') : ''
      const kind = row ? row.getAttribute(ROW_ATTR) : ''
      const who = KIND_LABEL[kind] || ''
      let line = '引用自《' + title + '》'
      if (turn) line += ' · 第 ' + turn + ' 轮'
      if (who) line += ' · ' + who
      return line
    }

    /** 取一段能定位浮条的矩形；跨行选区只看第一行。 */
    function rectOf(range) {
      const rects = range.getClientRects()
      for (let i = 0; i < rects.length; i += 1) {
        const r = rects[i]
        if (r && (r.width > 1 || r.height > 1)) return r
      }
      const box = range.getBoundingClientRect()
      if (box && (box.width > 1 || box.height > 1)) return box
      return null
    }

    /** 引用块的正文：出处一行 + 空行 + 原文（官方会编码成 `> ` 逐行的 Markdown 引用）。 */
    function payloadOf(text, source) {
      return source ? source + '\n\n' + text : text
    }

    function clearSelection() {
      try {
        const sel = window.getSelection()
        if (sel) sel.removeAllRanges()
      } catch {
        /* 无选区时忽略 */
      }
    }

    /** 手机上的原生划词条（复制/全选/翻译/分享/搜索/问问小艺）是浏览器 App 自己画的，
     *  网页没有权限删它；但那条是跟着选区走的 —— 选完把选区收掉，它自己就收了。
     *  文字已经存进 S.text，复制/引用/问 AI 全都不依赖实时选区，所以收掉不亏。
     *  开关：localStorage['dqh:clear-native'] = '0' 关掉（默认开）。 */
    function clearNativeEnabled() {
      try {
        return localStorage.getItem('dqh:clear-native') !== '0'
      } catch {
        return true
      }
    }

    /** 手机路径：我的浮条先立住，再把系统选区收掉 → 只留我这一条。 */
    function dropNativeSelection() {
      if (S.lastPointer === 'mouse') return
      if (!clearNativeEnabled()) return
      if (S.dropNativeTimer) clearTimeout(S.dropNativeTimer)
      S.dropNativeTimer = setTimeout(() => {
        S.dropNativeTimer = null
        if (!isOpen() || !S.text) return
        S.keepWhenCollapsed = true
        clearSelection()
      }, 90)
    }

    /** 第一段 / 第二段的按钮清单。 */
    function itemsFor() {
      if (S.stage === 2) {
        return [
          { act: 'here', label: '当前会话' },
          { act: 'new', label: '新建会话' },
        ]
      }
      const list = [{ act: 'ask', label: '问 AI' }]
      // 「引用」要有出处（出自哪个会话第几轮谁说的），所以只在聊天行里出现
      if (S.row) list.push({ act: 'quote', label: '引用' })
      // PC 右键接管了原生菜单，得把「复制」补回去
      if (S.mode === 'menu') list.push({ act: 'copy', label: '复制' })
      return list
    }

    function paint() {
      const bar = S.bar
      if (!bar) return
      bar.setAttribute('data-mode', S.mode)
      bar.innerHTML = itemsFor()
        .map((it) => '<button type="button" data-act="' + it.act + '">' + it.label + '</button>')
        .join(S.mode === 'pill' ? '<i></i>' : '')
    }

    /** 把浮条摆到锚点位置：手机上贴选区上方，PC 上落在鼠标点。 */
    function place() {
      const bar = S.bar
      if (!bar || !S.anchor) return
      bar.removeAttribute('data-open')
      bar.style.left = '0px'
      bar.style.top = '0px'
      const w = bar.offsetWidth
      const h = bar.offsetHeight
      const vw = window.innerWidth
      const vh = window.innerHeight
      let left
      let top
      if (S.anchor.type === 'point') {
        left = S.anchor.x
        top = S.anchor.y
        if (left + w > vw - 8) left = vw - w - 8
        if (top + h > vh - 8) top = S.anchor.y - h
        left = Math.max(8, left)
        top = Math.max(8, top)
      } else {
        const rect = S.anchor.rect
        left = rect.left + rect.width / 2 - w / 2
        left = Math.max(8, Math.min(left, vw - w - 8))
        top = rect.top - h - 8
        if (top < 8) top = rect.bottom + 8
        top = Math.max(8, Math.min(top, vh - h - 8))
      }
      bar.style.left = Math.round(left) + 'px'
      bar.style.top = Math.round(top) + 'px'
      bar.setAttribute('data-open', '')
    }

    /** 打开到第一段。 */
    function openWith(anchor, mode) {
      S.anchor = anchor
      S.mode = mode
      S.stage = 1
      paint()
      place()
    }

    function isOpen() {
      return !!(S.bar && S.bar.hasAttribute('data-open'))
    }

    function hide() {
      if (!S.bar) return
      S.keepWhenCollapsed = false
      if (S.dropNativeTimer) {
        clearTimeout(S.dropNativeTimer)
        S.dropNativeTimer = null
      }
      S.bar.removeAttribute('data-open')
      S.text = ''
      S.source = ''
      S.row = null
      S.anchor = null
      S.stage = 1
    }

    /** 浮条上的短暂提示（失败时用），不打断操作。 */
    function flash(act, message) {
      const btn = S.bar && S.bar.querySelector('button[data-act="' + act + '"]')
      if (!btn) return
      const original = btn.textContent
      btn.setAttribute('data-error', '')
      btn.textContent = message
      if (S.labelTimer) clearTimeout(S.labelTimer)
      S.labelTimer = setTimeout(() => {
        btn.removeAttribute('data-error')
        btn.textContent = original
      }, 1600)
    }

    // ---------- 问 AI：模型目录 ----------

    /** 会话级模型目录（跟 composer 右下角那个选择器同一个实例）。 */
    function modelDir() {
      const ctx = S.ctx
      const id = S.ask.sessionId
      if (!ctx || !id || typeof ctx.get !== 'function') return null
      try {
        const models = ctx.get('modelDirectories')
        if (!models || typeof models.directoryFor !== 'function') return null
        return models.directoryFor(id)
      } catch {
        return null
      }
    }

    function labelOf(selection) {
      const groups = (S.ask.groups || [])
      for (const group of groups) {
        if (group.id !== selection.provider) continue
        for (const model of group.models || []) {
          if (model.id === selection.model) return model.name || model.id
        }
      }
      return selection.model
    }

    /** 目录快照 → 本地 groups/默认选择。 */
    function absorbSnapshot(state) {
      if (!state) return
      const groups = Array.isArray(state.groups) ? state.groups : []
      if (groups.length) S.ask.groups = groups
      const current = state.current
      if (current && current.provider && current.model && !S.ask.model) {
        S.ask.model = { provider: current.provider, model: current.model, name: labelOf(current) }
      }
    }

    /** 目录变了就同步；只在面板开着时刷新界面。 */
    function watchDirectory(dir) {
      const ask = S.ask
      if (ask.watched || !dir) return
      const store = dir.store
      if (!store || typeof store.subscribe !== 'function') return
      ask.watched = true
      try {
        store.subscribe(() => {
          absorbSnapshot(store.getSnapshot())
          if (!S.ask.open) return
          renderModelChip()
          if (S.ask.modelsOpen) renderModelMenu()
        })
      } catch {
        ask.watched = false
      }
    }

    /** 拿模型清单：优先 composer 的目录，拿不到就问宿主兜底接口。 */
    async function ensureCatalog() {
      const ask = S.ask
      const dir = modelDir()
      if (dir) {
        watchDirectory(dir)
        try {
          absorbSnapshot(ask.groups && ask.groups.length ? null : dir.store.getSnapshot())
          await dir.load()
          absorbSnapshot(dir.store.getSnapshot())
        } catch {
          /* 目录炸了就靠兜底 */
        }
      }
      if (!ask.model) pickFirstModel()
      if (ask.groups && ask.groups.length) return
      if (ask.loading) return
      ask.loading = true
      try {
        const res = await fetch(ASK_API + '/models', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        const data = await res.json()
        const value = data && data.ok ? data.value : null
        if (value && Array.isArray(value.providers) && value.providers.length) {
          ask.groups = value.providers
          if (!ask.model && value.current && value.current.provider) {
            ask.model = {
              provider: value.current.provider,
              model: value.current.model,
              name: labelOf(value.current),
            }
          }
          pickFirstModel()
        }
      } catch {
        /* 兜底也失败就显示「选择模型」 */
      } finally {
        ask.loading = false
      }
    }

    function pickFirstModel() {
      const ask = S.ask
      if (ask.model && ask.model.provider && ask.model.model) return
      for (const group of ask.groups || []) {
        for (const model of group.models || []) {
          ask.model = { provider: group.id, model: model.id, name: model.name || model.id }
          return
        }
      }
    }

    function renderModelChip() {
      const panel = S.ask.panel
      if (!panel) return
      const chip = panel.querySelector('[data-dqai-model]')
      if (!chip) return
      const model = S.ask.model
      const label = model ? model.name || model.model : S.ask.groups ? '选择模型' : '模型加载中…'
      chip.innerHTML = '<span>' + esc(label) + '</span><i>▾</i>'
      chip.setAttribute('title', model ? '当前模型：' + label + '（点一下换一个）' : '选择模型')
    }

    function renderModelMenu() {
      const panel = S.ask.panel
      if (!panel) return
      const menu = panel.querySelector('[data-dqai-models]')
      if (!menu) return
      const groups = S.ask.groups || []
      if (!groups.length) {
        menu.innerHTML = '<div data-dqai-empty>' + (S.ask.loading ? '模型清单加载中…' : '没有拿到模型清单') + '</div>'
        return
      }
      const current = S.ask.model
      const rows = []
      for (const group of groups) {
        const models = group.models || []
        if (!models.length) continue
        rows.push('<div data-dqai-grp>' + esc(group.name || group.id) + '</div>')
        for (const model of models) {
          const on = current && current.provider === group.id && current.model === model.id
          rows.push(
            '<button type="button" data-dqai-opt data-p="' +
              esc(group.id) +
              '" data-m="' +
              esc(model.id) +
              '"' +
              (on ? ' data-on' : '') +
              '>' +
              esc(model.name || model.id) +
              (on ? ' <span style="margin-left:auto">✓</span>' : '') +
              '</button>',
          )
        }
      }
      menu.innerHTML = rows.join('')
    }

    function openModelMenu() {
      const panel = S.ask.panel
      if (!panel) return
      const menu = panel.querySelector('[data-dqai-models]')
      if (!menu) return
      S.ask.modelsOpen = true
      renderModelMenu()
      menu.setAttribute('data-open', '')
      ensureCatalog().then(() => {
        if (!S.ask.open) return
        if (S.ask.modelsOpen) {
          renderModelMenu()
          renderModelChip()
        }
      })
    }

    function closeModelMenu() {
      const panel = S.ask.panel
      if (!panel) return
      S.ask.modelsOpen = false
      const menu = panel.querySelector('[data-dqai-models]')
      if (menu) menu.removeAttribute('data-open')
    }

    // ---------- 问 AI：面板 ----------

    function scrollLog() {
      const panel = S.ask.panel
      if (!panel) return
      const log = panel.querySelector('[data-dqai-log]')
      if (log) log.scrollTop = log.scrollHeight
    }

    function appendMessage(role, text) {
      const panel = S.ask.panel
      if (!panel) return null
      const log = panel.querySelector('[data-dqai-log]')
      if (!log) return null
      const el = document.createElement('div')
      el.setAttribute('data-dqai-msg', '')
      el.setAttribute('data-role', role)
      el.textContent = text || ''
      log.appendChild(el)
      scrollLog()
      return el
    }

    function setSendMode(mode) {
      const panel = S.ask.panel
      if (!panel) return
      const btn = panel.querySelector('[data-dqai-send]')
      if (!btn) return
      if (mode === 'stop') {
        btn.textContent = '停止'
        btn.setAttribute('data-mode', 'stop')
      } else {
        btn.textContent = '发送'
        btn.removeAttribute('data-mode')
      }
    }

    function autosize() {
      const panel = S.ask.panel
      if (!panel) return
      const input = panel.querySelector('[data-dqai-input]')
      if (!input) return
      input.style.height = 'auto'
      input.style.height = Math.min(input.scrollHeight, 120) + 'px'
    }

    /** 把面板摆到锚点旁边：落在鼠标点右下，贴选区下方，出界就翻/夹。 */
    function placePanel() {
      const ask = S.ask
      const panel = ask.panel
      if (!panel) return
      panel.style.visibility = 'hidden'
      panel.setAttribute('data-open', '')
      panel.style.left = '0px'
      panel.style.top = '0px'
      const w = panel.offsetWidth
      const h = panel.offsetHeight
      const vw = window.innerWidth
      const vh = window.innerHeight
      const pad = 10
      let left
      let top
      const anchor = ask.anchor
      if (anchor && anchor.type === 'point') {
        left = anchor.x + 10
        top = anchor.y + 10
      } else if (anchor && anchor.type === 'rect') {
        left = anchor.rect.left
        top = anchor.rect.bottom + 10
      } else {
        left = (vw - w) / 2
        top = Math.max(48, (vh - h) / 2)
      }
      if (left + w > vw - pad) left = vw - w - pad
      if (top + h > vh - pad) {
        if (anchor && anchor.type === 'point') top = anchor.y - h - 10
        if (top < pad || top + h > vh - pad) top = vh - h - pad
      }
      left = Math.max(pad, left)
      top = Math.max(pad, top)
      panel.style.left = Math.round(left) + 'px'
      panel.style.top = Math.round(top) + 'px'
      panel.style.visibility = ''
    }

    function ensurePanel() {
      const ask = S.ask
      if (ask.panel) return ask.panel
      const panel = document.createElement('div')
      panel.setAttribute('data-dqai-panel', '')
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', '问 AI')
      panel.innerHTML = [
        '<div data-dqai-head>',
        '<span data-dqai-title>问 AI</span>',
        '<button type="button" data-dqai-model title="选择模型"><span>模型加载中…</span><i>▾</i></button>',
        '<button type="button" data-dqai-close title="关闭（Esc）">✕</button>',
        '</div>',
        '<div data-dqai-models role="listbox"></div>',
        '<div data-dqai-quote></div>',
        '<div data-dqai-note hidden></div>',
        '<div data-dqai-log></div>',
        '<div data-dqai-foot>',
        '<textarea data-dqai-input rows="1" placeholder="想问什么？Enter 发送 / Shift+Enter 换行"></textarea>',
        '<button type="button" data-dqai-send>发送</button>',
        '</div>',
      ].join('')

      panel.querySelector('[data-dqai-close]').addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        closePanel()
      })
      panel.querySelector('[data-dqai-model]').addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        if (ask.modelsOpen) closeModelMenu()
        else openModelMenu()
      })
      panel.querySelector('[data-dqai-models]').addEventListener('click', (ev) => {
        const opt = ev.target && ev.target.closest ? ev.target.closest('[data-dqai-opt]') : null
        if (!opt) return
        ev.preventDefault()
        ev.stopPropagation()
        const provider = opt.getAttribute('data-p')
        const model = opt.getAttribute('data-m')
        if (!provider || !model) return
        ask.model = { provider, model, name: labelOf({ provider, model }) }
        closeModelMenu()
        renderModelChip()
      })
      panel.querySelector('[data-dqai-send]').addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        if (ask.busy) {
          if (ask.abort) {
            try {
              ask.abort.abort()
            } catch {
              /* 已经结束了 */
            }
          }
          return
        }
        sendQuestion()
      })
      const input = panel.querySelector('[data-dqai-input]')
      input.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || ev.shiftKey) return
        // 中文输入法选词时的 Enter 不能当发送
        if (ev.isComposing || ev.keyCode === 229) return
        ev.preventDefault()
        if (!ask.busy) sendQuestion()
      })
      input.addEventListener('input', autosize)

      // 设置弹窗是 aria-modal 的，可能有焦点陷阱：小窗里的焦点变化别往外冒，
      // 免得刚点进输入框焦点就被抢回弹窗。
      // （注意：**别**在这里拦 keydown —— 捕获阶段 stopPropagation 会让
      //  textarea 自己的 Enter 发送都收不到）
      panel.addEventListener('focusin', (ev) => ev.stopPropagation(), true)
      panel.addEventListener('focusout', (ev) => ev.stopPropagation(), true)

      // 拖动标题栏移动窗口
      const head = panel.querySelector('[data-dqai-head]')
      head.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return
        if (ev.target && ev.target.closest && ev.target.closest('button')) return
        const startX = ev.clientX
        const startY = ev.clientY
        const originX = parseFloat(panel.style.left) || panel.offsetLeft || 0
        const originY = parseFloat(panel.style.top) || panel.offsetTop || 0
        const move = (e) => {
          const left = Math.max(4, originX + e.clientX - startX)
          const top = Math.max(4, originY + e.clientY - startY)
          panel.style.left = Math.round(left) + 'px'
          panel.style.top = Math.round(top) + 'px'
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        ev.preventDefault()
      })

      document.body.appendChild(panel)
      ask.panel = panel
      return panel
    }

    function openAsk() {
      const quote = S.text
      const anchor = S.anchor
      const sessionId = S.sessionId
      // 先收起小菜单（hide 会把 S.text 清空，所以上面先存好）
      hide()
      clearSelection()

      const ask = S.ask
      const panel = ensurePanel()
      ask.open = true
      ask.sessionId = sessionId
      ask.quote = quote
      ask.anchor = anchor
      ask.turns = []
      ask.busy = false
      ask.abort = null
      ask.model = null
      ask.groups = null
      ask.modelsOpen = false
      closeModelMenu()

      panel.querySelector('[data-dqai-log]').innerHTML = ''
      panel.querySelector('[data-dqai-quote]').textContent = quote ? '选中：' + quote : ''
      panel.querySelector('[data-dqai-quote]').style.display = quote ? '' : 'none'
      const note = panel.querySelector('[data-dqai-note]')
      note.setAttribute('hidden', '')
      note.textContent = ''
      const input = panel.querySelector('[data-dqai-input]')
      input.value = ''
      input.style.height = 'auto'
      setSendMode('send')
      renderModelChip()
      placePanel()
      ensureCatalog().then(() => {
        if (!ask.open) return
        renderModelChip()
        if (ask.modelsOpen) renderModelMenu()
      })
      setTimeout(() => {
        try {
          input.focus()
        } catch {
          /* 焦点拿不到就算了 */
        }
      }, 0)
    }

    function closePanel() {
      const ask = S.ask
      if (!ask.open) return
      if (ask.abort) {
        try {
          ask.abort.abort()
        } catch {
          /* 已经结束了 */
        }
      }
      ask.open = false
      ask.busy = false
      ask.abort = null
      ask.turns = []
      closeModelMenu()
      if (ask.panel) ask.panel.removeAttribute('data-open')
    }

    /** 发一轮问题，边收边画。 */
    async function sendQuestion() {
      const ask = S.ask
      if (ask.busy) return
      const panel = ask.panel
      if (!panel) return
      const input = panel.querySelector('[data-dqai-input]')
      const question = String(input.value || '').trim()
      if (!question) {
        input.focus()
        return
      }
      if (!ask.model || !ask.model.provider || !ask.model.model) {
        appendMessage('error', '还没有选到模型，点右上角那个模型按钮换一个（或稍等一下让清单加载完）。')
        return
      }
      // 没有会话也能问（比如刚打开页面就在插件页/设置页划词）：
      // 只是没有「会话背景」，选中原文照样带过去。

      // 第一轮把选中的原文一起带过去；界面上只显示用户真正打的字
      let outgoing = question
      if (ask.turns.length === 0 && ask.quote) {
        outgoing = '【我在会话里选中的原文】\n' + ask.quote + '\n\n【我的问题】\n' + question
      }
      // 这句必须放在最后：模型最容易受「最后一句」影响，不然它会把小窗当成
      // 主会话的续写，接着上面那段话往下讲。
      outgoing += '\n\n（旁问：请只回答我这个问题，不要接着上面的会话记录继续往下写。）'
      ask.turns.push({ role: 'user', text: outgoing, show: question })
      appendMessage('user', question)
      input.value = ''
      input.style.height = 'auto'

      const bubble = appendMessage('assistant', '')
      bubble.setAttribute('data-pending', '')
      ask.busy = true
      setSendMode('stop')
      const controller = new AbortController()
      ask.abort = controller
      let acc = ''
      let failure = ''
      let aborted = false

      const paintDelta = () => {
        bubble.textContent = acc
        scrollLog()
      }

      try {
        const res = await fetch(ASK_API + '/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: ask.sessionId,
            provider: ask.model.provider,
            model: ask.model.model,
            turns: ask.turns.map((turn) => ({ role: turn.role, text: turn.text })),
          }),
          signal: controller.signal,
        })
        const type = String(res.headers.get('content-type') || '')
        if (type.indexOf('application/json') >= 0) {
          const data = await res.json()
          throw new Error((data && data.error) || '请求被拒绝了')
        }
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status)

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let cut = buffer.indexOf('\n')
          while (cut >= 0) {
            const line = buffer.slice(0, cut).trim()
            buffer = buffer.slice(cut + 1)
            cut = buffer.indexOf('\n')
            if (!line) continue
            let event
            try {
              event = JSON.parse(line)
            } catch {
              continue
            }
            if (event.type === 'delta') {
              acc += event.text || ''
              paintDelta()
            } else if (event.type === 'start') {
              const note = panel.querySelector('[data-dqai-note]')
              if (note) {
                if (event.truncated) {
                  note.removeAttribute('hidden')
                  note.textContent = '会话太长，只带了最近的 ' + String(event.backed || 0) + ' 条消息当背景'
                } else {
                  note.setAttribute('hidden', '')
                  note.textContent = ''
                }
              }
            } else if (event.type === 'error') {
              failure = event.message || '模型调用失败'
            } else if (event.type === 'aborted') {
              aborted = true
            }
          }
        }
      } catch (err) {
        if (err && err.name === 'AbortError') aborted = true
        else failure = String((err && err.message) || err)
      } finally {
        bubble.removeAttribute('data-pending')
        ask.busy = false
        ask.abort = null
        setSendMode('send')
        if (failure) {
          if (!acc) bubble.remove()
          appendMessage('error', '⚠ ' + failure)
          if (acc) ask.turns.push({ role: 'assistant', text: acc })
        } else {
          if (!acc && !aborted) acc = '（模型没有输出内容）'
          bubble.textContent = acc
          ask.turns.push({ role: 'assistant', text: acc })
        }
        if (aborted && !acc) {
          bubble.remove()
        }
        scrollLog()
        try {
          input.focus()
        } catch {
          /* 忽略 */
        }
      }
    }

    // ---------- 主流程 ----------

    /** 手机路径：选中就弹（PC 拖选不弹，交给右键）。 */
    function recomputeFromSelection() {
      if (S.busy) return
      // PC 右键菜单已经开着：别被「刚选完字」那条 140ms 定时器顺手收掉
      // （手快的人选完字立刻右键，定时器会在菜单弹出后才跑）
      if (S.mode === 'menu' && isOpen()) return
      // 鼠标拖选：PC 上不弹，只认右键
      if (S.lastPointer === 'mouse') {
        hide()
        return
      }
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        // 选区是我们自己刚收掉的（让浏览器原生划词条消失）：浮条别跟着收
        if (S.keepWhenCollapsed) return
        hide()
        return
      }
      const text = String(sel.toString() || '').trim()
      if (!text) {
        if (S.keepWhenCollapsed) return
        hide()
        return
      }
      S.keepWhenCollapsed = false
      const range = sel.getRangeAt(0)
      // 整页生效：设置页、插件页、右栏文档、工具输出里的字都能选。
      // 只有两处让给浏览器：可编辑的地方（输入框/编辑器）和自己的小窗。
      if (editableOf(range) || inAskPanel(range)) {
        hide()
        return
      }
      const rect = rectOf(range)
      if (!rect) {
        hide()
        return
      }
      const vh = window.innerHeight
      const vw = window.innerWidth
      if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) {
        hide()
        return
      }
      const row = rowOf(range)
      S.row = row
      S.text = text
      S.source = row ? sourceLine(row) : ''
      openWith({ type: 'rect', rect }, 'pill')
      // 手机：把浏览器自己那条原生划词条收走，屏幕上只留我这一条
      dropNativeSelection()
    }

    function onSelectionChange() {
      if (S.selTimer) clearTimeout(S.selTimer)
      // 拖选/双击选词过程中 selectionchange 会连发，停稳 140ms 再决定
      S.selTimer = setTimeout(recomputeFromSelection, 140)
    }

    /** PC 路径：右键时选区内有字就接管菜单（整页生效，不只是聊天区）。 */
    function onContextMenu(ev) {
      if (S.busy) return
      const sel = window.getSelection()
      const text = sel && sel.rangeCount > 0 && !sel.isCollapsed ? String(sel.toString() || '').trim() : ''
      if (!text) {
        // 没选中字：交还给浏览器原生右键菜单，顺手收起自己的
        hide()
        return
      }
      const range = sel.getRangeAt(0)
      // 可编辑的地方（输入框 / 编辑器）保留原生菜单：剪切/粘贴/全选还得能用；
      // 小窗里选字也还给浏览器，方便复制答案。
      if (editableOf(range) || inAskPanel(range)) {
        hide()
        return
      }
      // 吃掉了原生右键菜单，就得自己补「复制」（见 itemsFor）
      ev.preventDefault()
      ev.stopPropagation()
      const row = rowOf(range)
      S.row = row
      S.text = text
      S.source = row ? sourceLine(row) : ''
      openWith({ type: 'point', x: ev.clientX, y: ev.clientY }, 'menu')
    }

    function onPointerDownCapture(ev) {
      if (!S.bar) return
      if (S.bar.contains(ev.target)) {
        // 在浮条上按下：别让浏览器把选区清掉，否则按钮还没 click 选区就没了
        ev.preventDefault()
        return
      }
      // 点面板里的东西不算「点外面」
      const panel = S.ask.panel
      if (panel && panel.contains(ev.target)) return
      // 右键按下先别收，交给 contextmenu 决定
      if (ev.button === 2) return
      hide()
    }

    /** 记下这次交互是鼠标还是手指：触屏笔记本也能各走各的路。 */
    function onPointerDownKind(ev) {
      if (ev && ev.pointerType) S.lastPointer = ev.pointerType
    }

    function onScrollCapture(ev) {
      // 面板自己内部滚动不用管
      const panel = S.ask.panel
      if (panel && panel.contains(ev.target)) return
      if (isOpen()) hide()
    }

    function onKeyDown(ev) {
      if (ev.key !== 'Escape') return
      if (S.ask.open) {
        // 吃掉这次 Esc：不然设置弹窗之类的会跟着一起关
        ev.preventDefault()
        ev.stopPropagation()
        if (S.ask.modelsOpen) {
          closeModelMenu()
          return
        }
        closePanel()
        return
      }
      if (isOpen()) {
        ev.preventDefault()
        ev.stopPropagation()
        hide()
      }
    }

    /** 「复制」：接管右键后补回来的那一项。 */
    async function doCopy() {
      const text = S.text
      hide()
      try {
        await navigator.clipboard.writeText(text)
        return
      } catch {
        /* 非安全上下文或没权限，走兜底 */
      }
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      ta.style.top = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        /* 兜底也失败就算了 */
      }
      ta.remove()
    }

    /** 「当前会话」：出处一行普通文字 + 一个装着原文的引用块。 */
    function doQuoteHere() {
      if (S.busy || !S.text) return
      const actions = S.inputActions
      if (!actions) {
        flash('here', '输入框未就绪')
        return
      }
      const source = S.source
      const body = S.text
      // 引用卡片是单行截断的，出处必须单独一行普通文字，否则原文被挤没
      let wroteSource = false
      if (source) {
        try {
          wroteSource = actions.insertText(source + '\n', actions.captureInsertion())
        } catch {
          wroteSource = false
        }
      }
      const inserted = actions.insertQuote(wroteSource ? body : payloadOf(body, source))
      if (!inserted) {
        flash('here', '引用失败')
        return
      }
      clearSelection()
      hide()
    }

    /** 「新建会话」：分支出一个继承完整历史的会话，再把引用块放进去。 */
    async function doQuoteNew() {
      if (S.busy || !S.text) return
      const parent = S.sessionId
      const uiWorkspace = S.ctx && S.ctx.uiWorkspace
      if (!parent || !uiWorkspace) {
        flash('new', '当前会话不可分支')
        return
      }
      const payload = payloadOf(S.text, S.source)
      S.busy = true
      const btn = S.bar.querySelector('button[data-act="new"]')
      if (btn) {
        btn.setAttribute('data-busy', '')
        btn.textContent = '新建中…'
      }
      try {
        const childId = await uiWorkspace.forkSession(parent)
        S.pending.set(childId, { text: payload, at: Date.now() })
        uiWorkspace.openSession(childId)
        clearSelection()
        hide()
      } catch (err) {
        const msg = String((err && err.message) || err || '')
        // 官方 fork 只能从「已完成的轮次」切出来：还在回答中的会话切不了
        const friendly = /no completed turn|fork-unavailable|has no completed/i.test(msg)
          ? '这轮还没答完'
          : '新建失败'
        console.warn('[quote-menu] fork failed', err)
        flash('new', friendly)
      } finally {
        S.busy = false
        if (btn) {
          btn.removeAttribute('data-busy')
          if (!btn.hasAttribute('data-error')) btn.textContent = '新建会话'
        }
      }
    }

    /** 浮条上的点击都在这里分发。 */
    function onBarClick(ev) {
      const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null
      if (!btn) return
      ev.preventDefault()
      ev.stopPropagation()
      const act = btn.getAttribute('data-act')
      if (act === 'ask') {
        openAsk()
        return
      }
      if (act === 'quote') {
        if (S.stage !== 2) {
          S.stage = 2
          paint()
          place()
        }
        return
      }
      if (act === 'copy') {
        doCopy()
        return
      }
      if (act === 'here') {
        doQuoteHere()
        return
      }
      if (act === 'new') {
        doQuoteNew()
      }
    }

    /**
     * 桥接组件：挂在 conversation.input.dock 上，不画任何东西，
     * 只把「当前会话的 inputActions / sessionId」以及「待插入的引用」对上号。
     */
    function Bridge(props) {
      const { sessionId, inputActions } = props

      React.useEffect(() => {
        S.sessionId = sessionId
        S.inputActions = inputActions
        // 切到别的会话了：小窗里的临时对话属于上一个会话，别带着串到新会话去
        if (S.ask.open && S.ask.sessionId && S.ask.sessionId !== sessionId) closePanel()
      }, [sessionId, inputActions])

      React.useEffect(() => {
        const item = S.pending.get(sessionId)
        if (!item) return undefined
        // 5 分钟内没等到这个会话被打开就作废，免得哪天打开旧会话突然冒出引用
        if (Date.now() - item.at > 300000) {
          S.pending.delete(sessionId)
          return undefined
        }
        S.pending.delete(sessionId)
        let tries = 0
        let timer = 0
        const tick = () => {
          let ok = false
          try {
            ok = inputActions.insertQuote(item.text)
          } catch {
            ok = false
          }
          if (ok) return
          tries += 1
          if (tries > 60) return
          timer = setTimeout(tick, 80)
        }
        timer = setTimeout(tick, 120)
        return () => clearTimeout(timer)
      }, [sessionId, inputActions])

      return null
    }

    return {
      inject: ['slots', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        if (typeof document === 'undefined') return
        S.ctx = ctx

        const style = document.createElement('style')
        style.dataset.plugin = '@local/dsh-quote-menu'
        style.textContent = CSS
        document.head.appendChild(style)

        const bar = document.createElement('div')
        bar.setAttribute('data-dqh-quote-bar', '')
        bar.setAttribute('data-mode', 'pill')
        bar.setAttribute('role', 'menu')
        bar.setAttribute('aria-label', '引用所选文字')
        bar.addEventListener('click', onBarClick)
        S.bar = bar
        document.body.appendChild(bar)

        document.addEventListener('pointerdown', onPointerDownKind, true)
        document.addEventListener('selectionchange', onSelectionChange)
        document.addEventListener('contextmenu', onContextMenu, true)
        document.addEventListener('pointerdown', onPointerDownCapture, true)
        document.addEventListener('scroll', onScrollCapture, true)
        window.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', onScrollCapture, true)

        ctx.effect(
          () => () => {
            document.removeEventListener('pointerdown', onPointerDownKind, true)
            document.removeEventListener('selectionchange', onSelectionChange)
            document.removeEventListener('contextmenu', onContextMenu, true)
            document.removeEventListener('pointerdown', onPointerDownCapture, true)
            document.removeEventListener('scroll', onScrollCapture, true)
            window.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('resize', onScrollCapture, true)
            if (S.selTimer) clearTimeout(S.selTimer)
            if (S.labelTimer) clearTimeout(S.labelTimer)
            if (S.ask.abort) {
              try {
                S.ask.abort.abort()
              } catch {
                /* 已经结束了 */
              }
            }
            if (S.ask.panel) S.ask.panel.remove()
            bar.remove()
            style.remove()
            S.bar = null
            S.ask.panel = null
            S.ask.open = false
            S.text = ''
            S.source = ''
            S.anchor = null
          },
          'quote-menu: selection bar + stylesheet',
        )

        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'quote-menu',
              order: 900,
            },
            Bridge,
          ),
        )
      },
    }
  },
})
