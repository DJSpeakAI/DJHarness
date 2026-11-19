/**
 * dsh-msg-speak（Client 半）—— 每条 AI 回复下的「语音播报」迷你播放器。
 * 照抄小 DJ task347/362 的交互（DAG TtsPlayerControl 同款）：
 *   主键三态：🔊 空闲 / ⏳ 合成中（不可点，取消走停止键）/ ⏸ 播放中 ⇄ ▶ 暂停；
 *   停止键 ■：激活期裁切展开；发光呼吸 = 播放中。
 * 右键 🔊 切换音色（stella 女 / tide 男，默认女声，存 localStorage）。
 * 朗读走本插件 Host 半 /dsh-tts-api → DeepSeek TTS（filter_markdown 服务端开）。
 * 注入幂等：先清 [data-dsh-spk] 再挂；HMR/重渲染不叠加。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-msg-speak',
  factory() {
    const ATTR = 'data-dsh-spk'
    const css = document.createElement('style')
    css.textContent = [
      `[${ATTR}]{display:inline-flex;align-items:center;margin:0 2px;vertical-align:middle;}`,
      `[${ATTR}] .dsh-spk-main{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;`,
      `border:none;background:transparent;color:var(--dsw-alias-text-secondary,#9aa0a6);cursor:pointer;border-radius:6px;`,
      `font-size:14px;line-height:1;padding:0;transition:background .15s,color .15s;}`,
      `[${ATTR}] .dsh-spk-main:hover{background:var(--dsw-alias-fill-secondary,rgba(255,255,255,.08));color:var(--dsw-alias-text-primary,#f9fafb);}`,
      `[${ATTR}] .dsh-spk-stop{width:0;height:26px;overflow:hidden;border:none;background:transparent;`,
      `color:var(--dsw-alias-text-secondary,#9aa0a6);cursor:pointer;padding:0;border-radius:6px;`,
      `display:inline-flex;align-items:center;justify-content:center;transition:width .22s ease;}`,
      `[${ATTR}] .dsh-spk-stop svg{width:12px;height:12px;flex:none;}`,
      `[${ATTR}].on .dsh-spk-main{color:var(--dsw-alias-brand-primary,#f9fafb);}`,
      `[${ATTR}].on .dsh-spk-stop{width:26px;}`,
      `[${ATTR}].on .dsh-spk-stop:hover{background:var(--dsw-alias-fill-secondary,rgba(255,255,255,.08));color:var(--dsw-alias-text-primary,#f9fafb);}`,
      `@keyframes dshSpkBreath{0%,100%{opacity:1}50%{opacity:.45}}`,
      `[${ATTR}].breath .dsh-spk-main{animation:dshSpkBreath 1.6s ease-in-out infinite;}`,
      `.dsh-spk-load{width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;`,
      `display:inline-block;animation:dshSpkSpin .8s linear infinite;}`,
      `@keyframes dshSpkSpin{to{transform:rotate(360deg)}}`,
      `.dsh-spk-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:10001;`,
      `background:var(--dsw-alias-button-floating-fill,#2c2c2e);color:var(--dsw-alias-text-primary,#f9fafb);`,
      `font-size:12px;padding:6px 14px;border-radius:8px;pointer-events:none;opacity:.95;`,
      `box-shadow:0 4px 16px rgba(0,0,0,.35);transition:opacity .3s;}`,
      /* 对话页「音色切换」胶囊 + 面板（2026-11-19 主人要：对话框里能直接选音色） */
      `.dsh-vc-chip{position:absolute;right:8px;top:6px;z-index:6;font-size:11px;line-height:1;padding:4px 9px;`,
      `border-radius:999px;border:1px solid var(--dsw-alias-border,#3a3a3c);`,
      `background:var(--dsw-alias-fill-secondary,rgba(255,255,255,.06));color:var(--dsw-alias-text-secondary,#9aa0a6);`,
      `cursor:pointer;max-width:44vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:background .15s,color .15s;}`,
      `.dsh-vc-chip:hover{color:var(--dsw-alias-text-primary,#f9fafb);background:rgba(255,255,255,.13);}`,
      `.dsh-vc-panel{position:fixed;z-index:10002;min-width:220px;max-width:min(380px,92vw);max-height:62vh;overflow-y:auto;`,
      `background:var(--dsw-alias-button-floating-fill,#242427);border:1px solid rgba(255,255,255,.12);border-radius:10px;`,
      `box-shadow:0 10px 28px rgba(0,0,0,.5);padding:6px;}`,
      `.dsh-vc-head{font-size:11px;color:var(--dsw-alias-text-tertiary,#8a8f98);padding:4px 8px 6px;}`,
      `.dsh-vc-group{font-size:11px;color:var(--dsw-alias-text-tertiary,#8a8f98);padding:6px 8px 2px;}`,
      `.dsh-vc-row{display:block;width:100%;text-align:left;background:transparent;border:none;`,
      `color:var(--dsw-alias-label-primary,#f2f3f5);font-size:13px;padding:6px 8px;border-radius:6px;cursor:pointer;`,
      `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}`,
      `.dsh-vc-row:hover{background:rgba(255,255,255,.07);}`,
      `.dsh-vc-row[data-on="1"]{background:rgba(124,92,255,.16);}`,
      `@media (max-width:899px){.dsh-vc-chip{font-size:10px;padding:3px 7px;right:6px;top:4px;}}`,
      `[data-dsh-chars]{font-size:11px;line-height:1;color:var(--dsw-alias-text-tertiary,#6b7075);`,
      `margin:0 6px 0 2px;white-space:nowrap;user-select:none;font-variant-numeric:tabular-nums;}`,
    ].join('')

    const ICONS = {
      play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
      pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.2" y="2.5" width="3.4" height="11" rx="1" fill="currentColor"/><rect x="9.4" y="2.5" width="3.4" height="11" rx="1" fill="currentColor"/></svg>',
      stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.6" fill="currentColor"/></svg>',
    }

    /* 播放器全局态（同小 DJ MSG_SPEAK；seq 作废在途回调） */
    const SPK = { row: null, seq: 0, state: '', audio: null, url: '' }

    /* 当前播报选择（dsh-tts-voice 网关：入口=对话播报）。
       缓存 30s；网关不可用时回落老的 DeepSeek stella/tide 右键切换。 */
    let selCache = { at: 0, data: null }
    async function currentVoice() {
      const legacy = () => ({
        provider: 'deepseek',
        voice: (() => { try { return localStorage.getItem('dsh-tts:voice') === 'tide' ? 'tide' : 'stella' } catch { return 'stella' } })(),
        alias: '',
        legacy: true,
      })
      if (selCache.data && Date.now() - selCache.at < 30000) return selCache.data
      try {
        const r = await fetch('/tts-voice-api', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'selection', entry: 'chat' }),
        })
        const j = await r.json()
        if (!r.ok || !j.ok || !j.voice) return legacy()
        const data = { provider: j.provider, voice: j.voice, alias: j.alias || '', legacy: false }
        selCache = { at: Date.now(), data }
        return data
      } catch { return legacy() }
    }

    let toastEl = null
    let toastTimer = 0
    function toast(msg) {
      if (!toastEl || !document.contains(toastEl)) {
        toastEl = document.createElement('div')
        toastEl.className = 'dsh-spk-toast'
      }
      toastEl.textContent = msg
      toastEl.style.opacity = '.95'
      document.body.appendChild(toastEl)
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        if (toastEl) toastEl.style.opacity = '0'
      }, 2400)
    }

    /* ---- 按钮态刷新：激活条 = 当前 SPK.row 且有 state ---- */
    function sync() {
      document.querySelectorAll(`[${ATTR}]`).forEach((ssp) => {
        const mine = !!(SPK.state && ssp === SPK.row)
        ssp.classList.toggle('on', mine)
        ssp.classList.toggle('breath', mine && SPK.state === 'playing')
        const main = ssp.querySelector('.dsh-spk-main')
        if (!main) return
        if (!mine) {
          main.innerHTML = '🔊'
          main.title = '语音播报：朗读这条回复（右键切换女/男声）'
        } else if (SPK.state === 'loading') {
          main.innerHTML = '<span class="dsh-spk-load"></span>'
          main.title = '合成中…（点 ■ 取消）'
        } else if (SPK.state === 'paused') {
          main.innerHTML = ICONS.play
          main.title = '已暂停，点击继续朗读'
        } else {
          main.innerHTML = ICONS.pause
          main.title = '朗读中，点击暂停'
        }
      })
    }

    function stopAudio() {
      if (SPK.audio) {
        try { SPK.audio.pause() } catch {}
        SPK.audio.onended = null
        SPK.audio = null
      }
      if (SPK.url) {
        try { URL.revokeObjectURL(SPK.url) } catch {}
        SPK.url = ''
      }
    }

    function stop() {
      SPK.seq++
      SPK.state = ''
      SPK.row = null
      stopAudio()
      sync()
    }

    function pause() {
      if (SPK.state !== 'playing') return
      try { if (SPK.audio) SPK.audio.pause() } catch {}
      SPK.state = 'paused'
      sync()
    }

    function resume() {
      if (SPK.state !== 'paused') return
      if (!SPK.audio) { SPK.state = 'playing'; sync(); return }
      const pr = SPK.audio.play()
      if (pr && pr.catch) pr.catch(() => { stop(); toast('继续播放被浏览器拦住：再点一次 ▶') })
      SPK.state = 'playing'
      sync()
    }

    /* ---- 取某条回复的可朗读文本 ----
       DSH 结构：assistant 操作行所在的 flowItem 里没有正文——正文是同轮上方独立的
       markdown flowItem（类名 *_markdown_*），用户消息在 *_userRow 里开新轮。
       策略：按列容器子节点顺序分段——遇到用户行清空累积，遇到 markdown 累积，
       遇到 assistant 操作行把累积文本绑给该行（WeakMap）。 */
    const rowText = new WeakMap()

    function plainOf(el) {
      const clone = el.cloneNode(true)
      clone.querySelectorAll('pre,code,svg,button').forEach((x) => x.remove())
      return (clone.innerText || '').replace(/\n{3,}/g, '\n\n').trim()
    }

    function rebuildRowText() {
      const col = document.querySelector('[class*="_column"]') || document.querySelector('[data-conversation-scroll]')
      if (!col) return
      let acc = ''
      col.querySelectorAll('[class*="_flowItem"]').forEach((f) => {
        if (f.querySelector('[class*="_userRow"]')) { acc = ''; return }
        const row = f.querySelector('div[class*="_actions"]')
        if (row && row.querySelector('button[aria-label="复制"]') && row.closest('[class*="_flowItem"]') === f) {
          rowText.set(row, acc)
          return
        }
        f.querySelectorAll('[class*="_markdown_"]').forEach((n) => { acc += plainOf(n) + '\n' })
      })
    }

    /* 字数标签：每条回复操作行里的「N 字」（取自可朗读正文，更新节流 1s） */
    let lastCharsAt = 0
    function refreshChars(force) {
      const now = Date.now()
      if (!force && now - lastCharsAt < 1000) return
      lastCharsAt = now
      rebuildRowText()
      document.querySelectorAll('div[class*="_actions"]').forEach((row) => {
        const label = row.querySelector('[data-dsh-chars]')
        if (!label) return
        const n = (rowText.get(row) || '').replace(/\s/g, '').length
        const txt = n ? `${n.toLocaleString()} 字` : ''
        if (label.textContent !== txt) label.textContent = txt
      })
    }

    function speakText(actionsRow) {
      if (rowText.has(actionsRow)) return rowText.get(actionsRow) || ''
      rebuildRowText()
      return rowText.get(actionsRow) || ''
    }

    async function toggle(ssp) {
      if (SPK.state && ssp === SPK.row) {
        if (SPK.state === 'loading') { toast('正在合成，稍候…（点 ■ 可取消）'); return }
        if (SPK.state === 'playing') { pause(); return }
        if (SPK.state === 'paused') { resume(); return }
      }
      const actionsRow = ssp.parentElement
      const text = speakText(actionsRow)
      if (!text) { toast('这条回复没有可朗读的文字'); return }
      stop() /* 停掉可能在放的其他条 */
      const seq = ++SPK.seq
      SPK.row = ssp
      SPK.state = 'loading'
      sync()
      const sel = await currentVoice()
      fetch('/tts-voice-api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'speak', entry: 'chat', provider: sel.provider, voice: sel.voice, text: [...text].slice(0, 9500).join('') }),
      })
        .then((r) => {
          if (!r.ok) {
            return r.json().catch(() => null).then((j) => {
              throw new Error((j && j.error) || 'HTTP ' + r.status)
            })
          }
          return r.blob()
        })
        .then((blob) => {
          if (seq !== SPK.seq) return
          SPK.url = URL.createObjectURL(blob)
          const audio = new Audio(SPK.url)
          SPK.audio = audio
          audio.onended = () => { if (seq === SPK.seq) stop() }
          audio.onerror = () => {
            if (seq === SPK.seq) { stop(); toast('音频播放失败') }
          }
          const pr = audio.play()
          if (pr && pr.catch) {
            pr.catch(() => { if (seq === SPK.seq) { stop(); toast('播放被浏览器拦住：再点一次 🔊') } })
          }
          SPK.state = 'playing'
          sync()
        })
        .catch((e) => {
          if (seq !== SPK.seq) return
          stop()
          toast('播报失败：' + ((e && e.message) || e))
        })
    }

    /* ---- 幂等注入：assistant 操作行（含「复制」按钮、不在用户气泡里的）挂小方框 ---- */
    function ensure() {
      document.querySelectorAll('div[class*="_actions"]').forEach((row) => {
        if (row.querySelector(`[${ATTR}]`)) return
        if (!row.querySelector('button[aria-label="复制"]')) return
        /* 用户消息的操作行包在 *_userRow 里；assistant 操作行不在（正文是同轮上方独立 flowItem） */
        if (row.closest('[class*="_userRow"]')) return
        const ssp = document.createElement('span')
        ssp.setAttribute(ATTR, '')
        const main = document.createElement('button')
        main.className = 'dsh-spk-main'
        main.innerHTML = '🔊'
        main.title = '语音播报：朗读这条回复（右键切换女/男声）'
        const stopBtn = document.createElement('button')
        stopBtn.className = 'dsh-spk-stop'
        stopBtn.title = '停止播报'
        stopBtn.innerHTML = ICONS.stop
        ssp.appendChild(main)
        ssp.appendChild(stopBtn)
        main.addEventListener('click', (ev) => { ev.stopPropagation(); toggle(ssp) })
        main.addEventListener('contextmenu', (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          const next = (() => { try { return localStorage.getItem('dsh-tts:voice') === 'stella' ? 'tide' : 'stella' } catch { return 'tide' } })()
          try { localStorage.setItem('dsh-tts:voice', next) } catch {}
          selCache = { at: 0, data: null } /* 立即重读：设置里选 DeepSeek 时生效；选了别家则忽略此切换 */
          stop() /* 换音色停掉在途播报，下次点击用新音色 */
          toast(next === 'stella' ? '已切女声 · Stella（完整音色在 设置→TTS 语音）' : '已切男声 · Tide（完整音色在 设置→TTS 语音）')
        })
        stopBtn.addEventListener('click', (ev) => { ev.stopPropagation(); stop() })
        row.insertBefore(ssp, row.firstChild)
        const chars = document.createElement('span')
        chars.setAttribute('data-dsh-chars', '')
        chars.title = '本条回复正文的字数（不含空白）'
        ssp.after(chars)
      })
      refreshChars(false)
      sync()
    }

    /* ── 对话页音色切换：输入卡片右上角「🎙 阿里·小春」胶囊，点开=全部音色（四家 × 各自音色）──
       2026-11-19 主人：「音色库 OK 了，但我在对话框里怎么把它调成阿里云的某个音色？应该有按钮」*/
    const CHIP_ATTR = 'data-dsh-voice-chip'
    const PROVIDER_LABEL = { deepseek: 'DeepSeek', volc: '火山', aliyun: '阿里', breeze: 'Breeze' }
    const vc = { sel: null, selAt: 0, groups: null, groupsAt: 0, panel: null, byProvider: null }
    let vcBound = false

    async function vcApi(body) {
      const r = await fetch('/tts-voice-api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json().catch(() => null)
      if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status))
      return j
    }
    async function vcSelection(force) {
      if (!force && vc.sel && Date.now() - vc.selAt < 20000) return vc.sel
      const j = await vcApi({ op: 'selection', entry: 'chat' })
      vc.sel = { provider: j.provider, voice: j.voice, alias: j.alias || '', byProvider: j.byProvider || {} }
      vc.selAt = Date.now()
      return vc.sel
    }
    /* 音色 id → 好记的名字（按需拉一次该家音色列表；别名优先） */
    async function vcNameOf(provider, voice) {
      vc.names = vc.names || {}
      if (!vc.names[provider]) {
        const map = {}
        try {
          const j = await vcApi({ op: 'voices', provider })
          for (const v of j.voices || []) map[v.id] = v.name || v.id
        } catch {}
        vc.names[provider] = map
      }
      return vc.names[provider][voice] || ''
    }
    function vcShortName(name, id) {
      const s = String(name || '').replace(/\s*·\s*(女声|男声|方言|英语).*$/, '').trim()
      if (s) return s
      const raw = String(id || '')
      return raw.length > 10 ? raw.slice(0, 8) + '…' : raw
    }
    async function vcChipText(sel) {
      if (!sel || !sel.voice) return '音色'
      const p = PROVIDER_LABEL[sel.provider] || sel.provider
      const name = sel.alias || (await vcNameOf(sel.provider, sel.voice))
      return p + '·' + vcShortName(name, sel.voice)
    }
    async function vcEnsureChip() {
      const card = document.querySelector('[data-composer-card="true"]')
      if (!card) return
      let chip = card.querySelector('[' + CHIP_ATTR + ']')
      if (!chip) {
        if (getComputedStyle(card).position === 'static') card.style.position = 'relative'
        chip = document.createElement('button')
        chip.type = 'button'
        chip.setAttribute(CHIP_ATTR, '')
        chip.className = 'dsh-vc-chip'
        chip.title = '对话页面播报用哪个音色（点一下换）'
        chip.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); vcOpenPanel(chip) })
        card.appendChild(chip)
      }
      try { chip.textContent = '🎙 ' + (await vcChipText(await vcSelection())) } catch { chip.textContent = '🎙 音色' }
    }
    function vcClosePanel() {
      if (vc.panel) { try { vc.panel.remove() } catch {} ; vc.panel = null }
    }
    async function vcOpenPanel(chip) {
      vcClosePanel()
      const el = document.createElement('div')
      el.className = 'dsh-vc-panel'
      el.setAttribute('data-dsh-voice-panel', '')
      const r = chip.getBoundingClientRect()
      el.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - Math.min(380, window.innerWidth * 0.92) - 8))) + 'px'
      el.style.bottom = Math.round(window.innerHeight - r.top + 8) + 'px'
      el.textContent = '⏳ 加载音色…'
      document.body.appendChild(el)
      vc.panel = el
      if (!vcBound) {
        vcBound = true
        document.addEventListener('pointerdown', (ev) => {
          if (!vc.panel) return
          if (vc.panel.contains(ev.target)) return
          if (ev.target && ev.target.closest && ev.target.closest('[' + CHIP_ATTR + ']')) return
          vcClosePanel()
        }, true)
        document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') vcClosePanel() }, true)
        window.addEventListener('resize', vcClosePanel)
      }
      let groups = []
      let sel = null
      try {
        if (!vc.groups || Date.now() - vc.groupsAt > 5 * 60 * 1000) {
          const st = await vcApi({ op: 'state' })
          const out = []
          for (const pid of ['deepseek', 'volc', 'aliyun', 'breeze']) {
            if (!st.keysOk[pid]) continue
            let list = []
            try { list = (await vcApi({ op: 'voices', provider: pid })).voices || [] } catch {}
            const custom = (st.custom[pid] || []).map((c) => ({ id: c.id, name: (st.aliases[pid] || {})[c.id] || c.alias || c.id, group: '⭐ 手动添加' }))
            const all = [...list, ...custom]
            if (all.length) out.push({ p: pid, label: PROVIDER_LABEL[pid] || pid, rows: all.map((v) => ({ id: v.id, name: (st.aliases[pid] || {})[v.id] || v.name || v.id })) })
          }
          vc.groups = out
          vc.groupsAt = Date.now()
        }
        groups = vc.groups
        sel = await vcSelection(true)
      } catch (e) {
        el.textContent = '加载音色失败：' + ((e && e.message) || e)
        return
      }
      if (!vc.panel || vc.panel !== el) return
      el.textContent = ''
      const head = document.createElement('div')
      head.className = 'dsh-vc-head'
      head.textContent = '💬 对话页面播报用哪个声音？'
      el.appendChild(head)
      for (const g of groups) {
        const gt = document.createElement('div')
        gt.className = 'dsh-vc-group'
        gt.textContent = g.label
        el.appendChild(gt)
        for (const row of g.rows) {
          const on = !!(sel && sel.provider === g.p && sel.voice === row.id)
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'dsh-vc-row'
          if (on) b.setAttribute('data-on', '1')
          b.textContent = (on ? '✓ ' : '') + row.name
          b.addEventListener('click', async (ev) => {
            ev.stopPropagation()
            try {
              const byP = { ...((sel && sel.byProvider) || {}) }
              byP[g.p] = row.id
              await vcApi({ op: 'save', entries: { chat: { provider: g.p, voice: row.id, byProvider: byP } } })
              vc.sel = { provider: g.p, voice: row.id, alias: '', byProvider: byP }
              vc.selAt = Date.now()
              vc.names = null
              selCache = { at: 0, data: null } /* msg-speak 自己那份 30s 缓存也作废 */
              toast('✅ 对话页面播报换成：' + g.label + ' · ' + row.name)
              vcClosePanel()
              vcEnsureChip()
            } catch (e) { toast('换音色失败：' + ((e && e.message) || e)) }
          })
          el.appendChild(b)
        }
      }
    }

    let mo = null
    let scheduled = 0
    const onMutate = () => {
      clearTimeout(scheduled)
      scheduled = setTimeout(ensure, 120)
    }

    return {
      apply(ctx) {
        document.head.appendChild(css)
        mo = new MutationObserver(onMutate)
        mo.observe(document.body, { childList: true, subtree: true })
        ensure()
        /* 暴露自检口（headless 验证用） */
        window.__dshMsgSpeak = { toggle, stop, pause, resume, sync, currentVoice, state: SPK, voiceChip: { open: vcOpenPanel, close: vcClosePanel, ensure: vcEnsureChip, cache: vc } }
        ctx.effect(() => () => {
          mo?.disconnect()
          clearTimeout(scheduled)
          clearTimeout(toastTimer)
          stopAudio()
          document.querySelectorAll(`[${ATTR}]`).forEach((n) => n.remove())
          document.querySelectorAll('[' + CHIP_ATTR + ']').forEach((n) => n.remove())
          vcClosePanel()
          css.remove()
          delete window.__dshMsgSpeak
        })
      },
    }
  },
})
