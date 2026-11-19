/**
 * 截图标注（Client 半）—— 微信截图式两步：
 *   Alt+A → Host 抓整屏 → 冻结画面 → ①拖框选区 → ②选区下方工具条：
 *   「⭕ 圈圈」= 在选区内拖动画红椭圆（可多个）、「💾 另存为」= 裁剪选区存 PNG。
 *   Esc 取消；在选区外重新拖框=换选区。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-screenshot',
  factory(require) {
    const Z = 10001
    const LW = 4 // 屏幕上看到的描边像素宽
    const RED = '#ff2d2d'

    function post(body) {
      return fetch('/djh-screenshot-api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        credentials: 'same-origin',
      })
        .then((r) => r.json())
        .then((b) => {
          if (!b || b.ok !== true) throw new Error((b && b.error) || '请求失败')
          return b.value
        })
    }

    function normRect(a) {
      const r = { x: a.x, y: a.y, w: a.w, h: a.h }
      if (r.w < 0) {
        r.x += r.w
        r.w = -r.w
      }
      if (r.h < 0) {
        r.y += r.h
        r.h = -r.h
      }
      return r
    }

    return {
      apply(ctx) {
        let open = false
        let img = null
        let box = null // 图片显示区 {left,top,w,h,scale}
        let root = null
        let canvas = null
        let cctx = null
        let sel = null // 选区 {x,y,w,h} 图片原始像素坐标；null=还没选
        let shapes = [] // 红椭圆，原始像素坐标
        let drag = null // {kind:'sel'|'ellipse', ...}
        let tool = 'ellipse' // 只有圈圈一种画笔，按钮用来高亮提示
        let toast = null
        let toastTimer = 0
        let ro = null
        let docKey = null
        let bar = null

        function showToast(text, ms) {
          if (!toast) return
          toast.textContent = text
          toast.style.opacity = '1'
          clearTimeout(toastTimer)
          toastTimer = setTimeout(() => {
            if (toast) toast.style.opacity = '0'
          }, ms || 3000)
        }

        function toNatural(e) {
          const r = canvas.getBoundingClientRect()
          return {
            x: ((e.clientX - r.left) / r.width) * img.naturalWidth,
            y: ((e.clientY - r.top) / r.height) * img.naturalHeight,
            px: e.clientX - r.left,
            py: e.clientY - r.top,
          }
        }

        function inSel(p) {
          if (!sel) return false
          return p.x >= sel.x && p.x <= sel.x + sel.w && p.y >= sel.y && p.y <= sel.y + sel.h
        }

        function redrawAll() {
          if (!cctx || !box || !img) return
          const W = canvas.width
          const H = canvas.height
          cctx.clearRect(0, 0, W, H)
          /* 选区视觉：外暗内透（微信式）——选区本身不着色，只有一圈细白边 */
          const r = sel || (drag && drag.kind === 'sel' ? normRect(drag) : null)
          if (r) {
            cctx.fillStyle = 'rgba(0,0,0,.45)'
            cctx.fillRect(0, 0, W, r.y)
            cctx.fillRect(0, r.y + r.h, W, H - r.y - r.h)
            cctx.fillRect(0, r.y, r.x, r.h)
            cctx.fillRect(r.x + r.w, r.y, W - r.x - r.w, r.h)
            cctx.strokeStyle = 'rgba(255,255,255,.95)'
            cctx.lineWidth = (LW * 0.75) / box.scale
            cctx.strokeRect(r.x, r.y, r.w, r.h)
          }
          /* 红椭圆画在选区之上 */
          const list = drag && drag.kind === 'ellipse' ? shapes.concat([normRect(drag)]) : shapes
          for (const s of list) {
            cctx.strokeStyle = RED
            cctx.lineWidth = LW / box.scale
            cctx.beginPath()
            cctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.max(1, s.w / 2), Math.max(1, s.h / 2), 0, 0, Math.PI * 2)
            cctx.stroke()
          }
        }

        function placeBar() {
          if (!bar || !box) return
          if (!sel) {
            bar.style.display = 'none'
            return
          }
          bar.style.display = 'flex'
          /* 放选区正下方（显示坐标 = 原始 × scale + box.left/top） */
          const bw = bar.offsetWidth || 240
          const bh = bar.offsetHeight || 44
          let x = box.left + (sel.x + sel.w) * box.scale - bw
          let y = box.top + (sel.y + sel.h) * box.scale + 8
          if (y + bh > window.innerHeight - 8) y = box.top + sel.y * box.scale - bh - 8
          if (y < 8) y = 8
          if (x < 8) x = 8
          if (x + bw > window.innerWidth - 8) x = window.innerWidth - bw - 8
          bar.style.left = Math.round(x) + 'px'
          bar.style.top = Math.round(y) + 'px'
        }

        function layout() {
          if (!img || !root || !canvas) return
          const vw = window.innerWidth
          const vh = window.innerHeight
          /* 铺满全屏：截图是物理像素(如 3840×2160)。目标比例 = cover 视口，
             但封顶 1/dpr（= 物理精确映射：屏幕缩放 150% 时显示 2560×1440，和真实屏幕 1:1）。
             dpr=1 的小窗口里就退化为普通 cover，不再溢出。 */
          const dpr = window.devicePixelRatio || 1
          const k = Math.min(1 / dpr, Math.min(vw / img.naturalWidth, vh / img.naturalHeight)) /* contain：整屏完整可见，不裁剪（cover 会割掉桌面图标区） */
          const w = Math.round(img.naturalWidth * k)
          const h = Math.round(img.naturalHeight * k)
          box = { left: Math.round((vw - w) / 2), top: Math.round((vh - h) / 2), w, h, scale: k }
          const holder = root.querySelector('[data-shot-holder]')
          holder.style.left = box.left + 'px'
          holder.style.top = box.top + 'px'
          holder.style.width = w + 'px'
          holder.style.height = h + 'px'
          canvas.width = img.naturalWidth
          canvas.height = img.naturalHeight
          canvas.style.width = w + 'px'
          canvas.style.height = h + 'px'
          redrawAll()
          placeBar()
        }

        function close() {
          open = false
          drag = null
          shapes = []
          sel = null
          if (docKey) {
            document.removeEventListener('keydown', docKey, true)
            docKey = null
          }
          if (ro) {
            ro.disconnect()
            ro = null
          }
          if (root) {
            root.remove()
            root = null
          }
          canvas = null
          cctx = null
          box = null
          toast = null
          bar = null
        }

        function buildPng() {
          if (!img || !box) return null
          if (!sel || sel.w < 4 || sel.h < 4) return null
          const out = document.createElement('canvas')
          out.width = Math.round(sel.w)
          out.height = Math.round(sel.h)
          const c = out.getContext('2d')
          c.drawImage(img, sel.x, sel.y, sel.w, sel.h, 0, 0, out.width, out.height)
          for (const s of shapes) {
            c.strokeStyle = RED
            c.lineWidth = LW / box.scale
            c.beginPath()
            c.ellipse(s.x + s.w / 2 - sel.x, s.y + s.h / 2 - sel.y, Math.max(1, s.w / 2), Math.max(1, s.h / 2), 0, 0, Math.PI * 2)
            c.stroke()
          }
          return out.toDataURL('image/png')
        }

        /* 遮罩外的全局小 toast（复制是「先退出、后台复制」，退出后还要能提示结果） */
        function bodyToast(text, ms) {
          const t = document.createElement('div')
          t.dataset.dshShotToast = '1'
          t.textContent = text
          t.style.cssText =
            'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:' + (Z + 2) + ';' +
            'background:rgba(20,20,22,.95);color:#fff;padding:9px 18px;border-radius:10px;' +
            'font-size:13px;border:1px solid rgba(255,255,255,.15);pointer-events:none;'
          document.body.appendChild(t)
          setTimeout(() => t.remove(), ms || 2200)
        }

        function doCopy() {
          const dataUrl = buildPng()
          if (!dataUrl) {
            showToast('先在画面上拖框选区', 2500)
            return
          }
          /* 复制即退出：立刻收掉遮罩，剪贴板在后台写（写完弹个小提示） */
          close()
          post({ action: 'copy', dataUrl })
            .then(() => bodyToast('✅ 已复制，Ctrl+V 直接粘贴'))
            .catch((e) => bodyToast('❌ 复制失败：' + (e && e.message ? e.message : e), 3500))
        }

        async function doSave() {
          if (!img || !box) return
          if (!sel || sel.w < 4 || sel.h < 4) {
            showToast('先拖框选一块区域', 2500)
            return
          }
          const dataUrl = buildPng()
          if (!dataUrl) return
          /* 另存为 = 系统保存对话框，自己选位置自己起名 */
          const now = new Date()
          const p2 = (n) => String(n).padStart(2, '0')
          const name =
            '截图' + now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate()) +
            '-' + p2(now.getHours()) + p2(now.getMinutes()) + p2(now.getSeconds()) + '.png'
          if (window.showSaveFilePicker) {
            try {
              const handle = await window.showSaveFilePicker({
                suggestedName: name,
                types: [{ description: 'PNG 图片', accept: { 'image/png': ['.png'] } }],
              })
              const blob = await (await fetch(dataUrl)).blob()
              const w = await handle.createWritable()
              await w.write(blob)
              await w.close()
              showToast('✅ 已保存', 1500)
              setTimeout(close, 600)
              return
            } catch (e) {
              if (e && e.name === 'AbortError') return /* 用户取消，留在截图里 */
              /* 其他异常走下载兜底 */
            }
          }
          /* 兜底：浏览器下载 */
          const a = document.createElement('a')
          a.href = dataUrl
          a.download = name
          document.body.appendChild(a)
          a.click()
          a.remove()
          bodyToast('💾 已按下载方式保存：' + name)
          setTimeout(close, 600)
        }

        function onDown(e) {
          if (e.button !== 0 || !img) return
          e.preventDefault()
          const p = toNatural(e)
          if (!sel || !inSel(p)) {
            /* 选区外按下 = 重新拖框选区 */
            sel = null
            shapes = []
            drag = { kind: 'sel', x: p.x, y: p.y, w: 0, h: 0 }
          } else {
            /* 选区内按下 = 画红椭圆（圈圈） */
            drag = { kind: 'ellipse', x: p.x, y: p.y, w: 0, h: 0 }
          }
          placeBar()
          try {
            canvas.setPointerCapture(e.pointerId)
          } catch {}
        }

        function onMove(e) {
          if (!drag) return
          const p = toNatural(e)
          drag.w = p.x - drag.x
          drag.h = p.y - drag.y
          redrawAll()
        }

        function onUp() {
          if (!drag) return
          const r = normRect(drag)
          const kind = drag.kind
          drag = null
          if (kind === 'sel') {
            /* 太小的当作误触：回到未选状态 */
            if (r.w >= 10 && r.h >= 10) sel = r
            else sel = null
          } else if (r.w >= 6 && r.h >= 6) {
            shapes.push(r)
          }
          redrawAll()
          placeBar()
        }

        function buildOverlay() {
          root = document.createElement('div')
          root.dataset.dshScreenshot = '1'
          root.style.cssText =
            'position:fixed;inset:0;z-index:' + Z + ';background:rgba(0,0,0,.88);overflow:hidden;'

          const holder = document.createElement('div')
          holder.dataset.shotHolder = '1'
          holder.style.cssText = 'position:absolute;box-shadow:0 8px 44px rgba(0,0,0,.7);'

          const image = document.createElement('img')
          image.draggable = false
          image.style.cssText = 'width:100%;height:100%;display:block;user-select:none;-webkit-user-drag:none;'
          image.src = img.src
          holder.appendChild(image)

          canvas = document.createElement('canvas')
          canvas.style.cssText = 'position:absolute;inset:0;cursor:crosshair;touch-action:none;'
          canvas.addEventListener('pointerdown', onDown)
          canvas.addEventListener('pointermove', onMove)
          canvas.addEventListener('pointerup', onUp)
          canvas.addEventListener('pointercancel', onUp)
          /* 选区内双击 = 复制到剪贴板（微信同款手感） */
          canvas.addEventListener('dblclick', (e) => {
            if (!sel) return
            const p = toNatural(e)
            if (inSel(p)) doCopy()
          })
          cctx = canvas.getContext('2d')
          holder.appendChild(canvas)
          root.appendChild(holder)

          const hint = document.createElement('div')
          hint.dataset.shotHint = '1'
          hint.textContent = '拖动鼠标框选区域 · 选好后双击=复制，可直接 Ctrl+V 粘贴'
          hint.style.cssText =
            'position:absolute;top:16px;left:50%;transform:translateX(-50%);' +
            'font-size:13px;color:#eee;background:rgba(0,0,0,.55);padding:6px 16px;' +
            'border-radius:999px;pointer-events:none;white-space:nowrap;'
          root.appendChild(hint)

          /* 工具条：只有「圈圈」和「另存为」两个按钮，跟着选区走 */
          bar = document.createElement('div')
          bar.style.cssText =
            'position:absolute;display:none;gap:8px;align-items:center;' +
            'background:rgba(24,24,26,.96);border:1px solid rgba(255,255,255,.16);' +
            'border-radius:10px;padding:6px;z-index:2;'
          const mkBtn = (html, fn, primary) => {
            const b = document.createElement('button')
            b.innerHTML = html
            b.style.cssText =
              'display:inline-flex;align-items:center;gap:5px;padding:7px 14px;border-radius:8px;' +
              'cursor:pointer;font-size:13px;line-height:1;border:1px solid transparent;' +
              (primary
                ? 'background:#ff2d2d;color:#fff;font-weight:600;'
                : 'background:transparent;color:#eee;')
            b.onclick = (ev) => {
              ev.stopPropagation()
              fn(b)
            }
            return b
          }
          const circleBtn = mkBtn('⭕ 圈圈', (b) => {
            tool = 'ellipse'
            b.style.borderColor = RED
            showToast('在选区内拖动画红椭圆（可画多个）', 2600)
          }, false)
          circleBtn.style.borderColor = RED
          bar.appendChild(circleBtn)
          bar.appendChild(mkBtn('💾 另存为', doSave, true))
          root.appendChild(bar)

          toast = document.createElement('div')
          toast.style.cssText =
            'position:absolute;bottom:84px;left:50%;transform:translateX(-50%);' +
            'font-size:13px;color:#fff;background:rgba(0,0,0,.7);padding:6px 14px;' +
            'border-radius:8px;opacity:0;transition:opacity .25s;pointer-events:none;' +
            'white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis;'
          root.appendChild(toast)

          docKey = (e) => {
            if (!open) return
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              close()
            } else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
              e.preventDefault()
              e.stopPropagation()
              doSave()
            } else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
              e.preventDefault()
              e.stopPropagation()
              if (sel) doCopy()
            }
          }
          document.addEventListener('keydown', docKey, true)

          ro = new ResizeObserver(() => layout())
          ro.observe(document.documentElement)

          document.body.appendChild(root)
          layout()
        }

        function start() {
          if (open) return
          open = true
          post({ action: 'capture' })
            .then((v) => {
              if (!open) return
              return new Promise((resolve, reject) => {
                const im = new Image()
                im.onload = () => resolve()
                im.onerror = reject
                im.src = v.dataUrl
                img = im
              })
            })
            .then(() => {
              if (!open) return
              shapes = []
              sel = null
              buildOverlay()
            })
            .catch((e) => {
              close()
              console.error('[dsh-screenshot]', e)
              const t = document.createElement('div')
              t.textContent = '截图失败：' + (e && e.message ? e.message : e)
              t.style.cssText =
                'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:' + (Z + 1) + ';' +
                'background:#c0392b;color:#fff;padding:10px 20px;border-radius:10px;font-size:13px;'
              document.body.appendChild(t)
              setTimeout(() => t.remove(), 3500)
            })
        }

        /* 快捷键（页面内生效，含设置页）—— 可自定义：localStorage['dsh-shot:hotkey']，
           规范串 "Ctrl+Alt+Shift+Meta+<e.code>"，默认 Alt+KeyA；设置›截图 分区里改。
           认 e.code 而不只 e.key：中文输入法开启时 keydown 的 key 会是 'Process'，code 仍是 'KeyA'。
           每次按键时现读 localStorage → 设置页改完即时生效（含其它窗口，storage/BroadcastChannel 兜底）。 */
        const HOTKEY_LS = 'dsh-shot:hotkey'
        function currentHotkey() {
          try {
            const v = localStorage.getItem(HOTKEY_LS)
            if (v) {
              const parts = v.split('+').map((s) => s.trim()).filter(Boolean)
              const a = { ctrl: false, alt: false, shift: false, meta: false, code: '' }
              for (const p of parts) {
                const q = p.toLowerCase()
                if (q === 'ctrl' || q === 'control') a.ctrl = true
                else if (q === 'alt') a.alt = true
                else if (q === 'shift') a.shift = true
                else if (q === 'meta' || q === 'win' || q === 'cmd') a.meta = true
                else a.code = p
              }
              if (a.code) return a
            }
          } catch {}
          return { ctrl: false, alt: true, shift: false, meta: false, code: 'KeyA' } /* 默认 Alt+A */
        }
        const hotkey = (e) => {
          const a = currentHotkey()
          if (
            e.code === a.code &&
            !!e.ctrlKey === a.ctrl && !!e.altKey === a.alt &&
            !!e.shiftKey === a.shift && !!e.metaKey === a.meta
          ) {
            e.preventDefault()
            e.stopPropagation()
            if (!open) start()
          }
        }
        document.addEventListener('keydown', hotkey, true)

        /* 独立小窗（如模型比价的 window.open 窗口）里按 Alt+A → 通过 BroadcastChannel
           叫主窗口开始截图。比依赖 window.opener 稳：跨窗口同源通用，opener 被清掉
           （about:blank/无 opener 环境）也能用。 */
        let shotChannel = null
        try {
          shotChannel = new BroadcastChannel('djh-screenshot')
          shotChannel.onmessage = (ev) => {
            if (ev && ev.data && ev.data.type === 'start' && !open) start()
          }
        } catch {}

        /* 给插件专区页的按钮用 */
        window.__DSH_SCREENSHOT_START__ = start

        ctx.effect(() => () => {
          document.removeEventListener('keydown', hotkey, true)
          delete window.__DSH_SCREENSHOT_START__
          if (shotChannel) { try { shotChannel.close() } catch {} shotChannel = null }
          close()
        })
      },
    }
  },
})
