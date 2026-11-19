/**
 * dsh-video-eyes（Client 半）—— 拖视频进输入框 = AI 的眼睛耳朵
 *
 * 在捕获阶段拦截 drop 进会话输入区的视频文件（mp4/webm/mov/mkv），
 * POST 给 host 半处理（DeepSeek ASR 语音稿 + 0.5s 抽帧变化去重），
 * 然后把「语音稿文字 + 关键帧图片」回填进官方输入框：
 *   - 图片：用合成 drop 事件把 File 丢给官方 composer（官方管线原生接管）
 *   - 文字：focus 编辑器后 execCommand insertText
 * 开关：localStorage['dsh:video-eyes']='0' 关闭。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-video-eyes',
  factory() {
    return {
      apply() {
        if (localStorage.getItem('dsh:video-eyes') === '0') return
        if (window.__dshVideoEyes) return // 幂等（教训40）


    const VIDEO_RE = /\.(mp4|webm|mov|mkv|avi|m4v)$/i
    const state = { busy: false }

    // ────────────────── 进度胶囊 ──────────────────
    let pill = null
    function ensurePill() {
      document.querySelectorAll('[data-dsh-video-eyes]').forEach((el) => el.remove())
      pill = document.createElement('div')
      pill.dataset.dshVideoEyes = '1'
      pill.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:96px;z-index:10000;'
        + 'background:rgba(80,40,140,.92);color:#fff;padding:8px 16px;border-radius:20px;font-size:13px;'
        + 'box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:80vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
      pill.textContent = '👀 处理录屏中…'
      document.body.appendChild(pill)
      return pill
    }
    const say = (t) => { if (pill) pill.textContent = t }
    const hidePill = () => { document.querySelectorAll('[data-dsh-video-eyes]').forEach((el) => el.remove()); pill = null }

    // ────────────────── 找输入框编辑器 ──────────────────
    function findEditor(target) {
      const root = target && target.closest ? target.closest('div[class*="_root"]') : null
      const scopes = [root, document]
      for (const scope of scopes) {
        if (!scope || !scope.querySelector) continue
        const ta = scope.querySelector('textarea')
        if (ta && ta.getBoundingClientRect().height > 0) return ta
        const ce = scope.querySelector('div[contenteditable="true"]')
        if (ce && ce.getBoundingClientRect().height > 0) return ce
      }
      return document.querySelector('textarea') || document.querySelector('div[contenteditable="true"]')
    }

    function insertText(editor, text) {
      editor.focus()
      let ok = false
      try { ok = document.execCommand('insertText', false, text) } catch { ok = false }
      if (!ok && editor.tagName === 'TEXTAREA') {
        const pos = editor.selectionStart != null ? editor.selectionStart : editor.value.length
        editor.value = editor.value.slice(0, pos) + text + editor.value.slice(pos)
        editor.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }

    /** 把图片 File 列表用合成 drop 交给官方 composer（丢在原 drop 目标上）。 */
    function dropFiles(target, files) {
      const dt = new DataTransfer()
      for (const f of files) dt.items.add(f)
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      }
    }

    // ────────────────── 主流程 ──────────────────
    async function process(files, dropTarget) {
      state.busy = true
      ensurePill()
      try {
        say(`👀 上传中（${(files[0].size / 1048576).toFixed(1)}MB）…`)
        const res = await fetch('/video-eyes-api/process', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream' },
          body: files[0],
        })
        const j = await res.json()
        if (!j.ok) throw new Error(j.error || '处理失败')

        // 关键帧 → File
        say(`✅ 转写完成，取 ${j.frames.length} 张关键帧…`)
        const frameFiles = []
        for (const f of j.frames.slice(0, 40)) {
          const r = await fetch(f.url, { credentials: 'same-origin' })
          if (!r.ok) continue
          const blob = await r.blob()
          const mm = Math.floor(f.t / 60)
          const ss = (f.t % 60).toFixed(1)
          frameFiles.push(new File([blob], `画面_${mm}m${ss}s.jpg`, { type: 'image/jpeg' }))
        }

        // 语音稿文字回填
        const header = `【录屏 ${Math.round(j.durationSec)} 秒 · 我说的话】\n${j.transcript || '（没听清/无音轨）'}\n【关键帧 ${frameFiles.length} 张（按时间顺序）】\n`
        const editor = findEditor(dropTarget)
        if (editor) insertText(editor, header)
        // 图片交给官方管线
        const target = editor ? editor.closest('div[class*="_root"]') || editor : dropTarget
        if (frameFiles.length) dropFiles(target, frameFiles)
        say(`🎉 完成：${j.transcript ? j.transcript.length + ' 字语音稿' : '无语音'} + ${frameFiles.length} 帧`)
        setTimeout(hidePill, 2500)
      } catch (e) {
        say('❌ ' + String(e.message || e).slice(0, 120))
        setTimeout(hidePill, 5000)
      } finally {
        state.busy = false
      }
    }

    // ────────────────── 拦截 drop（捕获阶段） ──────────────────
    document.addEventListener('drop', (ev) => {
      if (state.busy) return
      const files = ev.dataTransfer && ev.dataTransfer.files
        ? Array.from(ev.dataTransfer.files).filter((f) => f.type.startsWith('video/') || VIDEO_RE.test(f.name))
        : []
      if (!files.length) return
      ev.preventDefault()
      ev.stopImmediatePropagation()
      process(files, ev.target)
    }, true)

    window.__dshVideoEyes = { version: '0.1.0', process }
      },
    }
  },
})
