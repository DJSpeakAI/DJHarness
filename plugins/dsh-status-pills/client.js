/**
 * 状态胶囊（Client 半）—— 从 little DJ 右上角常驻胶囊移植：
 *
 *   [内存 13.3G / 32G]  [余额块：DeepSeek ￥192.38 / GLM 5h 14% / GLM 周 22%（纵向，手机折 2 行）]  [积分板]
 *
 * 余额块是**纵向多行**的：以后各家 API 的余额都往 `balanceRows()` 里加一行即可（2026-11-18 主人要求）。
 *
 * 位置：会话页进标题栏右上角那一排（`conversation.session.header.utilities`，
 *       排在设置齿轮左边）；新任务页没有标题栏，用 `shell.overlay` 浮在右上角。
 *       ⚠️ 悬浮那份不是写死坐标：它每次布局变化都会量「右上角控件簇」，把胶囊塞到那排按钮
 *         左边（插件页的「刷新 / 添加插件」、自动化任务的「新建」、设置弹窗的「打开配置文件」…），
 *         永远不跟按钮重叠 —— 见下面 `planDock()` 的注释。
 * 交互：**鼠标移入胶囊就弹面板**（不是点击才弹）；移开 1s 后自动收，期间移回胶囊
 *       或面板就取消；点面板外面立即关。面板的**四边 + 四角都能拖拽改大小**，
 *       尺寸记进 localStorage，下次打开沿用。内容：内存构成（总/已用/可用）+
 *       进程列表（按内存排序、两步确认可「关闭」）。
 * 数据：`/status-pills-api/state` 10s 轮询，
 *       `/status-pills-api/procs` 面板打开时 10s 轮询，`/status-pills-api/kill` 关进程。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-status-pills',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef

    // ────────────────── 共享轮询 store（两处挂载只发一份请求） ──────────────────
    const store = { state: null, subs: new Set(), timer: null }

    function notify() {
      for (const fn of store.subs) fn(store.state)
    }

    async function loadOnce() {
      try {
        const res = await fetch('/status-pills-api/state', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          credentials: 'same-origin',
        })
        if (!res.ok) return
        const body = await res.json()
        if (body && body.ok && body.value) {
          store.state = body.value
          notify()
        }
      } catch {
        /* 失败保旧值：界面继续显示上一次的数字 */
      }
    }

    function ensureStore() {
      if (store.timer) return
      void loadOnce()
      store.timer = window.setInterval(() => {
        if (!document.hidden) void loadOnce()
      }, 10000)
    }

    function useStatus() {
      const [state, setState] = useState(store.state)
      useEffect(() => {
        ensureStore()
        const fn = (next) => setState(next)
        store.subs.add(fn)
        if (store.state) setState(store.state)
        return () => {
          store.subs.delete(fn)
        }
      }, [])
      return state
    }

    // ────────────────── RunningHub 积分 store（国内站 cn + 海外站 intl） ──────────────────
    // 独立轮询：15s 一次；claim 后强制刷新。
    const rhStores = { cn: { state: null, subs: new Set() }, intl: { state: null, subs: new Set() } }
    let rhTimer = null

    function rhNotify(site) {
      const s = rhStores[site]
      for (const fn of s.subs) fn(s.state)
    }

    async function rhLoad(site, force) {
      try {
        const res = await fetch('/status-pills-api/' + (site === 'cn' ? 'rh' : 'rh-intl'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: !!force }),
          credentials: 'same-origin',
        })
        if (!res.ok) return
        const body = await res.json()
        if (body && body.ok && body.value) {
          rhStores[site].state = body.value
          rhNotify(site)
        }
      } catch {
        /* 失败保旧值 */
      }
    }

    function ensureRh() {
      if (rhTimer) return
      void rhLoad('cn', false)
      void rhLoad('intl', false)
      rhTimer = window.setInterval(() => {
        if (document.hidden) return
        void rhLoad('cn', false)
        void rhLoad('intl', false)
      }, 15000)
    }

    function useRh(site) {
      const [state, setState] = useState(rhStores[site].state)
      useEffect(() => {
        ensureRh()
        const fn = (next) => setState(next)
        rhStores[site].subs.add(fn)
        if (rhStores[site].state) setState(rhStores[site].state)
        return () => {
          rhStores[site].subs.delete(fn)
        }
      }, [site])
      return state
    }

    // ────────────────── BreezeBlue 积分 store（双账号：gmail + qq） ──────────────────
    // 普通只读 HTTP 查询：60s 轮询，两账号各自一份状态。
    const bzStores = { gmail: { state: null, subs: new Set() }, qq: { state: null, subs: new Set() } }
    let bzTimer = null

    function bzNotify(account) {
      for (const fn of bzStores[account].subs) fn(bzStores[account].state)
    }

    async function bzLoad(account, force) {
      try {
        const res = await fetch('/status-pills-api/breeze', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ account, force: !!force }),
          credentials: 'same-origin',
        })
        if (!res.ok) return
        const body = await res.json()
        if (body && body.ok && body.value) {
          bzStores[account].state = body.value
          bzNotify(account)
        }
      } catch {
        /* 失败保旧值 */
      }
    }

    function ensureBz() {
      if (bzTimer) return
      void bzLoad('gmail', false)
      void bzLoad('qq', false)
      bzTimer = window.setInterval(() => {
        if (document.hidden) return
        void bzLoad('gmail', false)
        void bzLoad('qq', false)
      }, 60000)
    }

    function useBz(account) {
      const [state, setState] = useState(bzStores[account].state)
      useEffect(() => {
        ensureBz()
        const fn = (next) => setState(next)
        bzStores[account].subs.add(fn)
        if (bzStores[account].state) setState(bzStores[account].state)
        return () => {
          bzStores[account].subs.delete(fn)
        }
      }, [account])
      return state
    }

    // ────────────────── 魔搭 ModelScope 魔粒 store（读 claim.mjs 的 status.json，60s 轮询） ──────────────────
    const msStore = { state: null, subs: new Set(), timer: null }

    function msNotify() {
      for (const fn of msStore.subs) fn(msStore.state)
    }

    async function msLoad(force) {
      try {
        const res = await fetch('/status-pills-api/ms', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: !!force }),
          credentials: 'same-origin',
        })
        if (!res.ok) return
        const body = await res.json()
        if (body && body.ok && body.value) {
          msStore.state = body.value
          msNotify()
        }
      } catch {
        /* 失败保旧值 */
      }
    }

    function ensureMs() {
      if (msStore.timer) return
      void msLoad(false)
      msStore.timer = window.setInterval(() => {
        if (document.hidden) return
        void msLoad(false)
      }, 60000)
    }

    function useMs() {
      const [state, setState] = useState(msStore.state)
      useEffect(() => {
        ensureMs()
        const fn = (next) => setState(next)
        msStore.subs.add(fn)
        if (msStore.state) setState(msStore.state)
        return () => {
          msStore.subs.delete(fn)
        }
      }, [])
      return state
    }

    // ────────────────── WorkBuddy 积分 store ──────────────────
    // signin.py 每次要起解密子进程，别频繁：5 分钟轮询一次。
    const wbStore = { state: null, subs: new Set(), timer: null, loading: false }

    function wbNotify() {
      for (const fn of wbStore.subs) fn(wbStore.state)
    }

    async function wbLoad(force) {
      if (wbStore.loading) return
      wbStore.loading = true
      try {
        const res = await fetch('/status-pills-api/wb', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: !!force }),
          credentials: 'same-origin',
        })
        if (!res.ok) return
        const body = await res.json()
        if (body && body.ok && body.value) {
          wbStore.state = body.value
          wbNotify()
        }
      } catch {
        /* 失败保旧值 */
      } finally {
        wbStore.loading = false
      }
    }

    function ensureWb() {
      if (wbStore.timer) return
      void wbLoad(false)
      wbStore.timer = window.setInterval(() => {
        if (!document.hidden) void wbLoad(false)
      }, 300000)
    }

    function useWb() {
      const [state, setState] = useState(wbStore.state)
      useEffect(() => {
        ensureWb()
        const fn = (next) => setState(next)
        wbStore.subs.add(fn)
        if (wbStore.state) setState(wbStore.state)
        return () => {
          wbStore.subs.delete(fn)
        }
      }, [])
      return state
    }

    // ────────────────── 格式化 ──────────────────
    function pct(v) {
      const n = Number(v)
      if (v == null || !Number.isFinite(n)) return '—'
      return Math.round(Math.max(0, Math.min(100, n)) * 10) / 10 + '%'
    }

    function mbToG(mb, digits) {
      const n = Number(mb) || 0
      return (n / 1024).toFixed(digits == null ? 1 : digits) + 'G'
    }

    function usedText(mem) {
      if (!mem || !mem.totalMB) return '—'
      return mbToG(mem.usedMB) + ' / ' + Math.round(mem.totalMB / 1024) + 'G'
    }

    // ── 手机端（窄屏）的短文案：「内存 12.7G / 32G」→「内存 12.7G/32G」 ──
    function usedTextShort(mem) {
      if (!mem || !mem.totalMB) return '—'
      return mbToG(mem.usedMB) + '/' + Math.round(mem.totalMB / 1024) + 'G'
    }

    // ────────────────── 余额块（纵向多行） ──────────────────
    // 主人 2026-11-18：「额度」改「余额」、**纵向排列**——以后各家 API 的余额都往下加一行
    //（横向一排放不下）；鼠标移上去（原生 tooltip）显示每行的完整说明（重置时间 / 来源 / 为什么没有）。
    // 加新余额：在 balanceRows() 里 push 一行即可，UI 自动多一行。
    function fmtReset(ms) {
      const t = Number(ms)
      if (!t) return ''
      try {
        const d = new Date(t)
        const now = new Date()
        const sameDay = d.toDateString() === now.toDateString()
        return new Intl.DateTimeFormat('zh-CN', sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d)
      } catch {
        return ''
      }
    }

    function balanceRows(state) {
      const ds = state && state.ds
      const glm = state && state.glm
      const rows = []
      // ① DeepSeek 官方账户余额（真钱，实时）
      rows.push({
        key: 'ds',
        label: 'DeepSeek',
        short: 'DS',
        value: ds && ds.ok ? ds.text : '—',
        hint: ds && ds.ok ? 'DeepSeek 官方账户余额（实时）' : 'DeepSeek 余额取不到' + (ds && ds.error ? '：' + ds.error : ''),
      })
      // ② GLM Coding 两档额度（百分比 = 已用）
      if (glm && glm.ok && glm.fiveHour) {
        rows.push({
          key: 'glm5h',
          label: 'GLM 5h',
          short: '5h',
          value: pct(glm.fiveHour.percentage),
          hint:
            'GLM Coding 5 小时档 · 已用 ' + pct(glm.fiveHour.percentage) +
            (fmtReset(glm.fiveHour.resetAt) ? ' · ' + fmtReset(glm.fiveHour.resetAt) + ' 重置' : ''),
        })
      }
      if (glm && glm.ok && glm.week) {
        rows.push({
          key: 'glmweek',
          label: 'GLM 周',
          short: '周',
          value: pct(glm.week.percentage),
          hint:
            'GLM Coding 一周档 · 已用 ' + pct(glm.week.percentage) +
            (fmtReset(glm.week.resetAt) ? ' · ' + fmtReset(glm.week.resetAt) + ' 重置' : ''),
        })
      }
      // ③ 四家云账户余额（火山/腾讯/阿里/华为，AK/SK 走计费 OpenAPI，host 10min 缓存）——
      //    2026-11-18 主人给了四对密钥（DPAPI 加密存 apps/cloud-balance/secrets）。
      const CLOUD_LABELS = { volc: '火山', tencent: '腾讯云', aliyun: '阿里云', huawei: '华为云' }
      const cloud = state && state.cloud
      if (cloud && cloud.accounts) {
        for (const [id, label] of Object.entries(CLOUD_LABELS)) {
          const a = cloud.accounts[id]
          if (!a) continue
          rows.push({
            key: 'cloud-' + id,
            label: label,
            short: label,
            value: a.ok ? '¥' + (a.balance != null ? a.balance.toFixed(2) : '—') : '—',
            hint: a.ok ? label + '账户可用余额（' + (a.currency || 'CNY') + '，10 分钟刷新）' : label + '余额取不到' + (a.error ? '：' + a.error : ''),
          })
        }
      }
      // ④ OpenRouter 余额（USD；host 读 /api/v1/key 的 limit_remaining，60s 缓存，失败保旧值）
      const orBal = state && state.or
      if (orBal) {
        rows.push({
          key: 'or',
          label: 'OpenRouter',
          short: 'OR',
          value: orBal.ok ? orBal.text : '—',
          hint: orBal.ok
            ? 'OpenRouter 账户余额（USD，60 秒刷新）' + (orBal.usage != null ? ' · 累计已用 $' + Number(orBal.usage).toFixed(2) : '')
            : 'OpenRouter 余额取不到' + (orBal.error ? '：' + orBal.error : ''),
        })
      }
      return rows
    }

    // 纵向余额块：每行「名称 …… 值」，悬停 tooltip 出完整说明。
    // 高度按行数自适应（4 行桌面 ≈ 56px），窄屏字号小一号。
    function BalanceBlock({ state, compact }) {
      const rows = balanceRows(state)
      // v0.100: 手机 compact 把 4 行折回 2 行（DS 一行 + 「5h x% · 周 y%」一行），
      // 火山「—」在手机上不占行 —— 否则余额块 54px 高，390 宽下把会话顶栏撑成两行（verify-scroll 红）。
      let view = rows
      if (compact) {
        view = rows.filter((r) => r.value !== '—')
        const five = view.find((r) => r.key === 'glm5h')
        const week = view.find((r) => r.key === 'glmweek')
        if (five && week) {
          view = view
            .filter((r) => r.key !== 'glmweek')
            .map((r) =>
              r.key === 'glm5h'
                ? { ...r, short: '5h/周', value: five.value + '/' + week.value }
                : r,
            )
        }
        // 四家云余额手机端折成一行合计（都是人民币真钱，求和有意义；避免余额块 8 行撑爆窄屏）
        const cloudRows = view.filter((r) => r.key.indexOf('cloud-') === 0)
        if (cloudRows.length) {
          const sum = cloudRows.reduce((n, r) => n + Number(String(r.value).replace(/[^\d.]/g, '') || 0), 0)
          view = view.filter((r) => r.key.indexOf('cloud-') !== 0)
          view.push({ key: 'cloud-sum', label: '云', short: '云', value: '¥' + sum.toFixed(2), hint: cloudRows.map((r) => r.label + ' ' + r.value).join(' · ') })
        }
      }
      return h(
        'div',
        {
          'data-balance-block': '1',
          title: rows.map((r) => r.label + '  ' + r.value + '\n' + r.hint).join('\n\n'),
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: compact ? 0 : 1,
            padding: compact ? '2px 7px' : '3px 9px',
            borderRadius: 9,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: compact ? 9.5 : 10.5,
            lineHeight: compact ? '12px' : '13px',
            whiteSpace: 'nowrap',
            cursor: 'default',
            userSelect: 'none',
          },
        },
        view.map((r) =>
          h(
            'div',
            {
              key: r.key,
              style: {
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: compact ? 5 : 8,
                opacity: r.value === '—' ? 0.55 : 1,
              },
            },
            h('span', { style: { opacity: 0.85 } }, compact ? r.short : r.label),
            h(
              'b',
              {
                style: {
                  fontWeight: 600,
                  color: 'var(--dsw-alias-label-primary)',
                  fontVariantNumeric: 'tabular-nums',
                },
              },
              r.value,
            ),
          ),
        ),
      )
    }

    // ────────────────── 胶囊 ──────────────────
    const PILL = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: 24,
      padding: '0 9px',
      borderRadius: 99,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 11,
      lineHeight: '1',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      userSelect: 'none',
      letterSpacing: 0.2,
    }

    // 窄屏（手机）用的一档：矮 2px、字号小半号、左右留白少 2px
    const PILL_COMPACT = {
      height: 22,
      padding: '0 7px',
      fontSize: 10,
      letterSpacing: 0,
    }

    function Pill({ text, title, onClick, onMouseEnter, onMouseLeave, compact }) {
      const [hover, setHover] = useState(false)
      return h(
        'span',
        {
          title,
          role: onClick ? 'button' : undefined,
          onClick,
          onMouseEnter: () => {
            setHover(true)
            if (onMouseEnter) onMouseEnter()
          },
          onMouseLeave: () => {
            setHover(false)
            if (onMouseLeave) onMouseLeave()
          },
          style: {
            ...PILL,
            ...(compact ? PILL_COMPACT : null),
            cursor: onClick ? 'pointer' : 'default',
            background: hover ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
            color: hover ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
          },
        },
        text,
      )
    }

    // ────────────────── 面板 ──────────────────
    // 悬停展开：鼠标进胶囊就开，移开 1s 后自动收（期间移回胶囊/面板就取消），点外面立即关。
    // 面板四边 + 四角可拖拽改大小，尺寸记进 localStorage。
    const SIZE_KEY = 'dsh-status-pills:panel-size'
    const DEFAULT_W = 330
    const MIN_W = 260
    const MIN_H = 180

    function readSavedSize() {
      try {
        const raw = window.localStorage.getItem(SIZE_KEY)
        if (!raw) return null
        const v = JSON.parse(raw)
        if (v && Number.isFinite(v.w) && Number.isFinite(v.h) && v.w >= MIN_W && v.h >= MIN_H) {
          return { w: v.w, h: v.h }
        }
      } catch {
        /* localStorage 不可用时当没记过 */
      }
      return null
    }

    function saveSize(w, h) {
      try {
        window.localStorage.setItem(SIZE_KEY, JSON.stringify({ w: Math.round(w), h: Math.round(h) }))
      } catch {
        /* 存不了就下次重来 */
      }
    }

    // 积分板面板的尺寸（和内存面板分开记）
    const SCORE_SIZE_KEY = 'dsh-status-pills:score-panel-size'

    function readScoreSize() {
      try {
        const raw = window.localStorage.getItem(SCORE_SIZE_KEY)
        if (!raw) return null
        const v = JSON.parse(raw)
        if (v && Number.isFinite(v.w) && Number.isFinite(v.h) && v.w >= MIN_W && v.h >= MIN_H) {
          return { w: v.w, h: v.h }
        }
      } catch {}
      return null
    }

    function saveScoreSize(w, h) {
      try {
        window.localStorage.setItem(SCORE_SIZE_KEY, JSON.stringify({ w: Math.round(w), h: Math.round(h) }))
      } catch {}
    }

    const panelOuter = {
      position: 'fixed',
      zIndex: 10000,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 12,
      boxShadow: '0 10px 32px rgba(0,0,0,.38)',
      overflow: 'hidden',
    }

    const panelInner = {
      flex: '1 1 auto',
      minHeight: 0,
      overflowY: 'auto',
      padding: '10px 12px',
      fontSize: 11.5,
      color: 'var(--dsw-alias-label-secondary)',
    }

    const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
    const EDGE = 6
    const CORNER = 14

    function handleStyle(dir) {
      const s = { position: 'absolute', zIndex: 2, touchAction: 'none' }
      const top = dir.indexOf('n') >= 0
      const bottom = dir.indexOf('s') >= 0
      const left = dir.indexOf('w') >= 0
      const right = dir.indexOf('e') >= 0
      if (top || bottom) {
        if (left || right) {
          s.width = CORNER
          s.height = CORNER
          s[left ? 'left' : 'right'] = 0
          s[top ? 'top' : 'bottom'] = 0
        } else {
          s.left = CORNER
          s.right = CORNER
          s.height = EDGE
          s[top ? 'top' : 'bottom'] = 0
        }
      } else if (left || right) {
        s.top = CORNER
        s.bottom = CORNER
        s.width = EDGE
        s[left ? 'left' : 'right'] = 0
      }
      s.cursor =
        top || bottom
          ? left || right
            ? top === right || bottom === left
              ? 'nesw-resize'
              : 'nwse-resize'
            : 'ns-resize'
          : 'ew-resize'
      if (dir === 'se') {
        s.background = 'linear-gradient(135deg, transparent 0 52%, var(--dsw-alias-border-l2) 52% 74%, transparent 74%)'
        s.opacity = 0.85
      }
      return s
    }

    const h4Style = {
      fontSize: 10.5,
      fontWeight: 600,
      color: 'var(--dsw-alias-label-secondary)',
      opacity: 0.72,
      margin: '10px 0 5px',
    }

    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      minHeight: 20,
    }

    function Row({ label, value, bold }) {
      return h(
        'div',
        { style: rowStyle },
        h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
        h(
          'b',
          {
            style: {
              fontWeight: bold ? 600 : 500,
              color: 'var(--dsw-alias-label-primary)',
              flex: '0 0 auto',
            },
          },
          value,
        ),
      )
    }

    function bar(pctVal) {
      return h(
        'div',
        { style: { height: 5, borderRadius: 99, background: 'var(--dsw-alias-bg-layer-1)', overflow: 'hidden', margin: '6px 0 2px' } },
        h('div', {
          style: {
            height: '100%',
            width: Math.max(0, Math.min(100, pctVal)) + '%',
            background: 'var(--dsw-alias-brand-primary)',
            borderRadius: 99,
            transition: 'width .3s',
          },
        }),
      )
    }

    function ProcRow({ p, armed, busy, onKill }) {
      const [hover, setHover] = useState(false)
      return h(
        'div',
        {
          style: { ...rowStyle, padding: '2px 0' },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        h(
          'span',
          {
            title: p.name + ' · PID ' + p.pid,
            style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary)' },
          },
          (p.protected ? '🔒 ' : '') + p.name,
        ),
        h('span', { style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' } }, p.rssMB + 'M'),
        p.protected
          ? h(
              'button',
              {
                type: 'button',
                disabled: true,
                style: {
                  flex: '0 0 auto',
                  fontSize: 10,
                  font: 'inherit',
                  color: 'var(--dsw-alias-label-secondary)',
                  background: 'transparent',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  borderRadius: 6,
                  padding: '1px 7px',
                  opacity: 0.55,
                  cursor: 'default',
                },
              },
              '保护',
            )
          : h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => onKill(p),
                style: {
                  flex: '0 0 auto',
                  fontSize: 10,
                  font: 'inherit',
                  color: armed ? 'var(--dsw-alias-state-error-primary, #ff6b6b)' : 'var(--dsw-alias-label-secondary)',
                  background: 'transparent',
                  border: '1px solid ' + (armed ? 'var(--dsw-alias-state-error-primary, #ff6b6b)' : 'var(--dsw-alias-border-l1)'),
                  borderRadius: 6,
                  padding: '1px 7px',
                  cursor: busy ? 'default' : 'pointer',
                  opacity: busy ? 0.6 : hover || armed ? 1 : 0.9,
                },
              },
              armed ? '确认关闭?' : '关闭',
            ),
      )
    }

    // 悬停开合的手柄现在挂在「内存」胶囊 + 面板自己身上（额度胶囊不弹面板），
    // 所以面板要自己负责「移进来就取消收起、移出去就 1s 后收起」。
    function Panel({ state, rect, onClose, draggingRef, onDragEnd, onHoverEnter, onHoverLeave }) {
      const panelRef = useRef(null)
      const savedSize = useRef(readSavedSize())
      const [box, setBox] = useState(null)
      const [dragging, setDragging] = useState(false)
      const [procs, setProcs] = useState(null)
      const [procsErr, setProcsErr] = useState('')
      const [tick, setTick] = useState(0)
      const [armed, setArmed] = useState(0)
      const [busy, setBusy] = useState(0)
      const [notice, setNotice] = useState('')

      // 点外面关闭（胶囊自己的 onClick 会 stopPropagation，这里再兜一层锚点检查）
      useEffect(() => {
        const onDown = (e) => {
          const t = e.target
          if (t && t.closest && t.closest('[data-status-pills-anchor]')) return
          if (panelRef.current && !panelRef.current.contains(t)) onClose()
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [onClose])

      // 进程列表：打开时拉一次，之后 10s 刷新（页面隐藏时跳过）
      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const res = await fetch('/status-pills-api/procs', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
              credentials: 'same-origin',
            })
            const body = await res.json()
            if (!alive) return
            if (body && body.ok) {
              setProcs(body.value)
              setProcsErr('')
            } else {
              setProcsErr((body && body.error && body.error.message) || '进程列表不可用')
            }
          } catch (e) {
            if (alive) setProcsErr('进程列表取不到：' + String((e && e.message) || e))
          }
        }
        void load()
        const t = window.setInterval(() => {
          if (!document.hidden) void load()
        }, 10000)
        return () => {
          alive = false
          window.clearInterval(t)
        }
      }, [tick])

      // 两步确认：3 秒内不点第二下自动解除
      useEffect(() => {
        if (!armed) return
        const t = window.setTimeout(() => setArmed(0), 3000)
        return () => window.clearTimeout(t)
      }, [armed])

      const doKill = async (p) => {
        if (busy) return
        if (armed !== p.pid) {
          setArmed(p.pid)
          return
        }
        setArmed(0)
        setBusy(p.pid)
        setNotice('')
        try {
          const res = await fetch('/status-pills-api/kill', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pid: p.pid }),
            credentials: 'same-origin',
          })
          const body = await res.json()
          if (body && body.ok) {
            setNotice('已关闭 ' + p.name + '（PID ' + p.pid + '）')
            setTick((v) => v + 1)
          } else {
            setNotice('关闭失败：' + ((body && body.error && body.error.message) || '未知错误'))
          }
        } catch (e) {
          setNotice('关闭失败：' + String((e && e.message) || e))
        }
        setBusy(0)
      }

      // 只在面板挂载时按胶囊位置定位一次。
      // ⚠️ 不能依赖 rect：悬停时 rect 会被 mouseenter 刷新成新对象，
      //    会让拖拽改好的尺寸被反复重置回默认值（实测踩坑）。
      useEffect(() => {
        const saved = savedSize.current
        const w = saved ? saved.w : DEFAULT_W
        const r = rect || { right: Math.max(8, window.innerWidth - 16), bottom: 44 }
        const gapRight = Math.max(8, Math.round(window.innerWidth - r.right))
        const left = Math.max(8, Math.min(window.innerWidth - gapRight - w, window.innerWidth - w - 8))
        setBox({ left, top: Math.max(8, Math.round(r.bottom + 8)), w, h: saved ? saved.h : null })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      // 窗口尺寸变化时把框拉回屏内
      useEffect(() => {
        const onResize = () => {
          setBox((b) => {
            if (!b) return b
            const w = Math.min(b.w, Math.max(MIN_W, window.innerWidth - 16))
            const h = b.h == null ? null : Math.min(b.h, Math.max(MIN_H, window.innerHeight - 16))
            const left = Math.max(8, Math.min(b.left, Math.max(8, window.innerWidth - w - 8)))
            const top = Math.max(8, Math.min(b.top, Math.max(8, window.innerHeight - (h == null ? 120 : h) - 8)))
            return { left, top, w, h }
          })
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // 八向拖拽改尺寸：按住边缘/角落移动，松手把尺寸存起来
      const beginDrag = (dir) => (e) => {
        if (e.button != null && e.button !== 0) return
        const node = panelRef.current
        if (!node) return
        e.stopPropagation()
        const r = node.getBoundingClientRect()
        const start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height }
        setDragging(true)
        if (draggingRef) draggingRef.current = true
        const onMove = (ev) => {
          const dx = ev.clientX - start.x
          const dy = ev.clientY - start.y
          let left = start.left
          let top = start.top
          let w = start.w
          let h = start.h
          if (dir.indexOf('e') >= 0) {
            w = Math.min(Math.max(start.w + dx, MIN_W), Math.max(MIN_W, window.innerWidth - start.left - 8))
          } else if (dir.indexOf('w') >= 0) {
            w = Math.min(Math.max(start.w - dx, MIN_W), Math.max(MIN_W, start.left + start.w - 8))
            left = start.left + start.w - w
          }
          if (dir.indexOf('s') >= 0) {
            h = Math.min(Math.max(start.h + dy, MIN_H), Math.max(MIN_H, window.innerHeight - start.top - 8))
          } else if (dir.indexOf('n') >= 0) {
            h = Math.min(Math.max(start.h - dy, MIN_H), Math.max(MIN_H, start.top + start.h - 8))
            top = start.top + start.h - h
          }
          left = Math.max(8, Math.min(left, Math.max(8, window.innerWidth - w - 8)))
          top = Math.max(8, Math.min(top, Math.max(8, window.innerHeight - h - 8)))
          setBox({ left, top, w, h })
        }
        let finished = false
        const onUp = (ev) => {
          if (finished) return
          finished = true
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('mouseup', onUp)
          setDragging(false)
          if (draggingRef) draggingRef.current = false
          setBox((b) => {
            if (b) {
              savedSize.current = { w: b.w, h: b.h }
              saveSize(b.w, b.h)
            }
            return b
          })
          if (onDragEnd) onDragEnd(ev && typeof ev.clientX === 'number' ? ev.clientX : null, ev && typeof ev.clientY === 'number' ? ev.clientY : null)
        }
        // pointer 事件为主，mouse 事件兜底（有的合成输入只派发其中一种）
        window.addEventListener('pointermove', onMove)
        window.addEventListener('mousemove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('mouseup', onUp)
      }

      const mem = state && state.mem
      const usedPct = mem && mem.totalMB ? Math.round((mem.usedMB / mem.totalMB) * 100) : 0

      return h(
        'div',
        {
          ref: panelRef,
          'data-status-pills-panel': '1',
          onMouseEnter: () => onHoverEnter && onHoverEnter(),
          onMouseLeave: () => onHoverLeave && onHoverLeave(),
          style: {
            ...panelOuter,
            left: box ? box.left : undefined,
            top: box ? box.top : 60,
            width: box ? box.w : DEFAULT_W,
            height: box && box.h != null ? box.h : undefined,
            maxHeight: box && box.h != null ? 'none' : 'min(560px, 72vh)',
            visibility: box ? 'visible' : 'hidden',
            userSelect: dragging ? 'none' : undefined,
          },
        },
        h('div', { style: panelInner }, [
        // ── 内存 ──
        h('div', { style: h4Style }, '内存'),
        h(Row, { label: '已用 / 总量', value: usedText(mem), bold: true }),
        bar(usedPct),
        h(Row, { label: '可用', value: mem ? mbToG(mem.availMB) : '—' }),
        h(Row, { label: '已用占比', value: usedPct + '%' }),

        // ── CPU ──
        h('div', { style: { ...h4Style, marginTop: 12 } }, 'CPU'),
        h(Row, {
          label: '使用率',
          value: state && state.cpu ? state.cpu.pct + '%' : '—',
          bold: true,
        }),
        bar(state && state.cpu ? state.cpu.pct : 0),
        h(Row, { label: '逻辑核心', value: state && state.cpu ? state.cpu.cores + ' 个' : '—' }),

        // ── GPU ──
        h('div', { style: { ...h4Style, marginTop: 12 } }, 'GPU'),
        h(Row, {
          label: '使用率',
          value: state && state.gpu ? state.gpu.utilPct + '%' : '—',
          bold: true,
        }),
        bar(state && state.gpu ? state.gpu.utilPct : 0),
        state && state.gpu
          ? h(Row, { label: '型号', value: state.gpu.name })
          : h(Row, { label: '型号', value: '未检测到（nvidia-smi）' }),
        state && state.gpu && state.gpu.memTotalMB
          ? h(Row, {
              label: '显存',
              value: state.gpu.memUsedMB + 'M / ' + state.gpu.memTotalMB + 'M',
            })
          : null,

        // ── 进程 ──
        h('div', { style: { ...h4Style, marginTop: 12 } }, '进程 · 按内存排序'),
        procsErr
          ? h('div', { style: { opacity: 0.75, padding: '4px 0' } }, procsErr)
          : procs === null
            ? h('div', { style: { opacity: 0.75, padding: '4px 0' } }, '进程列表加载中…')
            : (procs.procs || []).map((p) =>
                h(ProcRow, { key: p.pid, p, armed: armed === p.pid, busy: busy === p.pid, onKill: doKill }),
              ),
        procs && procs.procs && procs.procs.length
          ? h(
              'div',
              { style: { marginTop: 6, opacity: 0.62, fontSize: 10.5, lineHeight: '15px' } },
              '共 ' + (procs.total || procs.procs.length) + ' 个进程（列出占用最高的 ' + procs.procs.length + ' 个）· 🔒=受保护 · 关闭=强制结束',
            )
          : null,

        notice
          ? h(
              'div',
              {
                style: {
                  marginTop: 8,
                  padding: '5px 8px',
                  borderRadius: 7,
                  background: 'var(--dsw-alias-bg-layer-1)',
                  color: 'var(--dsw-alias-label-primary)',
                  fontSize: 11,
                },
              },
              notice,
            )
          : null,
        ]),
        RESIZE_DIRS.map((dir) =>
          h('div', { key: dir, 'data-resize-dir': dir, onPointerDown: beginDrag(dir), style: handleStyle(dir) }),
        ),
      )
    }

    // ────────────────── 积分板胶囊（RH 国内 + RH 海外 + WorkBuddy + BreezeBlue 四合一） ──────────────────
    // 胶囊只显示「积分板 ✓」（四家都签完才打勾）；悬停面板每家两行：上行=余额，下行=补充口径 + 今日状态。
    // 面板底部四个链接：都指向「要登录才看得到」的账户页（余额/账单/套餐），
    // 主 Chrome 已登录就直接落在自己账号上；胶囊本身不再点击跳转。
    const RH_SITE_URL = 'https://www.runninghub.cn/bill-task' // 账单与任务（积分/RH币明细，需登录）
    const RH_INTL_SITE_URL = 'https://www.runninghub.ai/bill-task' // 同上，海外站（会自动带语言前缀）
    const WB_SITE_URL = 'https://www.codebuddy.cn/profile/plan' // WorkBuddy/CodeBuddy 账户：套餐 + 积分
    const BZ_SITE_URL = 'https://breezeblue.ai/app/home'

    // 点面板里那一行 → 新标签页打开对应站点（主 Chrome 已登录就直接是账户页）
    const openSite = (url) => {
      try {
        window.open(url, '_blank', 'noopener,noreferrer')
      } catch {}
    }

    // 面板一行 = 两行小字：上行「名字 + 余额」，下行「补充说明 + 今日状态」，右侧领取/刷新
    // 点这一行（按钮除外）= 打开对应站点里已登录的账户页
    function SiteRow({ flag, label, st, busy, onClaim, onOpen, openTitle, main, sub }) {
      const ok = st && st.ok !== false
      const granted = !!(st && st.granted)
      const stateText = granted
        ? '✅ 已领' + (st && st.amount ? ' ' + st.amount + ' 分' : '')
        : ok
          ? '⏳ 未领'
          : '—'
      const bal = st && st.balance != null ? st.balance + ' 分' : st && st.amount != null ? st.amount + ' 分' : '—'
      const mainText = main != null ? main : '余 ' + bal
      const subText = sub != null ? sub + ' · ' + stateText : stateText
      return h(
        'div',
        {
          role: onOpen ? 'link' : undefined,
          title: onOpen ? openTitle || '打开 ' + label + '（新标签页）' : undefined,
          onClick: onOpen
            ? (e) => {
                if (e && e.stopPropagation) e.stopPropagation()
                onOpen()
              }
            : undefined,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 6,
            paddingBottom: 5,
            borderBottom: '1px solid var(--dsw-alias-border-l2)',
            cursor: onOpen ? 'pointer' : undefined,
          },
          onMouseEnter: (e) => {
            if (onOpen && e && e.currentTarget) e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-1)'
          },
          onMouseLeave: (e) => {
            if (onOpen && e && e.currentTarget) e.currentTarget.style.background = 'transparent'
          },
        },
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 } },
            h(
              'span',
              {
                style: {
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              (flag ? flag + ' ' : '') + label,
            ),
            h(
              'span',
              {
                style: {
                  marginLeft: 'auto',
                  fontWeight: 600,
                  color: 'var(--dsw-alias-label-primary)',
                  whiteSpace: 'nowrap',
                },
              },
              mainText,
            ),
          ),
          h(
            'div',
            {
              style: {
                marginTop: 2,
                fontSize: 10.5,
                opacity: 0.82,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            subText,
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            disabled: !!busy,
            onClick: (e) => {
              if (e && e.stopPropagation) e.stopPropagation()
              onClaim()
            },
            style: {
              flex: '0 0 auto',
              font: 'inherit',
              fontSize: 10.5,
              padding: '2px 8px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              cursor: busy ? 'default' : 'pointer',
            },
          },
          busy ? '…' : granted ? '刷新' : '领取',
        ),
      )
    }

    const fmtNum = (n) => {
      const v = Number(n)
      if (!Number.isFinite(v)) return String(n)
      return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10)
    }


    function ScorePill({ compact, state }) {
      const cn = useRh('cn')
      const intl = useRh('intl')
      const wb = useWb()
      const bzG = useBz('gmail')
      const ms = useMs()
      const [open, setOpen] = useState(false)
      const [rect, setRect] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const anchorRef = useRef(null)
      const closeTimer = useRef(null)
      const openRef = useRef(false)
      // ── 面板可拖拽改大小（同内存面板那套，尺寸单独存） ──
      const panelRef = useRef(null)
      const savedSizeRef = useRef(readScoreSize())
      const [box, setBox] = useState(null)
      const [dragging, setDragging] = useState(false)
      const draggingRef = useRef(false)

      const cancel = () => {
        if (closeTimer.current) {
          window.clearTimeout(closeTimer.current)
          closeTimer.current = null
        }
      }
      const openNow = () => {
        cancel()
        if (openRef.current) return
        openRef.current = true
        const node = anchorRef.current
        setRect(node ? node.getBoundingClientRect() : null)
        setOpen(true)
      }
      const scheduleClose = () => {
        if (!openRef.current || draggingRef.current) return
        cancel()
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = null
          openRef.current = false
          setOpen(false)
        }, 220)
      }
      useEffect(() => {
        if (!open) return
        const onDown = (e) => {
          const t = e.target
          if (t && t.closest && (t.closest('[data-score-anchor]') || t.closest('[data-score-panel]'))) return
          openRef.current = false
          setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open])
      useEffect(() => () => cancel(), [])

      // 只在面板挂载时按胶囊位置定位一次（不依赖 rect 刷新，防止拖好的尺寸被重置）
      useEffect(() => {
        const saved = savedSizeRef.current
        const w = saved ? saved.w : PW
        const r = rect || { right: Math.max(8, window.innerWidth - 16), bottom: 44 }
        const gapRight = Math.max(8, Math.round(window.innerWidth - r.right))
        const left = Math.max(8, Math.min(window.innerWidth - gapRight - w, window.innerWidth - w - 8))
        setBox({ left, top: Math.max(8, Math.round(r.bottom + 8)), w, h: saved ? saved.h : null })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      // 窗口尺寸变化时把框拉回屏内
      useEffect(() => {
        const onResize = () => {
          setBox((b) => {
            if (!b) return b
            const w2 = Math.min(b.w, Math.max(MIN_W, window.innerWidth - 16))
            const h2 = b.h == null ? null : Math.min(b.h, Math.max(MIN_H, window.innerHeight - 16))
            const left2 = Math.max(8, Math.min(b.left, Math.max(8, window.innerWidth - w2 - 8)))
            const top2 = Math.max(8, Math.min(b.top, Math.max(8, window.innerHeight - (h2 == null ? 120 : h2) - 8)))
            return { left: left2, top: top2, w: w2, h: h2 }
          })
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // 八向拖拽改尺寸：按住边缘/角落移动，松手存尺寸
      const beginDrag = (dir) => (e) => {
        if (e.button != null && e.button !== 0) return
        const node = panelRef.current
        if (!node) return
        e.stopPropagation()
        const r = node.getBoundingClientRect()
        const start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height }
        setDragging(true)
        draggingRef.current = true
        const onMove = (ev) => {
          const dx = ev.clientX - start.x
          const dy = ev.clientY - start.y
          let left = start.left
          let top = start.top
          let w = start.w
          let h = start.h
          if (dir.indexOf('e') >= 0) {
            w = Math.min(Math.max(start.w + dx, MIN_W), Math.max(MIN_W, window.innerWidth - start.left - 8))
          } else if (dir.indexOf('w') >= 0) {
            w = Math.min(Math.max(start.w - dx, MIN_W), Math.max(MIN_W, start.left + start.w - 8))
            left = start.left + start.w - w
          }
          if (dir.indexOf('s') >= 0) {
            h = Math.min(Math.max(start.h + dy, MIN_H), Math.max(MIN_H, window.innerHeight - start.top - 8))
          } else if (dir.indexOf('n') >= 0) {
            h = Math.min(Math.max(start.h - dy, MIN_H), Math.max(MIN_H, start.top + start.h - 8))
            top = start.top + start.h - h
          }
          left = Math.max(8, Math.min(left, Math.max(8, window.innerWidth - w - 8)))
          top = Math.max(8, Math.min(top, Math.max(8, window.innerHeight - h - 8)))
          setBox({ left, top, w, h })
        }
        let finished = false
        const onUp = () => {
          if (finished) return
          finished = true
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('mouseup', onUp)
          setDragging(false)
          draggingRef.current = false
          setBox((b) => {
            if (b) {
              savedSizeRef.current = { w: b.w, h: b.h }
              saveScoreSize(b.w, b.h)
            }
            return b
          })
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('mousemove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('mouseup', onUp)
      }

      const doClaim = async (site) => {
        if (busy) return
        setBusy(site)
        setMsg('')
        try {
          const ep = site === 'cn' ? 'rh-claim' : site === 'intl' ? 'rh-intl-claim' : site === 'bz-gmail' || site === 'bz-qq' ? 'breeze-claim' : site === 'ms' ? 'ms-claim' : 'wb-claim'
          const res = await fetch('/status-pills-api/' + ep, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: site === 'bz-gmail' || site === 'bz-qq' ? JSON.stringify({ account: site === 'bz-qq' ? 'qq' : 'gmail' }) : '{}',
            credentials: 'same-origin',
          })
          const body = await res.json()
          if (body && body.ok && body.value) {
            if (site === 'wb') {
              wbStore.state = body.value
              wbNotify()
            } else if (site === 'ms') {
              msStore.state = body.value
              msNotify()
            } else if (site === 'bz-gmail' || site === 'bz-qq') {
              const acc = site === 'bz-qq' ? 'qq' : 'gmail'
              bzStores[acc].state = body.value
              bzNotify(acc)
            } else {
              rhStores[site].state = body.value
              rhNotify(site)
            }
            const who =
              site === 'cn'
                ? 'RH 中国站'
                : site === 'intl'
                  ? 'RH 海外站'
                  : site === 'bz-gmail'
                    ? 'BreezeBlue·G'
                    : site === 'bz-qq'
                      ? 'BreezeBlue·QQ'
                      : site === 'ms'
                        ? '魔搭'
                        : 'WorkBuddy'
            setMsg(who + '：' + (body.value.granted || body.value.checkedIn ? '已领取' : '领取结果：未生效'))
          } else {
            setMsg('领取失败：' + ((body && body.error && body.error.message) || '未知错误'))
          }
        } catch (e) {
          setMsg('领取失败：' + String((e && e.message) || e))
        }
        setBusy('')
      }

      const rhDone = (st) => st && st.ok !== false && !!st.granted
      const bzDone = (st) => st && st.ok !== false && !!st.granted
      const msDone = ms && ms.ok !== false && !ms.stale && !!ms.granted
      const allDone = rhDone(cn) && rhDone(intl) && wb && wb.ok !== false && !!wb.checkedIn && bzDone(bzG) && msDone
      const anyKnown = (cn && cn.ok !== false) || (intl && intl.ok !== false) || (wb && wb.ok !== false) || (bzG && bzG.ok !== false) || (ms && ms.ok !== false)

      const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
      const PW = 312
      const left = rect ? Math.max(8, Math.min(rect.left, vw - PW - 8)) : Math.max(8, vw - PW - 16)
      const top = rect ? Math.round(rect.bottom + 6) : 44

      return h(
        'span',
        {
          ref: anchorRef,
          'data-score-anchor': '1',
          style: { display: 'inline-flex', alignItems: 'center' },
          onMouseEnter: openNow,
          onMouseLeave: scheduleClose,
        },
        // 主人 2026-11-18：✓/○ 已去掉。「余额」这个名字属于旁边那个纵向块（DeepSeek 钱 + GLM 百分比，
        // 主人原话「把这两个合并」）；这个签到积分面板继续叫「积分板」，别再撞名。
        h(
          'span',
          {
            title:
              '积分板（API 余额 + RH 国内/海外 + WorkBuddy + BreezeBlue + 魔搭）· 悬停看 DeepSeek/GLM 余额和各家积分' +
              (allDone ? ' · 今天五家都签完了 ✓' : anyKnown ? ' · 有没签的，悬停看' : ''),
            style: { ...PILL, ...(compact ? PILL_COMPACT : null), cursor: 'default', fontWeight: 600 },
          },
          '积分板',
        ),
        open
          ? h(
              'div',
              {
                ref: panelRef,
                'data-score-panel': '1',
                onMouseEnter: cancel,
                onMouseLeave: scheduleClose,
                style: {
                  ...panelOuter,
                  zIndex: 10001,
                  left: box ? box.left : undefined,
                  top: box ? box.top : 60,
                  width: box ? box.w : PW,
                  height: box && box.h != null ? box.h : undefined,
                  maxHeight: box && box.h != null ? 'none' : 'min(430px, 72vh)',
                  visibility: box ? 'visible' : 'hidden',
                  userSelect: dragging ? 'none' : undefined,
                },
              },
              h(
                'div',
                { style: panelInner },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 2 } },
                h('b', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 12 } }, '余额 · 每日签到'),
              ),
              // ── API 余额段（主人 2026-11-18：DeepSeek 钱 + GLM 5h/周 全收进积分板面板）──
              // 纯展示行：label + 值 + 灰字说明（重置时间/口径），没有领取按钮。
              (state ? balanceRows(state) : []).map((r) =>
                h(
                  'div',
                  {
                    key: 'bal-' + r.key,
                    title: r.hint,
                    style: {
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: 8,
                      marginTop: 6,
                      paddingBottom: 5,
                      borderBottom: '1px solid var(--dsw-alias-border-l2)',
                    },
                  },
                  h('span', null, r.label),
                  h(
                    'b',
                    { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } },
                    r.value,
                  ),
                ),
              ),
              h(SiteRow, {
                flag: '',
                label: 'RH 中国站',
                st: cn,
                busy: busy === 'cn',
                onClaim: () => doClaim('cn'),
                onOpen: () => openSite(RH_SITE_URL),
                openTitle: '打开 RunningHub 中国站 · 账单与任务（积分/RH币，新标签页）',
                main: cn && cn.ok !== false && cn.coin != null ? '积分 ' + fmtNum(cn.coin) : null,
                sub: null,
              }),
              h(SiteRow, {
                flag: '',
                label: 'RH 海外站',
                st: intl,
                busy: busy === 'intl',
                onClaim: () => doClaim('intl'),
                onOpen: () => openSite(RH_INTL_SITE_URL),
                openTitle: '打开 RunningHub 海外站 · 账单与任务（新标签页）',
                main: intl && intl.ok !== false && intl.coin != null ? '积分 ' + fmtNum(intl.coin) : null,
                sub: null,
              }),
              h(SiteRow, {
                flag: '',
                label: wb && wb.streak != null ? 'WorkBuddy · 连签 ' + wb.streak + ' 天' : 'WorkBuddy',
                st:
                  wb && wb.ok !== false
                    ? { ok: true, granted: !!wb.checkedIn, amount: wb.dailyCredit, balance: wb.totalCredits }
                    : wb,
                busy: busy === 'wb',
                onClaim: () => doClaim('wb'),
                onOpen: () => openSite(WB_SITE_URL),
                openTitle: '打开 WorkBuddy/CodeBuddy 账户页（套餐 + 积分，新标签页）',
                main:
                  wb && wb.ok !== false && wb.creditsLeft != null
                    ? '积分 ' + fmtNum(wb.creditsLeft)
                    : wb && wb.ok !== false && wb.totalCredits != null
                      ? '签到累计 ' + fmtNum(wb.totalCredits)
                      : null,
                sub: null, // 主人 2026-11-19：灰字说明全删
              }),
              h(SiteRow, {
                flag: '',
                label: 'BreezeBlue（Discord/QQ 同号）',
                st: bzG,
                busy: busy === 'bz-gmail',
                onClaim: () => doClaim('bz-gmail'),
                onOpen: () => openSite(BZ_SITE_URL),
                openTitle: '打开 BreezeBlue（新标签页）',
                main: bzG && bzG.ok !== false && bzG.balance != null ? '积分 ' + fmtNum(bzG.balance) : null,
              }),
              h(SiteRow, {
                flag: '',
                label: '魔搭 ModelScope（免费模型）',
                st: ms ? { ok: ms.ok !== false && !ms.stale, granted: !!(ms.granted && !ms.stale) } : ms,
                busy: busy === 'ms',
                onClaim: () => doClaim('ms'),
                onOpen: () => openSite('https://modelscope.cn/magicube/usage'),
                openTitle: '打开魔搭魔粒页（每日登录 200 + 绑定阿里云 50，新标签页）',
                main:
                  ms && ms.ok !== false && !ms.stale
                    ? ms.granted
                      ? '今日已完成 · 魔粒 ' + (ms.magicube == null ? '—' : fmtNum(ms.magicube))
                      : '今日未完成'
                    : null,
              }),
              msg
                ? h('div', { style: { marginTop: 6, color: 'var(--dsw-alias-label-primary)', fontSize: 11 } }, msg)
                : null,
              ),
              RESIZE_DIRS.map((dir) =>
                h('div', { key: 'rz-' + dir, 'data-resize-dir': dir, onPointerDown: beginDrag(dir), style: handleStyle(dir) }),
              ),
            )
          : null,
      )
    }

    // ────────────────── 胶囊组 ──────────────────
    // 手机端（≤ NARROW_VW）：①每个胶囊换短文案+小一号；②整组卡在「左边到视口右边」
    // 这段宽度里，超出部分**横向滑动**着看（overflow-x:auto）。桌面宽屏一切照旧。
    // 700 → 900（2026-11-14）：平板 / 半屏窗口（768~900）主区只剩 ~500px，宽版三颗（381px）
    // 跟页面标题、右侧「新建」挤在一排必然打架，换成短文案才放得下（489 宽也不会再压标题）。
    const NARROW_VW = 900

    // 量「胶囊组左边 → 视口右边」还剩多少，卡成容器 maxWidth。
    // ⚠️ 只在 resize / 延时复查时量，不做 rAF 持续量：卡宽度本身会改动布局，
    //    持续量容易自己跟自己打转（左边被挤 → 宽度再小 → …）。
    function usePillsLayout(ref) {
      const [lay, setLay] = useState({ narrow: false, maxW: null })
      useEffect(() => {
        let timers = []
        const compute = () => {
          const vw = window.innerWidth
          if (vw > NARROW_VW) {
            setLay((p) => (p.narrow || p.maxW != null ? { narrow: false, maxW: null } : p))
            return
          }
          const node = ref.current
          if (!node) return
          const r = node.getBoundingClientRect()
          // 悬浮那份（shell.overlay）是 right 定位、宽度由 planDock 保证放得下；这里再按
          // left 反推 maxW 会把整组裁掉几像素（实测 489 宽时最后一颗的 ✓ 被切掉）。
          // 所以只有真溢出屏幕左边时才卡宽度。
          const floating = !!node.closest('[data-status-pills-overlay]')
          let maxW = null
          if (floating) {
            if (r.left < 0) maxW = Math.max(140, Math.round(vw - 20))
          } else if (r.left > 0 && r.left < vw - 60) {
            maxW = Math.max(140, Math.round(vw - r.left - 10)) // 顶栏里：右边留 10px 贴屏边
          } else if (r.left <= 0) {
            // 顶栏太窄、被挤到左边溢出屏幕：按右边界反推
            maxW = Math.max(140, Math.round(r.right - 8))
          }
          setLay((p) => (p.narrow && p.maxW === maxW ? p : { narrow: true, maxW }))
        }
        const schedule = () => {
          compute()
          for (const t of timers) window.clearTimeout(t)
          // 顶栏里「历史/时间」这类控件是后挂上来的，挂完会把胶囊往右挤 → 延时补量两次
          timers = [window.setTimeout(compute, 400), window.setTimeout(compute, 1500)]
        }
        schedule()
        window.addEventListener('resize', schedule)
        window.addEventListener('orientationchange', schedule)
        // 顶栏里「1 个后台任务」这类字是**后来**才出现的，会把胶囊往右挤。
        // 靠 MutationObserver 盯整页太重（会话流式输出每帧都在变），改用低频复查：
        // 一次 getBoundingClientRect，量完没变就不 setState。
        const iv = window.setInterval(compute, 2500)
        return () => {
          for (const t of timers) window.clearTimeout(t)
          window.clearInterval(iv)
          window.removeEventListener('resize', schedule)
          window.removeEventListener('orientationchange', schedule)
        }
      }, [ref])
      return lay
    }

    function StatusPills() {
      const state = useStatus()
      const [open, setOpen] = useState(false)
      const [rect, setRect] = useState(null)
      const anchorRef = useRef(null)
      const closeTimer = useRef(null)
      const openRef = useRef(false)
      const draggingRef = useRef(false)
      const lay = usePillsLayout(anchorRef)
      const narrow = lay.narrow

      useEffect(
        () => () => {
          if (closeTimer.current) window.clearTimeout(closeTimer.current)
        },
        [],
      )

      const cancelClose = () => {
        if (closeTimer.current) {
          window.clearTimeout(closeTimer.current)
          closeTimer.current = null
        }
      }

      // 悬停进入胶囊（或面板，面板是锚点容器的子节点）就开；触屏没有 hover，走 click 兜底。
      // 已开时不再刷新 rect —— 否则拖拽改好的尺寸会被重置回默认值。
      const openPanel = () => {
        cancelClose()
        if (openRef.current) return
        openRef.current = true
        const node = anchorRef.current
        setRect(node ? node.getBoundingClientRect() : null)
        setOpen(true)
      }

      const close = () => {
        openRef.current = false
        draggingRef.current = false
        setOpen(false)
      }

      // 移开 1s 后再收，期间移回胶囊/面板就取消；拖拽改尺寸时不收
      const scheduleClose = () => {
        if (!openRef.current || draggingRef.current) return
        cancelClose()
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = null
          close()
        }, 1000)
      }

      // 点面板外面：立即收起，不等 1s
      const closeNow = () => {
        cancelClose()
        close()
      }

      // 拖拽松手后鼠标若已经不在胶囊/面板上，按「移开」处理（1s 后收）
      const handleDragEnd = (x, y) => {
        if (typeof x !== 'number' || typeof y !== 'number') return
        const node = anchorRef.current
        if (!node) return
        const hit = document.elementFromPoint(x, y)
        if (!hit || !node.contains(hit)) scheduleClose()
      }

      const mem = state && state.mem
      const memTitle =
        (mem ? '已用 ' + mbToG(mem.usedMB) + ' / 共 ' + Math.round(mem.totalMB / 1024) + 'G（可用 ' + mbToG(mem.availMB) + '）' : '内存：取不到数据') +
        ' · 点击看 CPU/GPU 与进程'

      return h(
        'div',
        {
          ref: anchorRef,
          'data-status-pills-anchor': '1',
          'data-status-pills-narrow': narrow ? '1' : '0',
          // 胶囊组自己的横向滑动条（手机上手指左右划）；桌面不挂 overflow，保持原样
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            // 余额块是纵向多行的（比内存胶囊高），整组按顶端对齐，看着才像同一栏
            gap: narrow ? 4 : 6,
            marginRight: narrow ? 4 : 6,
            ...(narrow
              ? {
                  maxWidth: lay.maxW == null ? undefined : lay.maxW,
                  overflowX: 'auto',
                  overflowY: 'hidden',
                  flexWrap: 'nowrap',
                  // 别写 touch-action:pan-x —— 那会把「从胶囊上竖着滑页面」也禁掉；
                  // 浏览器自己会按手势方向决定是滑胶囊还是滑页面。
                  overscrollBehaviorX: 'contain',
                  WebkitOverflowScrolling: 'touch',
                }
              : null),
          },
        },
        // ⚠️ 悬停面板只挂「内存」这颗（面板里全是内存 / CPU / GPU / 进程）；
        //    余额块只给原生 tooltip，别跟着弹 —— 主人原话「鼠标滑到额度上面也有这个详细面板，应该只有内存才会出现」。
        h(Pill, {
          text: '内存 ' + (narrow ? usedTextShort(mem) : usedText(mem)),
          title: memTitle,
          compact: narrow,
          onClick: openPanel,
          onMouseEnter: openPanel,
          onMouseLeave: scheduleClose,
        }),
        h(ScorePill, { compact: narrow, state }),
        open
          ? h(Panel, {
              state,
              rect,
              onClose: closeNow,
              draggingRef,
              onDragEnd: handleDragEnd,
              onHoverEnter: cancelClose,
              onHoverLeave: scheduleClose,
            })
          : null,
      )
    }

    // ────────────────── 悬浮胶囊的「停靠位」（新任务页 / 插件页 / 自动化任务页 / 设置弹窗） ──────────────────
    //
    // 以前写死 top:12 right:82 —— 在「插件 / 自动化 / 任务」这类页面上，右上角是页面自己的
    // 工具栏（刷新 / 添加插件 / 新建），胶囊正好压在那两个按钮上（实测 y 28..60 与 12..38
    // 重叠 10px，主人截图就是这个）。所以改成：量出**右上角控件簇**的左边界，把胶囊塞到它
    // 左边、和它同一条横栏里 —— 胶囊永远在最前，且永远不盖住任何按钮。
    // 2026-11-14 补：手机上（≤ NARROW_VW）页面标题栏落在顶栏下面（实测 489 宽时 h1 在 y=78），
    //   跟着它走就不叫「永远在顶上」，还会盖住「自动化任务」大标题（主人截图）。
    //   → 这一排塞不下「标题 + 胶囊 + 右侧按钮」时，改成钉在视口最顶上那一条横带里右对齐。
    // 注意：页面滚动时顶栏内容会上收（实测 toolbar y 28 → 16），所以监听 scroll / resize /
    // DOM 变化，用 rAF 节流重算；值没变就不 setState（避免跟 MutationObserver 打转）。
    const TOP_BAND = 96 // 只认视口顶部这一段里的控件

    // 左侧边栏的右边界：胶囊往左让的时候不许压到它（拿 [data-sidebar-toggle] 往上量，
    // 取「宽度像边栏（40..420）且够高」的最外层盒子；窄屏左栏收成图标条时自然是 60）。
    function leftBarRight() {
      const toggle = document.querySelector('[data-sidebar-toggle="true"]')
      let n = toggle
      let best = 0
      while (n && n !== document.body) {
        const r = n.getBoundingClientRect()
        if (r.width >= 40 && r.width < 420 && r.height > 200) best = Math.max(best, Math.round(r.right))
        n = n.parentElement
      }
      return best
    }

    // 右侧边栏（右栏）的占位。三种形态：
    //   ① 宽屏：停靠成最右一列 —— [data-rightbar-col] 有宽度，量得到左边界；
    //   ② 窄屏（≤约 700）：变成盖满整屏的浮层 —— col 宽 0，胶囊没处可站；
    //   ③ 关闭 / 当前页面没有右栏：属性不在，或画出来是 0 宽（返回 null，胶囊照旧停右上角）。
    // ⚠️ 胶囊是 position:fixed 的浮层：右栏一开，它就压在右栏的头顶上（实测 1374 宽时
    //    胶囊停在 1006..1252，而右栏从 756 开始 —— 整个右栏头部那条横栏都被占了）。
    //    所以「胶囊右边界」必须卡在右栏左边界左边，而不是按右栏自己的按钮往左让。
    function rightBarInfo() {
      // 只认真的开着（DSH 给右栏挂 data-sidebar-right-open="true"），而且**必须真的画出来了**：
      // ⚠️ 两个坑：
      //    ① 别拿「收起右侧边栏」按钮当开关 —— 右栏关着时那颗按钮仍留在 DOM 里（实测 x≈1962，
      //       屏幕外），照它判断会把「关」误判成「开」，胶囊整组藏起来；
      //    ② 属性也可能在、右栏却没渲染（切到插件页这类没有右栏的页面时实测属性还在、宽度 0），
      //       所以还得量一遍几何，宽高都像样才认。
      const panel = document.querySelector('[data-sidebar-right-open="true"]')
      if (!panel) return null
      const pr = panel.getBoundingClientRect()
      if (pr.width < 120 || pr.height < 120 || panel.offsetParent === null) return null
      const col = document.querySelector('[data-rightbar-col]')
      if (!col) return { full: true }
      const r = col.getBoundingClientRect()
      if (r.width < 120 || r.height < 120) return { full: true }
      // 右栏头部那排按钮的中心 y：胶囊跟它同一条横栏，看着才像「同一行」
      let rowCy = null
      const btn = col.querySelector('[data-dockkit-strip] button') || col.querySelector('button')
      if (btn) {
        const br = btn.getBoundingClientRect()
        if (br.height >= 8 && br.height <= 64 && br.bottom <= TOP_BAND) rowCy = Math.round(br.top + br.height / 2)
      }
      return { left: Math.round(r.left), rowCy }
    }

    // 页面大标题（h1/h2）占的位置。⚠️ 以前只找 `seed.el.closest('header')` —— 但「自动化任务 /
    // 插件」这类页面的标题栏是普通 div（不是 <header>），窄屏让位整个失效，胶囊直接压在大标题上
    //（489 宽实测盖住「自动化任务」右半边）。另外 h1 的盒子常被动画撑宽，用 Range 量文字本身的
    // 右边界才准。
    function pageTitleRect(scope) {
      for (const el of (scope || document).querySelectorAll('h1, h2')) {
        if (el.closest('[role="dialog"]')) continue
        if (el.offsetParent === null) continue
        const box = el.getBoundingClientRect()
        if (box.width < 20 || box.height < 10 || box.top > 240) continue // 只认页面顶部的大标题
        let right = box.right
        try {
          const range = document.createRange()
          range.selectNodeContents(el)
          const tr = range.getBoundingClientRect()
          if (tr.width > 0 && tr.right > 0) right = tr.right
        } catch {
          right = box.right
        }
        return { left: box.left, right, top: box.top, bottom: box.bottom }
      }
      return null
    }

    // 在「top .. top+h」这条横带里，从右往左找一块放得下 w 宽胶囊的空位。
    // 同一排的控件只要会跟胶囊重叠就整颗让过去（不能只按「间隙」分簇：刷新 和 添加插件
    // 之间就有 16px 缝，按簇算会把胶囊塞进缝里）。
    function placeInBand(items, w, top, h, limit) {
      let right = limit
      const bandTop = top - 4
      const bandBottom = top + h + 4
      for (let pass = 0; pass < 8; pass++) {
        let moved = false
        for (const it of items) {
          if (it.bottom <= bandTop || it.top >= bandBottom) continue // 不在同一条横带里
          if (it.left < right && it.right > right - w) {
            right = it.left - 10
            moved = true
          }
        }
        if (!moved) break
      }
      return Math.min(right, limit)
    }

    function planDock(vw, w, h) {
      const rb = rightBarInfo()
      if (rb && rb.full) return { hidden: true } // 右栏盖满整屏：胶囊无处可站，别浮在它上面
      const limit = rb ? rb.left - 10 : vw - 8 // 胶囊右边界上限（右栏开着时不越进去）
      const minLeft = leftBarRight() + 8 // 胶囊左边界下限（不压左侧边栏）
      // 只看**真正打开着的模态弹窗**（aria-modal="true"）。⚠️ 两个坑：
      //   ① 关掉的弹窗常常还留在 DOM 里（display:none）；
      //   ② 窄屏时左侧抽屉也带 role="dialog"（但 aria-modal 不是 true，且在屏幕外）。
      const dialog = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).find((d) => {
        if (d.offsetParent === null) return false
        const r = d.getBoundingClientRect()
        return r.width > 80 && r.height > 80
      })
      const scope = dialog || document
      const items = []
      for (const el of scope.querySelectorAll('button, [role="button"], a')) {
        if (el.closest('[data-status-pills-anchor]')) continue
        if (el.closest('[data-rightbar-col]')) continue // 右栏自己的按钮不算「主区控件」
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue
        if (el.offsetParent === null) continue
        const r = el.getBoundingClientRect()
        if (r.width < 12 || r.height < 12) continue
        if (r.bottom <= 0 || r.top >= TOP_BAND) continue
        // ⚠️ 右栏 / 分栏这些控件藏在**滑出屏幕外**的容器里（实测 x≈1886，视口才 1374），
        //    offsetParent 仍然不是 null，必须按几何位置筛掉，否则胶囊会被停靠到屏幕外。
        if (r.left < 0 || r.right > vw + 1) continue
        if (r.right <= vw * 0.5) continue // 只看右半边的
        items.push({
          el,
          left: Math.round(r.left),
          right: Math.round(r.right),
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          cy: Math.round(r.top + r.height / 2),
        })
      }
      const title = pageTitleRect(scope)
      const fits = (right) => right - w >= minLeft
      const coversTitle = (top, right) =>
        !!title &&
        right - w < title.right + 10 &&
        right > title.left - 8 &&
        top < title.bottom + 6 &&
        top + h > title.top - 6

      // 主区顶部一个按钮都没有（首屏 / 右栏开着时主区是空的）：贴着主区右上角停，
      // 垂直方向对齐右栏头部那排按钮，看着像同一行。
      if (!items.length) {
        if (!rb) return null
        if (!fits(limit)) return { hidden: true } // 主区放不下：别横跨到右栏去
        const cy = rb.rowCy == null ? 24 : rb.rowCy
        return { top: Math.max(4, Math.round(cy - h / 2)), right: Math.round(vw - limit) }
      }

      // 竖着：跟这条横栏里最靠右的控件同一条线居中
      items.sort((a, b) => b.right - a.right)
      const seed = items[0]
      const top = Math.max(4, Math.round(seed.cy - h / 2))
      const right = placeInBand(items, w, top, h, limit)

      if (!coversTitle(top, right)) {
        if (!fits(right)) return rb ? { hidden: true } : null // 实在没地方
        return { top, right: Math.round(vw - right) }
      }

      // 这一排塞不下「标题 + 胶囊 + 右侧按钮」：钉到视口最顶上那一条（y≈8）右对齐；
      // 那条带里如果有按钮（刷新 / 添加插件…）再往左让。最顶上那条也塞不下时，退而求其次
      // 放到大标题上方（桌面宽屏不会走到这里）。
      for (const fallbackTop of [8, Math.max(4, Math.round(title.top - h - 6))]) {
        const r2 = placeInBand(items, w, fallbackTop, h, limit)
        if (fits(r2) && !coversTitle(fallbackTop, r2)) return { top: fallbackTop, right: Math.round(vw - r2) }
      }
      return rb ? { hidden: true } : null
    }

    // 新任务页（没有会话标题栏）时浮在右上角，和 model-hub 的设置齿轮同一层。
    // 会话页让位给 header.utilities 里的那份，避免两处重复。
    // ⚠️ 右栏（右侧边栏）打开时胶囊必须让到主区去 —— 见 planDock / rightBarInfo：
    //    找不到位置就整组藏起来（display:none），绝不横跨到右栏头上。
    function OverlayPills() {
      const [hasHeader, setHasHeader] = useState(false)
      const [dock, setDock] = useState({ top: 12, right: 82, hidden: false })
      const rowRef = useRef(null)

      useEffect(() => {
        const check = () => {
          const found = !!document.querySelector('[data-slot="conversation.session.header.utilities"]')
          setHasHeader((prev) => (prev === found ? prev : found))
        }
        check()
        const obs = new MutationObserver(check)
        obs.observe(document.body, { childList: true, subtree: true })
        return () => obs.disconnect()
      }, [])

      useEffect(() => {
        if (hasHeader) return
        let raf = 0
        let lastKey = ''
        const compute = () => {
          raf = 0
          const node = rowRef.current
          if (!node) return
          const vw = window.innerWidth
          const box = node.getBoundingClientRect()
          // 藏起来时（display:none）量出来是 0，用默认尺寸顶替，否则算不出该不该出来
          const w = box.width || 246
          const h = box.height || 26
          const plan = planDock(vw, w, h)
          // 没有任何右上角控件（新任务页早期）就退回老位置
          const next = plan || { top: 12, right: 82, hidden: false }
          const key = next.hidden ? 'hidden' : next.top + '/' + next.right
          if (key === lastKey) return
          lastKey = key
          setDock(next)
        }
        const schedule = () => {
          if (!raf) raf = window.requestAnimationFrame(compute)
        }
        schedule()
        window.addEventListener('resize', schedule)
        window.addEventListener('scroll', schedule, true) // 页面内滚动容器不冒泡，用捕获
        // 右栏是带过渡动画的（宽度 0 → 618），动画跑完再算一次，免得按中间态定死了位置
        document.addEventListener('transitionend', schedule, true)
        const obs = new MutationObserver(schedule)
        obs.observe(document.body, { childList: true, subtree: true })
        // 兜底：只在「动画/迟到的布局变化」这种 MutationObserver 也抓不到的场合才需要。
        // 3 秒一次足够（每次 = 全 DOM 扫一遍按钮再算矩形，1 秒一次在静止页上是纯浪费）。
        // 真正变化的时机都走 schedule()：resize / 捕获期 scroll / transitionend / MutationObserver。
        const iv = window.setInterval(schedule, 3000)
        return () => {
          if (raf) window.cancelAnimationFrame(raf)
          window.removeEventListener('resize', schedule)
          window.removeEventListener('scroll', schedule, true)
          document.removeEventListener('transitionend', schedule, true)
          obs.disconnect()
          window.clearInterval(iv)
        }
      }, [hasHeader])

      if (hasHeader) return null
      return h(
        'div',
        {
          ref: rowRef,
          'data-status-pills-overlay': '1',
          'data-status-pills-hidden': dock.hidden ? '1' : '0',
          style: {
            position: 'fixed',
            top: dock.top,
            right: dock.right,
            zIndex: 900,
            display: dock.hidden ? 'none' : 'flex',
            alignItems: 'center',
            gap: 6,
            pointerEvents: 'auto',
          },
        },
        h(StatusPills, null),
      )
    }

    // 手机端横向滑动条：藏掉滚动条本身（不然胶囊组下面多出一条灰杠），滑动照旧。
    const CSS_ID = 'dsh-status-pills-css'

    function injectPillCss() {
      if (typeof document === 'undefined' || document.getElementById(CSS_ID)) return
      const el = document.createElement('style')
      el.id = CSS_ID
      el.textContent = [
        '[data-status-pills-anchor]{scrollbar-width:none;-ms-overflow-style:none}',
        '[data-status-pills-anchor]::-webkit-scrollbar{display:none;width:0;height:0}',
      ].join('')
      document.head.appendChild(el)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 官方规范：factory 级共享 store 的轮询定时器必须挂 ctx.effect，
        // HMR/禁用重跑 factory 时不清理就会每轮叠 4 个 interval 空转 fetch。
        ctx.effect(
          () => () => {
            if (store.timer) {
              window.clearInterval(store.timer)
              store.timer = null
            }
            if (rhTimer) {
              window.clearInterval(rhTimer)
              rhTimer = null
            }
            if (bzTimer) {
              window.clearInterval(bzTimer)
              bzTimer = null
            }
            if (wbStore.timer) {
              window.clearInterval(wbStore.timer)
              wbStore.timer = null
            }
          },
          'status-pills: store poll timers',
        )
        injectPillCss()
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'status-pills', order: 30 },
            () => h(StatusPills, null),
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'status-pills-overlay', order: 6 }, () =>
            h(OverlayPills, null),
          ),
        )
      },
    }
  },
})
