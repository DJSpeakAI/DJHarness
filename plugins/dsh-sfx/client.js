/**
 * 音效（Client 半）—— 抄 little DJ 的设置→音效，落到 DSH 的两件事上：
 *
 *   ① 大管家回复结束（本会话/其他会话跑完一轮）→ 响一声「完成音」
 *   ② 大管家向你提问（ask_user_question 弹卡片）→ 响一声「提问音」
 *
 * 声音不是音频文件，是 little DJ 那 6 个 WebAudio 实时合成音（叮/铃/水滴/滴/和弦/叩）+「无」，
 * 音色、音量、连压缩器的参数都照抄，听感与 little DJ 一致。
 *
 * 设置页挂在 设置→音效（`settings.section`，order 5，排在「通用设置」后面），
 * 与本机偏好一起存 localStorage（按设备走，和 little DJ 一样）：
 *   dsh.sfx.vol   音量 0–100（默认 80）
 *   dsh.sfx.done  完成音（默认 ding 叮）
 *   dsh.sfx.ask   提问音（默认 chord 和弦）
 *
 * 触发口不自己轮询：DSH 前端本来就把「每个会话是否在跑 / 是否在等你回答」
 * 聚合成 `sessionStatus`（侧栏小圆点、问号标记都读它）。这里用槽位标准 props
 * `useSessionStatus` / `useSessions` 读同一份事实，只在状态跳变时发声。
 *
 * ── 2026-11-15 加：锁屏/后台保活（抄 little DJ task193/262 的坑，重做一遍） ──
 *
 * 手机息屏后，网页默认会被浏览器挂起：状态收不到、AudioContext 被挂起、声音出不来。
 * 唯一通用解法是让浏览器把本页当「正在放音的 App」：
 *   ① 一段近无声的循环音轨（220Hz、2% 振幅、元素音量 0.02）→ 页面不被冻结、状态照收；
 *   ② MediaSession 元数据（含 artwork/播放器按钮）→ 安卓系才给锁屏媒体卡片，给卡片才不被冻；
 *   ③ 完成音在 hidden 时改走预渲染 WAV 的 <audio>（和保活同一媒体通道），不用被挂起的 WebAudio；
 *   ④ 播放被拦 / 保活没起来 → 用 Service Worker 发系统通知（锁屏也能响一声、带振动）。
 *
 * 诚实边界（浏览器原理性限制）：系统省电杀浏览器、最近任务里划掉、深度省电断网 → 收不到；
 * 那种情况解锁回来看页面补响（60s 待播队列）。保活常驻音频管线会略增耗电，可在设置里关。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-sfx',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    // ───────────────────────── 偏好存储 ─────────────────────────
    const KEY_VOL = 'dsh.sfx.vol'
    const KEY_DONE = 'dsh.sfx.done'
    const KEY_ASK = 'dsh.sfx.ask'
    const KEY_KA = 'dsh.sfx.keepalive'
    const DEFAULT_VOL = 80

    function readPref(key) {
      try {
        return window.localStorage.getItem(key)
      } catch (e) {
        return null
      }
    }

    function writePref(key, value) {
      try {
        window.localStorage.setItem(key, String(value))
      } catch (e) {
        /* 隐私模式/配额满：这次不存，界面照常 */
      }
    }

    /** 锁屏/后台保活开关：默认开（关掉就回到「只在亮屏前台响」）。 */
    function keepaliveEnabled() {
      const raw = readPref(KEY_KA)
      return raw == null || raw === '' ? true : raw !== '0'
    }

    // ───────────────────────── 音色（照抄 little DJ） ─────────────────────────
    function note(ctx, out, type, freq, start, dur, peak, glideTo) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = type || 'sine'
      o.frequency.setValueAtTime(freq, start)
      if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, start + dur * 0.9)
      g.gain.setValueAtTime(0.0001, start)
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + 0.012)
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
      o.connect(g)
      g.connect(out)
      o.start(start)
      o.stop(start + dur + 0.02)
    }

    const SOUNDS = [
      {
        id: 'ding',
        label: '叮',
        play(ctx, out, t) {
          note(ctx, out, 'sine', 880, t, 0.3, 0.18)
          note(ctx, out, 'sine', 1320, t + 0.09, 0.28, 0.15)
        },
      },
      {
        id: 'bell',
        label: '铃',
        play(ctx, out, t) {
          note(ctx, out, 'triangle', 1568, t, 0.5, 0.15)
          note(ctx, out, 'sine', 2093, t, 0.42, 0.1)
        },
      },
      {
        id: 'drop',
        label: '水滴',
        play(ctx, out, t) {
          note(ctx, out, 'sine', 1150, t, 0.24, 0.22, 420)
        },
      },
      {
        id: 'blip',
        label: '滴',
        play(ctx, out, t) {
          note(ctx, out, 'square', 1046, t, 0.13, 0.16)
        },
      },
      {
        id: 'chord',
        label: '和弦',
        play(ctx, out, t) {
          ;[523.25, 659.25, 783.99].forEach((f, i) => note(ctx, out, 'sine', f, t + i * 0.06, 0.36, 0.11))
        },
      },
      {
        id: 'knock',
        label: '叩',
        play(ctx, out, t) {
          note(ctx, out, 'triangle', 300, t, 0.16, 0.24)
          note(ctx, out, 'triangle', 340, t + 0.11, 0.16, 0.18)
        },
      },
    ]

    const NONE = { id: 'none', label: '无' }
    const CHIPS = SOUNDS.concat([NONE])

    function isSoundId(id) {
      return id === 'none' || SOUNDS.some((s) => s.id === id)
    }

    function getVol() {
      const raw = readPref(KEY_VOL)
      if (raw == null || raw === '') return DEFAULT_VOL
      const n = Number(raw)
      if (!Number.isFinite(n)) return DEFAULT_VOL
      return Math.max(0, Math.min(100, Math.round(n)))
    }

    function getDoneSound() {
      const id = readPref(KEY_DONE)
      return id && isSoundId(id) ? id : 'ding'
    }

    function getAskSound() {
      const id = readPref(KEY_ASK)
      return id && isSoundId(id) ? id : 'chord'
    }

    // ───────────────────────── 锁屏保活引擎（KA） ─────────────────────────
    /** 近无声循环音轨 + MediaSession：让系统把本页当「正在放音的 App」，息屏后不冻结。 */
    const KA = {
      el: null,
      wav: {},
      rendered: false,
      silentSrc: '',
      userPaused: false,
      healT: null,
      healN: 0,
      watchT: null,
    }

    function kaActive() {
      return !!(keepaliveEnabled() && KA.el && !KA.el.paused)
    }

    function wavBlobMono(buf) {
      const n = buf.length
      const ch = buf.getChannelData(0)
      const out = new ArrayBuffer(44 + n * 2)
      const dv = new DataView(out)
      const w = (o, s) => {
        for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i))
      }
      w(0, 'RIFF')
      dv.setUint32(4, 36 + n * 2, true)
      w(8, 'WAVE')
      w(12, 'fmt ')
      dv.setUint32(16, 16, true)
      dv.setUint16(20, 1, true)
      dv.setUint16(22, 1, true)
      dv.setUint32(24, buf.sampleRate, true)
      dv.setUint32(28, buf.sampleRate * 2, true)
      dv.setUint16(32, 2, true)
      dv.setUint16(34, 16, true)
      w(36, 'data')
      dv.setUint32(40, n * 2, true)
      for (let i = 0; i < n; i++) {
        dv.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(ch[i] * 32767))), true)
      }
      return new Blob([out], { type: 'audio/wav' })
    }

    /** 220Hz 正弦 2% 振幅（元素音量再压到 0.02）→ 人耳近无声，但系统视为「有信号在播」；
     *  全零静音样本会被部分浏览器当暂停处理，保活失效（little DJ task193 的坑）。 */
    function kaSilentSrc() {
      if (KA.silentSrc) return KA.silentSrc
      const sr = 22050
      const n = sr * 2
      const buf = new ArrayBuffer(44 + n * 2)
      const dv = new DataView(buf)
      const w = (o, s) => {
        for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i))
      }
      w(0, 'RIFF')
      dv.setUint32(4, 36 + n * 2, true)
      w(8, 'WAVE')
      w(12, 'fmt ')
      dv.setUint32(16, 16, true)
      dv.setUint16(20, 1, true)
      dv.setUint16(22, 1, true)
      dv.setUint32(24, sr, true)
      dv.setUint32(28, sr * 2, true)
      dv.setUint16(32, 2, true)
      dv.setUint16(34, 16, true)
      w(36, 'data')
      dv.setUint32(40, n * 2, true)
      for (let i = 0; i < n; i++) {
        dv.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 650), true)
      }
      KA.silentSrc = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
      return KA.silentSrc
    }

    /** 前台有手势后把 6 种音色用 OfflineAudioContext 渲染成 WAV：
     *  息屏时 WebAudio 常被挂起，走 <audio>（与保活音轨同一媒体通道）才出得来声。 */
    function kaRenderWavs() {
      if (KA.rendered) return
      KA.rendered = true
      try {
        const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext
        if (!OC) return
        SOUNDS.forEach((snd) => {
          try {
            const oc = new OC(1, Math.ceil(44100 * 1.2), 44100)
            const master = oc.createGain()
            master.gain.value = 2.2
            const comp = oc.createDynamicsCompressor()
            comp.threshold.value = -14
            comp.knee.value = 12
            comp.ratio.value = 4
            comp.attack.value = 0.003
            comp.release.value = 0.2
            master.connect(comp)
            comp.connect(oc.destination)
            snd.play(oc, master, 0.02)
            const pr = oc.startRendering()
            if (pr && pr.then) {
              pr.then((rendered) => {
                try {
                  KA.wav[snd.id] = URL.createObjectURL(wavBlobMono(rendered))
                } catch (e) {
                  /* 渲染失败只是失去 hidden 兜底通道，WebAudio 主通道不受影响 */
                }
              }).catch(() => {})
            }
          } catch (e) {
            /* 单个音色渲染失败不影响其它 */
          }
        })
      } catch (e) {
        /* 没有 OfflineAudioContext 的老浏览器：只用 WebAudio */
      }
    }

    /** MediaSession 完整化：artwork/album/播放态/播放器按钮是锁屏媒体卡片的要件，
     *  缺 artwork 时部分安卓浏览器不给卡片 → 页面被当普通后台页 → 锁屏冻结。 */
    function kaMsSync() {
      if (!('mediaSession' in navigator) || !window.MediaMetadata) return
      try {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: 'DSH 待命中',
          artist: 'DJH · 任务完成提醒',
          album: 'DeepSeek Harness',
          artwork: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          ],
        })
        try {
          navigator.mediaSession.playbackState = KA.el && !KA.el.paused ? 'playing' : 'paused'
        } catch (e) {}
        try {
          navigator.mediaSession.setActionHandler('play', () => {
            KA.userPaused = false
            kaStart()
          })
        } catch (e) {}
        try {
          navigator.mediaSession.setActionHandler('pause', () => {
            KA.userPaused = true
            try {
              if (KA.el) KA.el.pause()
            } catch (e) {}
            kaMsSync()
          })
        } catch (e) {}
      } catch (e) {}
    }

    function kaHealSchedule() {
      /* 指数退避 1s→16s、连续 5 次失败放弃（防死循环耗电）；成功续播清计数 */
      if (KA.healT) return
      const wait = Math.min(16000, 1000 * Math.pow(2, KA.healN))
      KA.healT = window.setTimeout(() => {
        KA.healT = null
        if (!keepaliveEnabled() || KA.userPaused || !document.hidden) {
          KA.healN = 0
          return
        }
        if (KA.el && KA.el.paused) {
          if (++KA.healN > 5) {
            KA.healN = 0
            return
          }
          const pr = KA.el.play()
          if (pr && pr.then) {
            pr.then(() => {
              KA.healN = 0
              kaMsSync()
            }).catch(() => kaHealSchedule())
          } else kaHealSchedule()
        } else KA.healN = 0
      }, wait)
    }

    function kaHealClear() {
      if (KA.healT) {
        window.clearTimeout(KA.healT)
        KA.healT = null
      }
      KA.healN = 0
    }

    function kaStop() {
      KA.userPaused = true
      kaHealClear()
      try {
        if (KA.el) KA.el.pause()
      } catch (e) {}
      try {
        if ('mediaSession' in navigator) {
          navigator.mediaSession.metadata = null
          navigator.mediaSession.playbackState = 'none'
        }
      } catch (e) {}
    }

    function kaStart() {
      if (!keepaliveEnabled()) return
      try {
        if (!KA.el) {
          const a = document.createElement('audio')
          a.setAttribute('data-dsh-sfx-ka', '')
          a.loop = true
          a.volume = 0.02
          a.preload = 'auto'
          a.setAttribute('playsinline', '')
          a.setAttribute('webkit-playsinline', '')
          a.src = kaSilentSrc()
          a.addEventListener('pause', () => {
            /* 系统/省电把保活音轨按住 → 自愈续播（锁屏出声的生命线）；用户主动暂停不拉回 */
            if (document.hidden && keepaliveEnabled() && !KA.userPaused) kaHealSchedule()
          })
          KA.el = a
          try {
            document.body.appendChild(a)
          } catch (e) {}
        }
        KA.userPaused = false
        if (KA.el.paused) {
          const pr = KA.el.play()
          if (pr && pr.catch) pr.catch(() => {})
        }
        kaRenderWavs()
        kaMsSync()
      } catch (e) {}
    }

    /** 20s 看门狗：系统暂停（pause 事件丢失/页面冻结后恢复）时把保活音轨和媒体卡片拉回来。 */
    function kaWatchTick() {
      if (!keepaliveEnabled()) {
        if (KA.el && !KA.el.paused) kaStop()
        return
      }
      if (KA.userPaused) return
      if (!KA.el || KA.el.paused) {
        if (document.hidden) kaStart()
        return
      }
      try {
        if ('mediaSession' in navigator && navigator.mediaSession.playbackState !== 'playing') kaMsSync()
      } catch (e) {}
    }

    // ───────────────────────── 系统通知兜底（SW） ─────────────────────────
    /** 出声被拦/保活没起来时，用系统通知兜一声——安卓锁屏上通知带系统提示音+振动。
     *  必须走 Service Worker（安卓 Chrome 不支持构造式 Notification），SW 文件由 dist 静态承载。 */
    const SW = { reg: null, tried: false }

    function notificationReady() {
      return 'Notification' in window && window.Notification.permission === 'granted'
    }

    function ensureServiceWorker() {
      if (SW.reg || SW.tried) return SW.reg
      if (!('serviceWorker' in navigator)) return null
      SW.tried = true
      try {
        navigator.serviceWorker
          .register('/sfx-sw.js', { scope: '/' })
          .then((reg) => {
            SW.reg = reg
            try {
              window.dispatchEvent(new CustomEvent('dsh-sfx-sw-ready'))
            } catch (e) {}
          })
          .catch(() => {
            /* 注册失败（老浏览器/权限）：保留构造式 Notification 兜底 */
          })
      } catch (e) {
        /* 同上 */
      }
      return null
    }

    function notifyAlert(title, body) {
      if (!notificationReady()) return false
      const opts = {
        body,
        tag: 'dsh-sfx-alert',
        renotify: true,
        silent: false,
        vibrate: [200, 90, 200],
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url: '/' },
      }
      try {
        const reg = SW.reg || (navigator.serviceWorker && navigator.serviceWorker.controller ? { showNotification: null } : null)
        if (SW.reg && typeof SW.reg.showNotification === 'function') {
          SW.reg.showNotification(title, opts).catch(() => {})
          return true
        }
        if (reg && reg.showNotification) {
          reg.showNotification(title, opts)
          return true
        }
        /* 桌面浏览器构造式通知能把声音带出来，安卓会静默失败但不报错 */
        new window.Notification(title, opts)
        return true
      } catch (e) {
        return false
      }
    }

    /** 请求通知权限（必须由用户点击触发）。返回是否已授权。 */
    function askNotification() {
      if (!('Notification' in window)) return Promise.resolve(false)
      if (window.Notification.permission === 'granted') {
        ensureServiceWorker()
        return Promise.resolve(true)
      }
      if (window.Notification.permission === 'denied') return Promise.resolve(false)
      try {
        const pr = window.Notification.requestPermission()
        if (pr && pr.then) {
          return pr.then((state) => {
            if (state === 'granted') ensureServiceWorker()
            return state === 'granted'
          }).catch(() => false)
        }
      } catch (e) {
        return Promise.resolve(false)
      }
      return Promise.resolve(false)
    }

    // ───────────────────────── 播放引擎 ─────────────────────────
    const engine = { ctx: null, pend: null, last: '', count: 0, history: [] }

    function flushPend() {
      const p = engine.pend
      if (!p) return
      engine.pend = null
      if (Date.now() - p.at > 60000) return
      play(p.id)
    }

    /** 拿可用的 AudioContext；被浏览器挂起时发起 resume 并返回 null（声音进待播队列）。 */
    function ensureAudio() {
      try {
        if (!engine.ctx) {
          const AC = window.AudioContext || window.webkitAudioContext
          if (!AC) return null
          engine.ctx = new AC()
        }
        if (engine.ctx.state === 'running') {
          if (engine.pend) flushPend()
          return engine.ctx
        }
        const pr = engine.ctx.resume()
        if (pr && pr.then) {
          pr.then(() => {
            if (engine.ctx && engine.ctx.state === 'running') flushPend()
          }).catch(() => {})
        } else {
          flushPend()
        }
      } catch (e) {
        return null
      }
      return null
    }

    function markPlayed(soundId) {
      engine.last = soundId
      engine.count += 1
      engine.history.push(soundId)
      if (engine.history.length > 40) engine.history.shift()
    }

    /** hidden 时走预渲染 WAV —— 媒体元素通道与保活音轨同类，息屏也能出声。
     *  play() 真被拒（自动播放策略/系统拦截）→ 入待播队列 + 系统通知兜一声。 */
    function playHiddenWav(soundId) {
      const url = KA.wav[soundId]
      if (!url) return false
      const vol = getVol()
      if (vol <= 0) return false
      try {
        const ea = document.createElement('audio')
        ea.setAttribute('data-dsh-sfx-wav', '')
        ea.src = url
        ea.volume = Math.max(0, Math.min(1, vol / 100))
        try {
          document.body.appendChild(ea)
          ea.onended = () => {
            try {
              ea.remove()
            } catch (e) {}
          }
        } catch (e) {}
        const pr = ea.play()
        if (pr && pr.catch) {
          pr.catch(() => {
            try {
              ea.remove()
            } catch (e) {}
            engine.pend = { id: soundId, at: Date.now() }
            notifyAlert('DJH · 有事叫你', '锁屏中页面出声被拦，解锁回来看结果')
          })
        }
        markPlayed(soundId)
        return true
      } catch (e) {
        return false
      }
    }

    /** 播一个音；返回是否真的发了声（音量 0 / 「无」/ 音频没解锁都会返回 false）。 */
    function play(id) {
      const soundId = id || getDoneSound()
      if (!soundId || soundId === 'none') return false
      const vol = getVol()
      if (vol <= 0) return false
      const snd = SOUNDS.find((s) => s.id === soundId)
      if (!snd) return false

      // ① 后台/锁屏且保活音轨在跑：优先媒体通道（WebAudio 此时常被系统挂起）
      if (document.hidden && kaActive() && playHiddenWav(soundId)) return true

      // ② 后台且保活没起来：页面音基本出不来，直接系统通知（不能静默丢掉）
      if (document.hidden && !kaActive()) {
        if (notificationReady() && notifyAlert('DJH · 任务提醒', '后台出声不可用，用系统通知提醒你')) return true
      }

      const ctx = ensureAudio()
      if (!ctx) {
        engine.pend = { id: soundId, at: Date.now() }
        return false
      }
      try {
        const master = ctx.createGain()
        master.gain.value = (vol / 100) * 2.2
        const comp = ctx.createDynamicsCompressor()
        comp.threshold.value = -14
        comp.knee.value = 12
        comp.ratio.value = 4
        comp.attack.value = 0.003
        comp.release.value = 0.2
        master.connect(comp)
        comp.connect(ctx.destination)
        snd.play(ctx, master, ctx.currentTime + 0.02)
      } catch (e) {
        return false
      }
      markPlayed(soundId)
      return true
    }

    // ───────────────────────── 状态监听（只认跳变） ─────────────────────────
    /** 一问一答期间抑制「完成音」的等待时间：问卡片冒出来时只响提问音，不双响。 */
    const DONE_DELAY_MS = 600

    function SfxMonitor(props) {
      const selectAll = (value) => value
      const statuses = props.useSessionStatus(selectAll)
      const sessions = props.useSessions(selectAll)

      const prevRef = useRef(null)
      const latestRef = useRef(statuses)
      const timersRef = useRef({ done: new Map(), ask: new Map() })
      latestRef.current = statuses

      function scheduleDone(sessionId) {
        const timers = timersRef.current
        if (timers.done.has(sessionId)) return
        const t = window.setTimeout(() => {
          timers.done.delete(sessionId)
          const now = latestRef.current
          const st = now ? now.get(sessionId) : undefined
          // 又跑起来了，或正在等你回答 → 这一声不响
          if (st && (st.running === true || st.pendingInteraction)) return
          play(getDoneSound())
        }, DONE_DELAY_MS)
        timers.done.set(sessionId, t)
      }

      useEffect(() => {
        // 自检口：证明监视器真的在读状态表（headless 断言用）
        engine.statusSize = statuses ? statuses.size : -1
        const prev = prevRef.current
        prevRef.current = statuses
        // 首帧只立基线：不给历史状态补响
        if (!prev || !statuses) return

        for (const [sessionId, st] of statuses) {
          const before = prev.get(sessionId)
          if (!before) continue

          // ① 回复结束：running true → false（子代理/子会话不响）
          if (before.running === true && st.running === false) {
            const row = sessions && sessions.byId ? sessions.byId[sessionId] : undefined
            if (!row || row.origin !== 'subagent') scheduleDone(sessionId)
          }

          // ② 提问：pendingInteraction 出现新 key
          const pend = st.pendingInteraction
          const beforePend = before.pendingInteraction
          if (pend && pend.kind === 'question' && (!beforePend || beforePend.key !== pend.key)) {
            const seen = timersRef.current.ask.get(sessionId)
            if (seen !== pend.key) {
              timersRef.current.ask.set(sessionId, pend.key)
              play(getAskSound())
            }
          }
        }
      }, [statuses, sessions])

      useEffect(() => {
        const timers = timersRef.current
        return () => {
          for (const t of timers.done.values()) window.clearTimeout(t)
          timers.done.clear()
        }
      }, [])

      return null
    }

    // ───────────────────────── 设置页 ─────────────────────────
    const CSS = [
      '.dsh-sfx{display:flex;flex-direction:column;gap:18px;padding-top:2px;max-width:560px;box-sizing:border-box}',
      '.dsh-sfx-title{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}',
      '.dsh-sfx-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.7}',
      '.dsh-sfx-group{display:flex;flex-direction:column;gap:9px}',
      '.dsh-sfx-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}',
      '.dsh-sfx-grid{display:flex;flex-wrap:wrap;gap:8px}',
      '.dsh-sfx-chip{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);padding:6px 15px;font-family:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:border-color .12s,background-color .12s,color .12s}',
      '.dsh-sfx-chip:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsh-sfx-chip:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}',
      '.dsh-sfx-chip.is-on{border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 80%, var(--dsw-alias-label-primary));font-weight:600}',
      '.dsh-sfx-vol{display:flex;align-items:center;gap:12px}',
      '.dsh-sfx-vol input{flex:1;min-width:0;height:20px;margin:0;accent-color:var(--dsw-alias-state-success-primary);cursor:pointer}',
      '.dsh-sfx-volv{min-width:44px;text-align:right;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-size:13px}',
      '.dsh-sfx-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.7}',
      '.dsh-sfx-bg{display:flex;flex-direction:column;gap:9px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:16px}',
      '.dsh-sfx-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
      '.dsh-sfx-switch{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);padding:6px 15px;font-family:inherit;font-size:13px;line-height:20px;cursor:pointer}',
      '.dsh-sfx-switch.is-on{border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 80%, var(--dsw-alias-label-primary));font-weight:600}',
      '.dsh-sfx-state{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}',
    ].join('')

    function SfxChips(props) {
      return h(
        'div',
        { className: 'dsh-sfx-grid', role: 'group' },
        CHIPS.map((s) =>
          h(
            'button',
            {
              key: s.id,
              type: 'button',
              className: 'dsh-sfx-chip' + (s.id === props.value ? ' is-on' : ''),
              'aria-pressed': s.id === props.value,
              onClick: () => {
                props.onChange(s.id)
                if (s.id !== 'none') play(s.id)
              },
            },
            s.label,
          ),
        ),
      )
    }

    function SfxSettings() {
      const [vol, setVol] = useState(getVol)
      const [done, setDone] = useState(getDoneSound)
      const [ask, setAsk] = useState(getAskSound)
      const [keepalive, setKeepalive] = useState(keepaliveEnabled)
      const [notifyState, setNotifyState] = useState(() =>
        !('Notification' in window) ? 'unsupported' : window.Notification.permission,
      )
      const [kaLive, setKaLive] = useState(() => (kaActive() ? 'on' : 'off'))

      useEffect(() => {
        const t = window.setInterval(() => setKaLive(kaActive() ? 'on' : 'off'), 2000)
        return () => window.clearInterval(t)
      }, [])

      function changeVol(raw) {
        const n = Math.max(0, Math.min(100, Math.round(Number(raw) || 0)))
        writePref(KEY_VOL, n)
        setVol(n)
      }

      function changeDone(id) {
        writePref(KEY_DONE, id)
        setDone(id)
      }

      function changeAsk(id) {
        writePref(KEY_ASK, id)
        setAsk(id)
      }

      function toggleKeepalive() {
        const next = !keepalive
        writePref(KEY_KA, next ? '1' : '0')
        setKeepalive(next)
        if (next) {
          ensureAudio()
          kaStart()
        } else kaStop()
      }

      function clickNotify() {
        askNotification().then((ok) => {
          setNotifyState(!('Notification' in window) ? 'unsupported' : window.Notification.permission)
          if (ok) notifyAlert('DJH · 通知已开启', '锁屏/后台时任务完成会先用系统通知提醒你')
        })
      }

      const notifyLabel =
        notifyState === 'granted'
          ? '系统通知：已开启 ✓'
          : notifyState === 'denied'
            ? '系统通知：被浏览器拒绝（去浏览器设置允许）'
            : notifyState === 'unsupported'
              ? '系统通知：此浏览器不支持'
              : '开启系统通知（锁屏兜底提醒）'

      return h(
        'div',
        { className: 'dsh-sfx' },
        h('style', { 'data-dsh-sfx': '' }, CSS),
        h('h2', { className: 'dsh-sfx-title' }, '音效'),
        h(
          'p',
          { className: 'dsh-sfx-desc' },
          '大管家每回复完一轮、或来向你提问时，各响一声提示音。声音由本机 WebAudio 实时合成（不经 TTS 供应商），点音色即试听并选中，更改即时保存。',
        ),
        h(
          'div',
          { className: 'dsh-sfx-group' },
          h('div', { className: 'dsh-sfx-label' }, '音量'),
          h(
            'div',
            { className: 'dsh-sfx-vol' },
            h('input', {
              type: 'range',
              min: 0,
              max: 100,
              step: 5,
              value: vol,
              'aria-label': '音效音量',
              onChange: (event) => changeVol(event.target.value),
              onPointerUp: () => play(getDoneSound()),
              onKeyUp: () => play(getDoneSound()),
            }),
            h('span', { className: 'dsh-sfx-volv' }, vol + '%'),
          ),
        ),
        h(
          'div',
          { className: 'dsh-sfx-group' },
          h('div', { className: 'dsh-sfx-label' }, '大管家回复结束提示音'),
          h(SfxChips, { value: done, onChange: changeDone }),
        ),
        h(
          'div',
          { className: 'dsh-sfx-group' },
          h('div', { className: 'dsh-sfx-label' }, '向我提问提示音'),
          h(SfxChips, { value: ask, onChange: changeAsk }),
        ),
        h(
          'div',
          { className: 'dsh-sfx-bg' },
          h('div', { className: 'dsh-sfx-label' }, '锁屏 / 后台'),
          h(
            'p',
            { className: 'dsh-sfx-note' },
            '手机息屏或切到别的 App 后，网页默认会被系统挂起——状态收不到、声音也出不来。开着「后台保活」时，本页会挂一条近乎无声的循环音轨、并在锁屏媒体卡片上显示「DSH 待命中」，这样任务完成时提示音才能在息屏后照响。',
          ),
          h(
            'div',
            { className: 'dsh-sfx-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-sfx-switch' + (keepalive ? ' is-on' : ''),
                'aria-pressed': keepalive,
                onClick: toggleKeepalive,
              },
              keepalive ? '后台保活：开' : '后台保活：关',
            ),
            h('span', { className: 'dsh-sfx-state' }, '当前音轨：' + (kaLive === 'on' ? '在播 ✓' : '未播（点一下页面即启动）')),
          ),
          h(
            'div',
            { className: 'dsh-sfx-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-sfx-switch' + (notifyState === 'granted' ? ' is-on' : ''),
                onClick: clickNotify,
                disabled: notifyState === 'unsupported' || notifyState === 'denied',
              },
              notifyLabel,
            ),
          ),
          h(
            'p',
            { className: 'dsh-sfx-note' },
            '诚实边界：网页做不到「凭空唤醒手机」。系统省电杀掉浏览器、从最近任务里划掉、深度省电断网时，息屏期间收不到；解锁回来看页面会在 60s 内补响一声。',
          ),
        ),
        h(
          'p',
          { className: 'dsh-sfx-note' },
          vol <= 0
            ? '音量为 0：现在不会发声。'
            : '听不到时：确认设备没静音、这个浏览器标签页没被静音。网页音频需要你先点一下页面才会被允许发声。',
        ),
      )
    }

    function SfxIcon(props) {
      const size = props && props.size ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M6.1 12.1V4.5l5.6-1.2v7.4',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 4.8, cy: 12.2, r: 1.6, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('circle', { cx: 10.4, cy: 10.8, r: 1.6, stroke: 'currentColor', strokeWidth: 1.3 }),
      )
    }

    // ───────────────────────── 落位 ─────────────────────────
    return {
      inject: ['slots'],
      apply(ctx) {
        /** 浏览器自动播放策略：第一次点击/按键时把 AudioContext 解锁，顺带补播挂起的那声。 */
        ctx.effect(() => {
          const kick = () => {
            ensureAudio()
            kaStart()
          }
          const onVisible = () => {
            if (!document.hidden) {
              ensureAudio()
              kaStart()
            }
          }
          const opts = { capture: true, passive: true }
          document.addEventListener('pointerdown', kick, opts)
          document.addEventListener('keydown', kick, opts)
          document.addEventListener('touchend', kick, opts)
          document.addEventListener('visibilitychange', onVisible)
          // 保活看门狗 + 启动时先试一次（无手势时会被浏览器拒，失败无副作用）
          KA.watchT = window.setInterval(kaWatchTick, 20000)
          const bootT = window.setTimeout(() => {
            kaStart()
            ensureServiceWorker()
          }, 1200)
          return () => {
            window.clearTimeout(bootT)
            if (KA.watchT) {
              window.clearInterval(KA.watchT)
              KA.watchT = null
            }
            kaStop()
            document.removeEventListener('pointerdown', kick, opts)
            document.removeEventListener('keydown', kick, opts)
            document.removeEventListener('touchend', kick, opts)
            document.removeEventListener('visibilitychange', onVisible)
            try {
              if (KA.el && KA.el.parentNode) KA.el.parentNode.removeChild(KA.el)
            } catch (e) {}
            KA.el = null
          }
        })

        // 触发口：无渲染组件，只订阅状态跳变（kit 必须原样转发，会话状态钩子在里面）
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'sfx-monitor', order: 7 }, (kit) =>
            h(SfxMonitor, kit),
          ),
        )

        // 设置 → 音效
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'sfx', order: 5, label: () => '音效' },
            SfxSettings,
          ),
        )
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register({ name: 'settings.section.icon', id: 'sfx', order: 5 }, SfxIcon),
        )

        // 自检口（headless/UI 断言用，不占界面）
        ctx.effect(() => {
          window.__dshSfx = {
            state: () => ({
              audio: engine.ctx ? engine.ctx.state : 'none',
              vol: getVol(),
              done: getDoneSound(),
              ask: getAskSound(),
              last: engine.last,
              count: engine.count,
              history: engine.history.slice(),
              statusSize: engine.statusSize,
              hidden: document.hidden,
              keepalive: keepaliveEnabled(),
              kaActive: kaActive(),
              kaState: KA.el ? KA.el.state : 'none',
              kaWavs: Object.keys(KA.wav),
              mediaSession: ('mediaSession' in navigator && navigator.mediaSession.metadata)
                ? {
                    title: navigator.mediaSession.metadata.title,
                    artwork: (navigator.mediaSession.metadata.artwork || []).length,
                  }
                : null,
              sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
              notify: 'Notification' in window ? window.Notification.permission : 'unsupported',
            }),
            play: (id) => play(id || getDoneSound()),
            testDone: () => {
              play(getDoneSound())
              return engine.last
            },
            testAsk: () => {
              play(getAskSound())
              return engine.last
            },
            kaStart,
            kaStop,
            askNotify: () => askNotification(),
            notifyAlert,
          }
          return () => {
            delete window.__dshSfx
          }
        })
      },
    }
  },
})
