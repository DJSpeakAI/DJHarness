/**
 * 截图设置（Client 半）—— 设置 › 截图 分区。
 *
 * 只管一个插件：自带「截图标注」（@local/dsh-screenshot）的快捷键。
 *   localStorage['dsh-shot:hotkey']，默认 Alt+KeyA，每次按键现读 → 改完即时生效。
 *
 * 2026-11-18 v0.153：第三方 dsh-plugin-screenshot 已按主人要求删除（抓屏同款、窗口吸附/长截图对主人没用），
 * 本分区随之瘦成一张卡；原来的「输入框截图」卡与 Alt+S 派键逻辑一并移除。
 *
 * 快捷键格式（规范串）："Ctrl+Alt+Shift+Meta+<e.code>"，主键用 e.code（输入法开启时
 * key 会变 'Process'，code 稳定）。示例：Alt+KeyA / Ctrl+Alt+KeyS / Ctrl+Shift+Digit1。
 *
 * 系统保留组合（Ctrl+C/V/S/X/Z/A、Alt+F4、F5/F12、Ctrl+R/W）拒绝保存并红字提示。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-shot-settings',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect

    const KEY_OLD = 'dsh-shot:hotkey'
    const DEFAULT_OLD = 'Alt+KeyA'
    /* 弃用键：第三方插件时代留下的 Alt+S，进来顺手清掉，避免以后复活 */
    const STALE_KEY_PRO = 'dsh-shot:hotkey-pro'
    /* 系统级保留：录到这些直接拒绝 */
    const RESERVED = new Set([
      'Ctrl+KeyC', 'Ctrl+KeyV', 'Ctrl+KeyS', 'Ctrl+KeyX', 'Ctrl+KeyZ', 'Ctrl+KeyA',
      'Alt+F4', 'F5', 'F12', 'Ctrl+KeyR', 'Ctrl+KeyW',
    ])

    /* ---- 快捷键串解析 / 匹配 / 显示 ---- */
    function parseAccel(str) {
      const parts = String(str || '')
        .split('+')
        .map((s) => s.trim())
        .filter(Boolean)
      const a = { ctrl: false, alt: false, shift: false, meta: false, code: '' }
      for (const p of parts) {
        const q = p.toLowerCase()
        if (q === 'ctrl' || q === 'control') a.ctrl = true
        else if (q === 'alt') a.alt = true
        else if (q === 'shift') a.shift = true
        else if (q === 'meta' || q === 'win' || q === 'cmd') a.meta = true
        else a.code = p
      }
      if (!a.code || a.code === 'Escape') return null
      return a
    }

    function normAccel(str) {
      const a = parseAccel(str)
      if (!a) return ''
      const pre = []
      if (a.ctrl) pre.push('Ctrl')
      if (a.alt) pre.push('Alt')
      if (a.shift) pre.push('Shift')
      if (a.meta) pre.push('Meta')
      return pre.concat([a.code]).join('+')
    }

    function eventToAccel(e) {
      const pre = []
      if (e.ctrlKey) pre.push('Ctrl')
      if (e.altKey) pre.push('Alt')
      if (e.shiftKey) pre.push('Shift')
      if (e.metaKey) pre.push('Meta')
      return pre.concat([e.code]).join('+')
    }

    function isModifierCode(code) {
      return /^(Control|Alt|Shift|Meta)(Left|Right)?$/.test(code)
    }

    function accelLabel(str) {
      const a = parseAccel(str)
      if (!a) return String(str || '（无效）')
      const pre = []
      if (a.ctrl) pre.push('Ctrl')
      if (a.alt) pre.push('Alt')
      if (a.shift) pre.push('Shift')
      if (a.meta) pre.push('Win')
      let main = a.code
      main = main.replace(/^Key([A-Z])$/, '$1').replace(/^Digit([0-9])$/, '$1')
      return pre.concat([main]).join('+')
    }

    function readLS(key, fallback) {
      try {
        const v = window.localStorage.getItem(key)
        if (v && parseAccel(v)) return v
      } catch {}
      return fallback
    }

    /* ---- 清理第三方插件留下的旧快捷键键 ---- */
    function dropStaleKey() {
      try { window.localStorage.removeItem(STALE_KEY_PRO) } catch {}
    }

    /* ---- 设置分区 UI ---- */
    const S = {
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        padding: '14px 16px',
        marginBottom: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
      },
      name: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      desc: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        lineHeight: 1.6,
        marginTop: 6,
      },
      kbd: {
        display: 'inline-block',
        padding: '3px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: 12,
        minWidth: 64,
        textAlign: 'center',
      },
      btn: {
        font: 'inherit',
        fontSize: 12,
        padding: '5px 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      btnRec: {
        border: '1px solid #2f6feb',
        color: '#7fb0ff',
        background: 'rgba(47,111,235,.12)',
      },
      err: { color: '#ff6b6b', fontSize: 12, marginTop: 6, lineHeight: 1.5 },
      ok: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginTop: 6 },
    }

    function HotkeyCard() {
      const [val, setVal] = useState(() => readLS(KEY_OLD, DEFAULT_OLD))
      const [recording, setRecording] = useState(false)
      const [msg, setMsg] = useState(null) // {type:'err'|'ok', text}

      useEffect(() => {
        if (!recording) return undefined
        const onRec = (e) => {
          e.preventDefault()
          e.stopPropagation()
          if (e.key === 'Escape') {
            setRecording(false)
            setMsg(null)
            return
          }
          if (isModifierCode(e.code)) return /* 等主键 */
          const accel = eventToAccel(e)
          if (RESERVED.has(accel)) {
            setMsg({ type: 'err', text: '⛔ ' + accelLabel(accel) + ' 是系统保留组合（复制/粘贴/保存/关闭等），不让人抢' })
            return
          }
          try {
            window.localStorage.setItem(KEY_OLD, accel)
          } catch {}
          setVal(accel)
          setRecording(false)
          setMsg({ type: 'ok', text: '✅ 已保存 ' + accelLabel(accel) + '，即时生效' })
          try { new BroadcastChannel('dsh-shot-hotkey').postMessage({ type: 'changed' }) } catch {}
        }
        document.addEventListener('keydown', onRec, true)
        return () => document.removeEventListener('keydown', onRec, true)
      }, [recording])

      /* 别的窗口改了键 → 这里跟着刷新（注意：不能靠父组件 key 重挂，会把「已保存」提示冲掉） */
      useEffect(() => {
        let ch = null
        try {
          ch = new BroadcastChannel('dsh-shot-hotkey')
          ch.onmessage = () => setVal(readLS(KEY_OLD, DEFAULT_OLD))
        } catch {}
        return () => { if (ch) { try { ch.close() } catch {} } }
      }, [])

      return h(
        'div',
        { style: S.card },
        h('div', { style: S.row },
          h('span', { style: S.name }, '📸 截图标注（DJH 自带）'),
          h('span', { style: S.kbd }, recording ? '按组合键…' : accelLabel(val)),
          h('button', {
            style: { ...S.btn, ...(recording ? S.btnRec : {}) },
            onClick: () => { setRecording(!recording); setMsg(null) },
          }, recording ? '取消 (Esc)' : '修改快捷键'),
          normAccel(val) !== DEFAULT_OLD
            ? h('button', {
                style: S.btn,
                onClick: () => {
                  try { window.localStorage.removeItem(KEY_OLD) } catch {}
                  setVal(DEFAULT_OLD)
                  setMsg({ type: 'ok', text: '✅ 已恢复默认 ' + accelLabel(DEFAULT_OLD) })
                  try { new BroadcastChannel('dsh-shot-hotkey').postMessage({ type: 'changed' }) } catch {}
                },
              }, '恢复默认')
            : null,
        ),
        h('div', { style: S.desc },
          '微信式：唤起后拖框 → 画红圈标注 → 双击复制 / Ctrl+S 另存为。快捷键在会话页、设置页等 DSH 页面内生效（浏览器拿不到系统级全局热键）。'),
        msg ? h('div', { style: msg.type === 'err' ? S.err : S.ok }, msg.text) : null,
      )
    }

    function ShotSection() {
      /* 卡内自己订阅 BroadcastChannel 同步，不再用 key 重挂（重挂会把「已保存」提示冲掉，v0.153 实测踩过） */
      useEffect(() => { dropStaleKey() }, [])

      return h('div', { 'data-shot-settings': '1' },
        h(HotkeyCard),
        h('div', { style: S.desc },
          '录快捷键规则：点「修改快捷键」后直接按组合键（Esc 取消）；Ctrl+C / Ctrl+V / Ctrl+S / Alt+F4 等系统组合会被拒绝。'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'shot-settings',
              order: 3,
              label: () => '截图',
            },
            () => h(ShotSection),
          ),
        )
      },
    }
  },
})
