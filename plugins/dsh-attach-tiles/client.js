/**
 * 附件面板 + 待机语音条（Client 半）—— 把输入区整个改成 little DJ 的交互：
 *
 *   待机（手机端、输入空、未聚焦）→ 输入卡收成**一排**：＋ 在左 + 「🎙 按住说话，⌨ 点击发消息」盖满
 *     · 轻点待机条   →  展开正常输入区 + 光标进输入框（弹键盘）
 *     · 长按 ≥300ms  →  语音输入（Chrome 语音识别 zh-CN），松手把听写文字**直接发送**，上滑 ≥60px 取消
 *   点 ＋           →  **官方原样**（v0.056：自定义选图整块删掉 —— Web 没法直接进系统相册，
 *                      主人定案「走官方」，不再由插件拦这个点击）
 *   任务面板展开    →  列表放高 + 滚到底（v0.053），输入框不再被顶出屏幕、任务文字不截断
 *
 * 交互 1:1 照 little DJ task318/319/321/322（含幽灵 click 哨兵 + 长按防放大镜，v0.313.0.0）。
 * 语音：浏览器原生 SpeechRecognition（Chrome 手机/桌面可用，走系统授权）；识别不了会 toast 说明，不炸页面。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-attach-tiles',
  factory() {
const HOLDATTR = 'data-dsh-hold'
const BAR = 'data-dsh-holdbar'

const CSS = [
  /* ---------- TodoDock 展开（v0.053，2026-11-15）：任务多了不许把输入框顶出屏幕 ----------
     官方 TodoPanel 的 ul 写死 max-height:180px 且 _content 单行省略号 —— 手机上点开展开后
     面板把输入卡往下推出视口（实测 390×844：card bottom 942 > 844），条目还被 ellipsis 截。
     这里：列表放高到 46vh、条目最多 4 行完整显示；滚动到底由 bindTodoDock 负责。 */
  '[data-testid="todo-panel"] ul{max-height:min(46vh,420px)}',
  '[data-testid="todo-panel"] li>span:last-child{display:-webkit-box;-webkit-box-orient:vertical;',
  '-webkit-line-clamp:4;white-space:normal;text-overflow:clip;overflow:hidden}',
  /* 发送按钮挪到输入框最左（2026-11-15 主人点名：手机语音转文字后点左边最顺手）。
     v0.044：_trailing order:-1 整组换位。v0.046（DJ 追加「＋ 放模型选择右边」）改为：
     分组容器全部 display:contents → 所有按钮变成 _row 的直接 flex 项，再用 order 逐个排：
     发送(-10) → 模型选择(-9) → ＋(-8) → 其余(0)。row 本身是 space-between，摊平后会
     把按钮均布撑开 → 必须 justify-content:flex-start 收回左起紧凑排列。纯 CSS、不搬 DOM。 */
  'div[class*="_row"]{gap:8px;justify-content:flex-start}',
  'div[class*="_row"]>div[class*="_tools"],div[class*="_row"]>div[class*="_trailing"],div[class*="_row"] div[class*="_standardControls"],div[class*="_row"] div[class*="_modes"],div[class*="_row"] div[class*="_root"]{display:contents}',
  'div[class*="_row"] button[class*="_primary"]{order:-10}',
  'div[class*="_row"] button[class*="_trigger"][aria-haspopup="menu"]{order:-9}',
  'div[class*="_row"] button[class*="_add"]{order:-8}',
  /* 手机端「休息中」胶囊顶到输入卡最右边（2026-11-15 主人：「输入板里面的休息中是靠最右边」）。
     只动手机断点，桌面布局不动；margin-left:auto = 把这一颗（以及它前面的都留在左起）推到行尾。 */
  '@media (max-width:899px){[data-composer-card] [data-rest-mode]{margin-left:auto}}',

  /* ---------- 待机单行（little DJ task321/322 同款，仅手机端） ---------- */
  /* holdmode：输入卡收成一排 —— 编辑区(_scroll)藏、发送(_trailing)藏、工具组只留 ＋ */
  '@media (max-width:899px){',
  `html[${HOLDATTR}="1"] [data-composer-card]>div[class*="_scroll"]{display:none!important}`,
  `html[${HOLDATTR}="1"] [data-composer-card] div[class*="_row"]>div[class*="_trailing"]{display:none!important}`,
  `html[${HOLDATTR}="1"] [data-composer-card] div[class*="_tools"]>:not(button[aria-haspopup="listbox"]){display:none!important}`,
  `html[${HOLDATTR}="1"] [data-composer-card]{min-height:0!important}`,
  '}',
  /* 待机条本体：盖住输入卡（左边让出 48px 给 ＋）；录制态红字 + 呼吸红点 */
  /* v0.051（DJ：文字要相对**整条输入卡**居中，不是扣掉左侧按钮后的居中）：
     待机条本身从 left:48px 起，再补同宽（48px）的右 padding（border-box 不会撑出卡片），
     内容盒左右各让 48px → 内容中心正好落在输入卡横向中点，视觉不再偏右。 */
  `[data-dsh-holdbar]{position:absolute;left:48px;right:0;top:0;bottom:0;z-index:5;box-sizing:border-box;padding-right:48px;display:flex;`,
  'align-items:center;justify-content:center;gap:6px;font-size:13px;line-height:1.2;',
  'color:var(--dsw-alias-label-secondary,#cfd3d6);border-radius:12px;cursor:text;',
  '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;',
  '-webkit-tap-highlight-color:transparent;touch-action:none}',
  `[data-dsh-holdbar][hidden]{display:none}`,
  `[data-dsh-holdbar].rec{color:#ff8a8a}`,
  `[data-dsh-holdbar].cancel{color:#ff5b5b}`,
  `[data-dsh-holdbar] .hb-dot{width:8px;height:8px;border-radius:50%;background:#ff6b6b;flex:none;`,
  'animation:hbPulse 1.1s ease-in-out infinite}',
  '[data-dsh-holdbar].cancel .hb-dot{background:#ff3b3b}',
  /* v0.057（DJ：空输入框时也要能一步选模型）——待机条右侧放「当前模型名」芯片，
     点它＝展开输入区＋自动弹官方模型菜单。 */
  '[data-dsh-holdbar] .hb-model{flex:none;margin-left:12px;max-width:38vw;overflow:hidden;',
  'text-overflow:ellipsis;white-space:nowrap;padding:3px 10px;border-radius:9px;border:none;',
  'background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));cursor:pointer;',
  'color:inherit;font-size:12.5px;line-height:1.3;-webkit-tap-highlight-color:transparent}',
  '@keyframes hbPulse{0%,100%{box-shadow:0 0 0 0 rgba(255,107,107,.3)}50%{box-shadow:0 0 0 7px rgba(255,107,107,0)}}',
].join('')

    /* v0.056（2026-11-15 主人：「那就走官方吧」）——
       整套「点 ＋ 直接弹系统图片选择器」的逻辑删掉：Web 没有权限直接进相册，只能借
       `accept=image/*` 让系统选择器带上相册入口，绕不过系统那一层。主人定案走官方，
       于是插件不再拦 ＋ 的 click（官方列表原样弹出），也不再自己造 <input type=file>。
       保留：待机语音条、任务面板展开回滚、幽灵 click 哨兵。 */

    /* ==================== 待机语音条（little DJ task318/319/321/322 同款） ==================== */
    const HOLD = { armed: false, timer: 0, y0: 0, cancel: false, recording: false, everBound: false, modelUntil: 0 }
    const GUARD = { t: 0, x: 0, y: 0, wide: false } // 幽灵 click 哨兵（task322：轻点展开后 ±30px/500ms 内的合成 click 吞掉；wide=模型芯片流程窗口内吞全输入卡）
    let barEl = null
    let rec = null, recFinal = '', recInterim = '', recCancelled = false, recErr = ''

    function isMobile() {
      try { return window.matchMedia('(max-width: 899px)').matches } catch { return false }
    }

    function toastText(text, ms) {
      const box = document.createElement('div')
      box.setAttribute('data-dsh-holdbar-toast', '')
      box.setAttribute('role', 'status')
      box.textContent = text
      box.style.cssText = [
        'position:fixed', 'left:50%', 'transform:translateX(-50%)', 'bottom:140px',
        'z-index:80', 'padding:8px 14px', 'border-radius:10px', 'font-size:12.5px', 'line-height:1.5',
        'max-width:86vw', 'text-align:center', 'pointer-events:none',
        'color:var(--dsw-alias-label-primary,#f9fafb)',
        'background:var(--dsw-alias-bg-layer-2,#2c2c2e)',
        'border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14))',
      ].join(';')
      document.body.appendChild(box)
      setTimeout(() => box.remove(), ms || 2600)
    }

    function editorEl() {
      return document.querySelector('[data-composer-input="true"]')
    }

    function editorEmpty(ed) {
      if (!ed) return false
      if ((ed.textContent || '').trim()) return false
      if (ed.querySelector('img,video,audio')) return false
      return true
    }

    function attachmentsVisible(card) {
      try {
        const slot = card.querySelector('[data-slot="conversation.input.attachments"]')
        if (!slot) return false
        return Array.from(slot.querySelectorAll('*')).some(el => el.getBoundingClientRect().height > 2)
      } catch { return false }
    }

    function updateBarText() {
      if (!barEl) return
      const txtEl = barEl.querySelector('.hb-txt')
      if (!txtEl) return
      let t
      if (HOLD.cancel) t = '松手取消'
      else if (rec && (recFinal || recInterim)) t = (recFinal + recInterim).slice(-40)
      else if (rec || HOLD.recording) t = '正在听…松手发送，上滑取消'
      else t = '按住说话，点击发消息'
      /* 关键：文字没变绝不重写 textContent —— 否则 MutationObserver→sync→updateBarText 死循环卡死页面 */
      if (txtEl.textContent !== t) txtEl.textContent = t
    }

    function modelTrigger() {
      return [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(function (b) {
        return ((b.className || '') + '').indexOf('_7KE1Ra') >= 0 || (b.getAttribute('aria-label') || '').indexOf('选择模型') >= 0
      }) || null
    }

    function updateModelChip() {
      if (!barEl) return
      const chip = barEl.querySelector('.hb-model')
      if (!chip) return
      const trig = modelTrigger()
      const name = trig ? (trig.innerText || '').trim().split('\n')[0] : ''
      if (name && chip.textContent !== name) chip.textContent = name
    }

    /* v0.057：点模型芯片 = 摘待机 → 焦点进输入框（防 sync 把待机条放回来）→ 弹官方模型菜单 */
    function openModelMenu(cx, cy) {
      GUARD.t = Date.now() + 600; GUARD.x = cx || 0; GUARD.y = cy || 0; GUARD.wide = true
      HOLD.modelUntil = Date.now() + 1800 // 菜单打开期间 sync 全程抑制（幽灵 click 抢焦点 + 菜单自身 focus 轮换都会触发 sync）
      document.documentElement.removeAttribute(HOLDATTR)
      if (barEl) barEl.hidden = true
      requestAnimationFrame(function () {
        const ed = editorEl()
        if (ed) ed.focus()
      })
      setTimeout(function () {
        const trig = modelTrigger()
        GUARD.t = 0; GUARD.wide = false // 必须先清哨兵再点——click() 同步派发，晚一步就被自己人 stopPropagation 掐死
        if (!trig || trig.disabled) { toastText('模型菜单没弹出来，再点一下输入框旁的模型名', 2600); return }
        /* 教训 50 同款幽灵 click：轻点芯片展开布局后，同一触摸的合成 click 可能正好
           落到浮现的官方模型按钮上、把菜单打开——已开就别再点（点了=关）。 */
        if (trig.getAttribute('aria-expanded') !== 'true') trig.click()
      }, 420)
    }

    function ensureBar() {
      const card = document.querySelector('[data-composer-card="true"]')
      if (!card) { dropBar(); return null }
      if (barEl && barEl.isConnected && barEl.parentElement === card) return barEl
      dropBar()
      barEl = document.createElement('div')
      barEl.setAttribute(BAR, '')
      barEl.hidden = true
      barEl.innerHTML = '<span class="hb-ico">🎙</span><span class="hb-txt">按住说话，点击发消息</span><button type="button" class="hb-model" aria-label="选择模型"></button>'
      card.appendChild(barEl)
      bindBar(barEl)
      return barEl
    }

    function dropBar() {
      if (barEl) { barEl.remove(); barEl = null }
      if (document.documentElement.getAttribute(HOLDATTR) !== null) {
        document.documentElement.removeAttribute(HOLDATTR)
      }
    }

    function sync() {
      if (Date.now() < HOLD.modelUntil) return // v0.057：模型菜单流程窗（含幽灵 click 抢焦点）内，sync 不许把待机条放回来
      const ed = editorEl()
      if (!ed || !isMobile() || rec || HOLD.recording) {
        if (!rec && !HOLD.recording) {
          if (barEl) barEl.hidden = true
          document.documentElement.removeAttribute(HOLDATTR)
        }
        if (!ed) dropBar()
        return
      }
      const card = ed.closest('[data-composer-card="true"]')
      if (!card) { dropBar(); return }
      const b = ensureBar()
      if (!b) return
      const show = editorEmpty(ed) && document.activeElement !== ed && !attachmentsVisible(card)
      b.hidden = !show
      if (show) document.documentElement.setAttribute(HOLDATTR, '1')
      else document.documentElement.removeAttribute(HOLDATTR)
      updateBarText()
      if (show) updateModelChip()
    }

    function holdStart() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition
      if (!SR) {
        toastText('这个浏览器不支持语音输入，用 Chrome 打开 DJH 就能长按说话', 3400)
        return
      }
      recFinal = ''; recInterim = ''; recCancelled = false; recErr = ''
      HOLD.recording = true
      try {
        rec = new SR()
        rec.lang = 'zh-CN'
        rec.continuous = true
        rec.interimResults = true
        rec.onresult = function (ev) {
          let fin = '', inter = ''
          for (let i = 0; i < ev.results.length; i++) {
            const r = ev.results[i]
            if (r.isFinal) fin += r[0].transcript
            else inter += r[0].transcript
          }
          recFinal = fin; recInterim = inter
          updateBarText()
        }
        rec.onerror = function (ev) { recErr = (ev && ev.error) || '' }
        rec.onend = function () {
          rec = null
          HOLD.recording = false
          finishRec()
        }
        rec.start()
      } catch (e) {
        rec = null; HOLD.recording = false
        toastText('语音启动失败：' + (e && e.message ? e.message : e), 3200)
        sync()
        return
      }
      if (barEl) { barEl.hidden = false; barEl.classList.add('rec') }
      updateBarText()
    }

    function finishRec() {
      if (barEl) barEl.classList.remove('rec', 'cancel')
      HOLD.cancel = false
      if (recCancelled) { toastText('已取消'); sync(); return }
      if (recErr === 'not-allowed' || recErr === 'service-not-allowed') {
        toastText('浏览器拒绝了麦克风：在地址栏权限里允许麦克风，再长按说话', 3600); sync(); return
      }
      if (recErr === 'network') {
        toastText('语音识别连不上服务（网络问题），稍后再试', 3200); sync(); return
      }
      const text = (recFinal + recInterim).trim()
      if (!text) { toastText('没听清，靠近一点再说一遍'); sync(); return }
      // 听写文字进输入框 → 直接发送（little DJ 同款「松手发送」）
      const ed = editorEl()
      if (!ed) { toastText('输入框不在了，文字没送出去：' + text.slice(0, 30), 3600); return }
      document.documentElement.removeAttribute(HOLDATTR)
      if (barEl) barEl.hidden = true
      ed.focus()
      let ok = false
      try { ok = document.execCommand('insertText', false, text) } catch { ok = false }
      if (!ok) {
        try {
          ed.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }))
        } catch { /* ignore */ }
      }
      setTimeout(function () {
        const card = ed.closest('[data-composer-card="true"]')
        const send = card && (card.querySelector('div[class*="_trailing"] button[class*="_primary"]') || card.querySelector('div[class*="_trailing"] button'))
        if (send && !send.disabled) {
          send.click()
        } else {
          toastText('文字已进输入框，点发送', 2200)
        }
        sync()
      }, 120)
    }

    function holdEnd(cancel) {
      if (cancel) recCancelled = true
      if (rec) { try { rec.stop() } catch { rec = null; HOLD.recording = false; finishRec() } }
      else if (HOLD.recording) { HOLD.recording = false; finishRec() }
      else { HOLD.recording = false; sync() }
    }

    function ghostClick(ev) {
      if (!GUARD.t) return
      if (Date.now() > GUARD.t) { GUARD.t = 0; return }
      const dx = (ev.clientX || 0) - GUARD.x, dy = (ev.clientY || 0) - GUARD.y
      if (!GUARD.wide && dx * dx + dy * dy > 900) return
      const t = ev.target
      if (t && t.closest && t.closest(`[${BAR}], [data-composer-input="true"]`)) return
      /* v0.049：＋ 放行（真点被吞是致命的）。v0.056 起 ＋ 已归官方，这条只是别把
         刚唤醒输入区时用户自己点的那颗按钮吞掉。 */
      if (t && t.closest && t.closest('button[aria-haspopup="listbox"]')) { GUARD.t = 0; return }
      GUARD.t = 0
      ev.preventDefault()
      ev.stopPropagation()
    }

    function bindBar(b) {
      /* task322 两板斧：touchstart 吃掉（禁长按放大镜 + 掐合成 click）+ 幽灵 click 哨兵
         v0.057：模型芯片在 pointerup 里自己处理（合成 click/mouse 一律掐掉，防抢焦点/幽灵双击） */
      b.addEventListener('touchstart', function (e) { if (e.cancelable) e.preventDefault() }, { passive: false })
      b.addEventListener('contextmenu', function (e) { e.preventDefault() })
      b.addEventListener('selectstart', function (e) { e.preventDefault() })
      const chip = b.querySelector('.hb-model')
      if (chip) {
        let chipPointerAt = 0
        chip.addEventListener('pointerup', function (e) {
          if (e.pointerType === 'mouse' && e.button !== 0) return
          chipPointerAt = Date.now()
          e.preventDefault() // 掐掉这次指针序列的合成 click（教训 50：布局上移后它会幽灵落到模型按钮上）
          e.stopPropagation()
          openModelMenu(e.clientX, e.clientY)
        })
        chip.addEventListener('click', function (e) { // 鼠标路径兜底；触摸已被 touchstart 掐掉不会到这
          e.stopPropagation(); e.preventDefault()
          if (Date.now() - chipPointerAt < 700) return
          openModelMenu(e.clientX, e.clientY)
        })
      }
      const onChip = function (e) { return !!(e.target && e.target.closest && e.target.closest('.hb-model')) }
      if (!HOLD.everBound) {
        HOLD.everBound = true
        document.addEventListener('click', ghostClick, true)
      }
      b.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        if (onChip(e)) return
        if (rec || HOLD.recording) return
        clearTimeout(HOLD.timer)
        HOLD.armed = false; HOLD.cancel = false; HOLD.y0 = e.clientY
        try { b.setPointerCapture(e.pointerId) } catch { /* ignore */ }
        HOLD.timer = setTimeout(function () {
          HOLD.timer = 0; HOLD.armed = true
          holdStart()
        }, 300)
      })
      b.addEventListener('pointermove', function (e) {
        if (!HOLD.armed) return
        const up = HOLD.y0 - e.clientY
        if (!HOLD.cancel && up >= 60) { HOLD.cancel = true; if (barEl) barEl.classList.add('cancel'); updateBarText() }
        else if (HOLD.cancel && up < 40) { HOLD.cancel = false; if (barEl) barEl.classList.remove('cancel'); updateBarText() }
      })
      b.addEventListener('pointerup', function (e) {
        if (onChip(e)) return // v0.057：芯片自己管（click→openModelMenu），别落进「轻点展开」分支
        const wasArmed = HOLD.armed
        if (HOLD.timer) { clearTimeout(HOLD.timer); HOLD.timer = 0 }
        HOLD.armed = false
        if (!wasArmed) {
          // 轻点 = 展开输入区 + 光标进框（先摘 holdmode 再 focus，等一拍布局）
          GUARD.t = Date.now() + 500; GUARD.x = e.clientX || 0; GUARD.y = e.clientY || 0
          document.documentElement.removeAttribute(HOLDATTR)
          if (barEl) barEl.hidden = true
          requestAnimationFrame(function () {
            const ed = editorEl()
            if (!ed) return
            ed.focus()
            try {
              const sel = window.getSelection()
              const range = document.createRange()
              range.selectNodeContents(ed)
              range.collapse(false)
              sel.removeAllRanges()
              sel.addRange(range)
            } catch { /* ignore */ }
          })
          return
        }
        const c = HOLD.cancel; HOLD.cancel = false
        holdEnd(c)
      })
      b.addEventListener('pointercancel', function () {
        if (HOLD.timer) { clearTimeout(HOLD.timer); HOLD.timer = 0 }
        if (HOLD.armed) { HOLD.armed = false; HOLD.cancel = false; holdEnd(true) }
      })
    }

    /* ==================== TodoDock 展开后把输入框拉回可见（v0.053） ==================== */
    /* 官方 TodoPanel 在 composerStack 里位于输入卡上方；展开后列表变高，输入卡被往下推出
       视口（实测 390×844 展开后 card bottom=942）。这里点开任务后把会话滚到底，
       面板从下往上「长」出来、输入框始终贴底可见。 */
    function todoClick(ev) {
      const t = ev.target
      if (!t || !t.closest) return
      const btn = t.closest('[data-testid="todo-panel"] button')
      if (!btn) return
      setTimeout(function () {
        const panel = document.querySelector('[data-testid="todo-panel"]')
        if (!panel) return
        const hdr = panel.querySelector('button')
        if (!hdr || hdr.getAttribute('aria-expanded') !== 'true') return
        const seat = document.querySelector('[data-composer-seat]')
        const sc = (seat && seat.closest('div[class*="_scrollBody"]')) || document.querySelector('div[class*="_scrollBody"]')
        if (!sc) return
        try { sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' }) } catch { sc.scrollTop = sc.scrollHeight }
      }, 80)
    }
    function bindTodoDock() {
      document.addEventListener('click', todoClick, true)
    }

    return {
      apply(ctx) {
        if (typeof document === 'undefined') return
        const tag = document.createElement('style')
        tag.dataset.plugin = '@local/dsh-attach-tiles'
        tag.textContent = CSS
        document.head.appendChild(tag)
        bindTodoDock()

        /* ---- 待机条接线：document 级捕获（React 重挂节点不丢监听）+ 轮询兜底 ---- */
        const onFocusSync = function () { sync() }
        const onBlurSync = function () { setTimeout(sync, 150) }
        const onInputSync = function (ev) {
          const ed = editorEl()
          if (ed && ev.target === ed) sync()
        }
        const onResizeSync = function () { sync() }
        document.addEventListener('focusin', onFocusSync, true)
        document.addEventListener('focusout', onBlurSync, true)
        document.addEventListener('input', onInputSync, true)
        window.addEventListener('resize', onResizeSync, true)
        let mo = null
        try {
          mo = new MutationObserver(function () { sync() })
          mo.observe(document.body, { childList: true, subtree: true, characterData: true })
        } catch { /* ignore */ }
        const iv = setInterval(function () { sync() }, 900)
        sync()

        ctx.effect(() => () => {
          document.removeEventListener('click', todoClick, true)
          document.removeEventListener('click', ghostClick, true)
          document.removeEventListener('focusin', onFocusSync, true)
          document.removeEventListener('focusout', onBlurSync, true)
          document.removeEventListener('input', onInputSync, true)
          window.removeEventListener('resize', onResizeSync, true)
          if (mo) mo.disconnect()
          clearInterval(iv)
          clearTimeout(HOLD.timer)
          if (rec) { try { rec.onend = null; rec.abort() } catch { /* ignore */ } rec = null }
          dropBar()
          tag.remove()
        }, 'attach-tiles: picker + holdbar + todo dock + stylesheet')
      },
    }
  },
})
