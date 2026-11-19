/**
 * @local/dsh-butler-mode（Client 半）
 *
 * 2026-11-18 第二版：按主人要求**撤掉左栏「⭐ 大管家 / ＋ 新任务」两个按钮**
 * ——主人只跟大管家说话，入口就是「带 ⭐ 的那条会话」，不用再开新会话的按钮。
 *
 * 现在只做一件事：
 *   - 大管家会话在左栏行尾显示 ⭐ 徽章（sidebar.session.row.trailing 官方槽）。
 *   - 判定名单存 localStorage['dsh-butler-mode:butlers']（session id 数组）。
 *   - 对外小接口 window.__dshButlerMode：mark(id)/unmark(id)/list()，方便人工标注。
 *
 * 规矩：不再向页面注入任何工具条/DOM，避免装饰品。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-butler-mode',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STORE_KEY = 'dsh-butler-mode:butlers'
    const ORB_STORE_KEY = 'dsh-butler-mode:orbs' // 星闪球专属会话（青蓝色球，区别于大管家紫球）
    const EVT = 'dsh-butler-mode:change'

    function bare(id) {
      // 2026-11-18 修：id 有 "session:<id>"、"session-<uuid>"、裸 UUID 三种形状（换脑新会话行是
      // session:session-<uuid> 双前缀），统一剥干净再比对，否则徽章时有时无。
      return String(id || '').replace(/^session:/, '').replace(/^session-/, '')
    }

    function loadSet(key) {
      try {
        const raw = JSON.parse(localStorage.getItem(key) || '[]')
        return raw instanceof Array ? new Set(raw.filter((x) => typeof x === 'string')) : new Set()
      } catch {
        return new Set()
      }
    }

    function saveSet(key, set) {
      localStorage.setItem(key, JSON.stringify([...set]))
      window.dispatchEvent(new CustomEvent(EVT))
    }

    function markButler(id) {
      const b = bare(id)
      if (!b) return
      const set = loadSet(STORE_KEY)
      if (set.has(b)) return
      set.add(b)
      saveSet(STORE_KEY, set)
    }

    function unmarkButler(id) {
      const b = bare(id)
      const set = loadSet(STORE_KEY)
      if (!set.has(b)) return
      set.delete(b)
      saveSet(STORE_KEY, set)
    }

    function markOrb(id) {
      const b = bare(id)
      if (!b) return
      const set = loadSet(ORB_STORE_KEY)
      if (!set.has(b)) {
        set.add(b)
        saveSet(ORB_STORE_KEY, set)
      }
      // 星闪球会话不再是大管家
      const butlers = loadSet(STORE_KEY)
      if (butlers.has(b)) {
        butlers.delete(b)
        saveSet(STORE_KEY, butlers)
      }
    }

    /* ────────── 行尾徽章（官方槽）：🟣大管家 / 🔵星闪球 两个圆形球 ────────── */
    const ORB_STYLE_ID = 'dsh-butler-orb-style'
    function ensureOrbStyle() {
      // 幂等注入（教训40）：先删后插，HMR 重跑不叠加
      document.querySelectorAll(`style#${ORB_STYLE_ID}`).forEach((el) => el.remove())
      const style = document.createElement('style')
      style.id = ORB_STYLE_ID
      style.textContent =
        '@keyframes dshButlerOrbPulse{0%,100%{box-shadow:0 0 4px rgba(170,120,255,.45),0 0 10px rgba(170,120,255,.25)}' +
        '50%{box-shadow:0 0 7px rgba(190,150,255,.85),0 0 16px rgba(170,120,255,.5)}}' +
        '[data-butler-orb],[data-orb-ball]{animation:dshButlerOrbPulse 2.4s ease-in-out infinite}' +
        '@keyframes dshOrbBallPulse{0%,100%{box-shadow:0 0 4px rgba(60,200,255,.45),0 0 10px rgba(60,200,255,.25)}' +
        '50%{box-shadow:0 0 7px rgba(120,230,255,.85),0 0 16px rgba(60,200,255,.5)}}' +
        '[data-orb-ball]{animation:dshOrbBallPulse 2.4s ease-in-out infinite}'
      document.head.appendChild(style)
    }
    /** kind: 'butler'（紫球✦） | 'ball'（青蓝球⚡，星闪球专属会话） */
    function OrbBadge({ sessionId }) {
      const [role, setRole] = React.useState(() =>
        loadSet(STORE_KEY).has(bare(sessionId)) ? 'butler' : loadSet(ORB_STORE_KEY).has(bare(sessionId)) ? 'ball' : '',
      )
      React.useEffect(() => {
        const fn = () =>
          setRole(
            loadSet(STORE_KEY).has(bare(sessionId))
              ? 'butler'
              : loadSet(ORB_STORE_KEY).has(bare(sessionId))
                ? 'ball'
                : '',
          )
        window.addEventListener(EVT, fn)
        window.addEventListener('storage', fn)
        return () => {
          window.removeEventListener(EVT, fn)
          window.removeEventListener('storage', fn)
        }
      }, [sessionId])
      React.useEffect(() => {
        if (role) ensureOrbStyle()
      }, [role])
      if (!role) return null
      const isBall = role === 'ball'
      return h(
        'span',
        {
          'data-butler-star': isBall ? undefined : '1',
          'data-orb-ball': isBall ? '1' : undefined,
          title: isBall
            ? '星闪球 · 专属对话页（快模型陪聊，大管家页面的语音/文字前台）'
            : '星闪球大管家 · 派单总入口（只跟主人对话，活儿派给子代理）',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
            width: 16,
            height: 16,
            marginLeft: 2,
            borderRadius: '50%',
            fontSize: 10,
            lineHeight: 1,
            fontWeight: 700,
            color: '#fff',
            background: isBall
              ? 'radial-gradient(circle at 30% 28%, #c8f2ff 0%, #38c6ff 42%, #0d7fd4 100%)'
              : 'radial-gradient(circle at 30% 28%, #e3ccff 0%, #a86bff 42%, #6a2bd9 100%)',
            border: '1px solid rgba(255,255,255,.35)',
            cursor: 'default',
            userSelect: 'none',
          },
        },
        isBall ? '⚡' : '✦',
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.session.row.trailing', () =>
          ctx.slots.register(
            { name: 'sidebar.session.row.trailing', id: 'butler-star', order: 1 },
            OrbBadge,
          ),
        )
        window.__dshButlerMode = {
          mark: markButler,
          unmark: unmarkButler,
          list: () => [...loadSet(STORE_KEY)],
          orbMark: markOrb,
          orbUnmark: (id) => {
            const set = loadSet(ORB_STORE_KEY)
            set.delete(bare(id))
            saveSet(ORB_STORE_KEY, set)
          },
          orbList: () => [...loadSet(ORB_STORE_KEY)],
        }
        // 自动登记：宿主桥 /state 报上来的星闪球会话 id → 打青蓝球徽章（幂等）
        const poll = setInterval(() => {
          fetch('http://127.0.0.1:9780/state', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((s) => {
              if (s && s.orb) {
                const b = bare(s.orb)
                if (b && !loadSet(ORB_STORE_KEY).has(b)) markOrb(b)
              }
              // 换脑自动认领：桥 /state 报的 butler id（换脑切桥后新会话没⭐，2026-11-18 修）
              if (s && s.butler) {
                const b = bare(s.butler)
                if (b && !loadSet(STORE_KEY).has(b)) markButler(b)
              }
            })
            .catch(() => {})
        }, 5000)
        ctx.effect(() => () => {
          delete window.__dshButlerMode
          clearInterval(poll)
        }, 'butler-mode: api')
      },
    }
  },
})
