/**
 * dsh-tts-voice（Client 半）—— 设置页一级栏目「TTS 语音」。
 *
 * 结构（2026-11-19 v0.171 主人改版）：
 *   ① 顶部两个子页签：💬 对话页面播报 / 🔵 星闪球播报 —— 两页内容完全一样（四家来源 × 各自音色），
 *      选哪家哪个音色就存到那个播报入口（entries.chat / entries.orb 各存一份，互不影响）
 *   ② 每家来源卡：音色下拉（自绘深色，带别名）＋▶试听＋起别名＋「🌐 我的音色（从官网刷新）」＋手动加音色 ID
 *   ③ 每家卡头右侧显示**余额**（DeepSeek ￥ / 火山云 ￥ / 阿里云 ￥ / Breeze 积分），点 ↻ 现查
 *   ④ 每张卡显示**上次播报消耗**（字数 + 估算花费），底部还有一条全局「上次播报」
 *
 * 2026-11-19（v0.169）：原生 <select> 全部换成自绘深色下拉 Picker。
 * 2026-11-19（v0.171）：修「下拉里滚轮一滚面板就跳没了」——原来 window 上挂了 capture 的 scroll 监听，
 *   面板自己 overflow 滚动也会冒上来 → 一律关面板。现在只认「面板外面的滚动」：外面滚就跟着按钮重新定位，
 *   滚出屏幕才收；面板内部怎么滚都不动它。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-tts-voice',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const API = '/tts-voice-api'
    const PROVIDERS = [
      { id: 'deepseek', label: 'DeepSeek', emoji: '🐋' },
      { id: 'volc', label: '火山引擎', emoji: '🌋' },
      { id: 'aliyun', label: '阿里云', emoji: '☁️' },
      { id: 'breeze', label: 'Breeze', emoji: '🍃' },
    ]
    const ENTRY_LABEL = { chat: '💬 对话页面播报', orb: '🔵 星闪球播报' }
    const ENTRY_SHORT = { chat: '💬 对话页面', orb: '🔵 星闪球' }

    async function api(body) {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await r.json()
      if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status)
      return j
    }

    /* ───────── 样式（暗色低饱和；不用高亮绿/红/纯白） ───────── */
    const styles = {
      card: { border: '1px solid var(--dsw-alias-border,#3a3a3c)', borderRadius: 10, padding: '12px 14px', margin: '10px 0' },
      title: { fontWeight: 600, fontSize: 14, margin: 0 },
      hint: { fontSize: 12, color: 'var(--dsw-alias-text-tertiary,#8a8f98)', margin: '4px 0 0' },
      row: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 },
      input: { background: 'var(--dsw-alias-fill-secondary,rgba(255,255,255,.06))', color: 'inherit', border: '1px solid var(--dsw-alias-border,#3a3a3c)', borderRadius: 6, padding: '4px 8px', fontSize: 13 },
      btn: { border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 13, cursor: 'pointer', background: 'var(--dsw-alias-fill-secondary,rgba(255,255,255,.1))', color: 'inherit' },
      btnOn: { background: 'rgba(255,255,255,.14)', color: 'inherit', opacity: .9 },
      btnGhost: { border: '1px solid var(--dsw-alias-border,#3a3a3c)', borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer', background: 'transparent', color: 'inherit' },
      muted: { fontSize: 11, color: 'var(--dsw-alias-text-tertiary,#8a8f98)' },
      ok: { fontSize: 12, color: 'var(--dsw-alias-label-secondary,#b8bcc2)' },
      tabBar: { display: 'flex', gap: 6, flexWrap: 'wrap', margin: '12px 0 4px' },
      tab: { border: '1px solid var(--dsw-alias-border,#3a3a3c)', background: 'transparent', color: 'inherit', borderRadius: 999, padding: '6px 16px', fontSize: 13, cursor: 'pointer' },
      tabOn: { border: '1px solid rgba(124,92,255,.55)', background: 'rgba(124,92,255,.16)', color: 'inherit' },
      badge: { fontSize: 11, padding: '1px 8px', borderRadius: 999, border: '1px solid var(--dsw-alias-border,#3a3a3c)', color: 'var(--dsw-alias-label-secondary,#b8bcc2)' },
    }

    /* 自绘下拉的 CSS（悬停/选中/分组标题），挂一次、卸载清掉 */
    const PICKER_CSS = `
.djh-pick-btn{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;min-width:140px;max-width:100%;cursor:pointer;text-align:left;line-height:1.5}
.djh-pick-btn:disabled{opacity:.5;cursor:default}
.djh-pick-btn .djh-pick-caret{opacity:.5;font-size:10px;line-height:1}
.djh-pick-panel{position:fixed;z-index:1200;background:var(--dsw-alias-button-floating-fill,#242427);border:1px solid rgba(255,255,255,.12);border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.5);padding:4px;overflow-y:auto;overscroll-behavior:contain}
.djh-pick-row{display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;font-size:13px;color:var(--dsw-alias-label-primary,#f2f3f5);cursor:pointer;white-space:nowrap;overflow:hidden}
.djh-pick-row>span:last-child{overflow:hidden;text-overflow:ellipsis}
.djh-pick-row:hover{background:rgba(255,255,255,.07)}
.djh-pick-row[data-on="1"]{background:rgba(124,92,255,.16)}
.djh-pick-row[data-on="1"]:hover{background:rgba(124,92,255,.22)}
.djh-pick-tick{width:10px;flex:0 0 10px;font-size:11px;color:rgba(163,140,255,.9)}
.djh-pick-group{font-size:11px;color:var(--dsw-alias-text-tertiary,#8a8f98);padding:6px 10px 2px}
.djh-pick-empty{font-size:12px;color:var(--dsw-alias-text-tertiary,#8a8f98);padding:8px 10px}
`

    /* ───────── 深色下拉 ───────── */
    function Picker({ value, items, onPick, disabled, testId }) {
      const [open, setOpen] = useState(false)
      const [rect, setRect] = useState(null)
      const btnRef = useRef(null)
      const panelRef = useRef(null)
      const list = items || []
      const cur = list.filter((i) => i.value === value)[0]

      const place = () => {
        const b = btnRef.current
        if (!b) return
        const r = b.getBoundingClientRect()
        const vw = window.innerWidth
        const vh = window.innerHeight
        /* 水平夹住窗口、垂直留够空间（下面不够就翻到上面），手机窄屏也不会掉出屏幕 */
        const w = Math.max(180, Math.min(Math.max(r.width, 180), vw - 16))
        let left = r.left
        if (left + w > vw - 8) left = Math.max(8, vw - 8 - w)
        const below = vh - r.bottom - 12
        const above = r.top - 12
        let top
        let maxH
        if (below < 170 && above > below) {
          maxH = Math.max(120, Math.min(280, above - 4))
          top = r.top - maxH - 4
        } else {
          maxH = Math.max(120, Math.min(280, below))
          top = r.bottom + 4
        }
        setRect({ top: Math.round(top), left: Math.round(left), width: Math.round(w), maxH: Math.round(maxH) })
      }

      useEffect(() => {
        if (!open) return
        place()
        const onDown = (e) => {
          if (panelRef.current && panelRef.current.contains(e.target)) return
          if (btnRef.current && btnRef.current.contains(e.target)) return
          setOpen(false)
        }
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        /* 2026-11-19 修 bug（主人：「滚轮往下滑，它直接跳出去」）：
           scroll capture 会把**面板自己**的滚动也冒上来 → 面板里滚一下就被关掉。
           现在只处理面板外的滚动：跟着按钮重新定位，按钮滚出视口才收起。 */
        const onScroll = (e) => {
          const p = panelRef.current
          const t = e && e.target
          if (p && t && t.nodeType && p.contains(t)) return
          const b = btnRef.current
          if (!b) { setOpen(false); return }
          const r = b.getBoundingClientRect()
          if (r.bottom < 0 || r.top > window.innerHeight) { setOpen(false); return }
          place()
        }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onScroll)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onScroll)
        }
      }, [open])

      const groups = []
      for (const it of list) {
        const g = it.group || ''
        let bucket = groups.filter((x) => x.g === g)[0]
        if (!bucket) { bucket = { g, rows: [] }; groups.push(bucket) }
        bucket.rows.push(it)
      }

      return h('span', { style: { display: 'inline-block' } },
        h('button', {
          ref: btnRef, type: 'button', disabled: !!disabled,
          'data-djh-picker': testId || '', 'aria-haspopup': 'listbox', 'aria-expanded': open ? 'true' : 'false',
          className: 'djh-pick-btn',
          style: styles.input,
          onClick: () => setOpen((v) => !v),
        },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (cur && cur.label) || '（未选）'),
          h('span', { className: 'djh-pick-caret' }, '▾')),
        open && rect ? h('div', {
          ref: panelRef, className: 'djh-pick-panel', role: 'listbox',
          'data-djh-picker-panel': testId || '',
          style: { top: rect.top, left: rect.left, width: rect.width, maxHeight: rect.maxH || 280 },
        },
          list.length === 0 ? h('div', { className: 'djh-pick-empty' }, '（无可选项）') : null,
          groups.map((grp) => h('div', { key: 'g:' + grp.g },
            grp.g ? h('div', { className: 'djh-pick-group' }, grp.g) : null,
            grp.rows.map((it) => h('div', {
              key: it.value, role: 'option', 'data-on': it.value === value ? '1' : '0',
              className: 'djh-pick-row', title: it.label,
              onClick: () => { setOpen(false); if (it.value !== value) onPick(it.value) },
            },
              h('span', { className: 'djh-pick-tick' }, it.value === value ? '✓' : ''),
              h('span', null, it.label))))),
        ) : null,
      )
    }

    function useAudio() {
      const ref = useRef({ url: '', audio: null })
      return async function play(provider, voice, text, onState) {
        const a = ref.current
        onState('loading')
        try {
          if (a.audio) { try { a.audio.pause() } catch {} }
          if (a.url) { try { URL.revokeObjectURL(a.url) } catch {} }
          const r = await fetch(API, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: 'speak', provider, voice, text }),
          })
          if (!r.ok) {
            const j = await r.json().catch(() => null)
            throw new Error((j && j.error) || 'HTTP ' + r.status)
          }
          const blob = await r.blob()
          a.url = URL.createObjectURL(blob)
          a.audio = new Audio(a.url)
          a.audio.onended = () => onState('')
          a.audio.onerror = () => { onState(''); alert('音频播放失败') }
          await a.audio.play()
          onState('playing')
        } catch (e) {
          onState('')
          alert('试听失败：' + ((e && e.message) || e))
        }
      }
    }

    /* ───────── 一张来源卡（真组件：hooks 必须挂在组件上，教训：React #310） ───────── */
    function ProvCard(props) {
      const { p, entryKey, st, list, bal, use, busy, setBusy, play, onSelect, save, reloadBal, onRefreshVoices, models, aliModels, onAliModel } = props
      const entry = st.entries[entryKey] || {}
      const byP = entry.byProvider || {}
      const sel = byP[p.id] || (entry.provider === p.id ? entry.voice : '')
      const [pick, setPick] = useState('')
      const cur = pick || sel || (list[0] && list[0].id) || ''
      const live = entry.provider === p.id && entry.voice === cur
      const [aliasDraft, setAliasDraft] = useState('')
      const [newId, setNewId] = useState('')
      const [newAlias, setNewAlias] = useState('')
      const [breezeKey, setBreezeKey] = useState('')
      const [pMsg, setPMsg] = useState('')
      const [refreshing, setRefreshing] = useState(false)
      const aliasOf = (v) => (st.aliases[p.id] || {})[v] || ''
      useEffect(() => { setAliasDraft(aliasOf(cur)) }, [cur, st.aliases])

      const title = p.emoji + ' ' + p.label
      const usedHere = entry.provider === p.id

      return h('div', { key: p.id, style: styles.card, 'data-djh-prov': p.id },
        h('div', { style: { ...styles.title, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          title,
          h('span', { style: styles.muted }, st.keysOk[p.id] ? '· 已就绪' : '· 未配 Key'),
          usedHere ? h('span', { style: styles.badge }, '当前使用') : null,
          h('span', { style: { flex: 1 } }),
          bal
            ? h('span', { style: styles.muted, 'data-djh-bal': p.id },
                bal.ok ? '余额 ' + bal.text : '余额 ' + (bal.error || '查不到'))
            : h('span', { style: styles.muted }, '余额 …'),
          h('button', {
            style: { ...styles.btnGhost, padding: '1px 6px' }, title: '重新查询余额',
            onClick: () => reloadBal(p.id),
          }, '↻'),
          pMsg ? h('span', { style: styles.ok }, pMsg) : null),

        /* 上次播报消耗（主人要的「这次播报花了多少」） */
        h('div', { style: styles.hint, 'data-djh-usage': p.id },
          use ? ('上次播报：' + use.chars + ' 字 · ' + use.costText) : '上次播报：—'),

        p.id === 'aliyun' && Array.isArray(aliModels) && aliModels.length
          ? h('div', { style: styles.row },
              h('span', { style: styles.muted }, '🧠 合成模型：'),
              h(Picker, {
                testId: 'ali-model:' + entryKey, value: (models && models.aliyun) || 'cosyvoice-v2',
                items: aliModels.map((m) => ({ value: m.id, label: m.label })),
                onPick: (m) => onAliModel(m),
              }),
              h('span', { style: styles.muted }, '（音色跟模型走：v2 用 _v2 音色，v3 用新命名）'))
          : null,
        p.id === 'breeze' && !st.keysOk.breeze
          ? h('div', { style: styles.row },
              h('input', { style: styles.input, placeholder: '粘贴 brz_ 开头的 API Key（breezeblue.ai → 开发者 → API Keys）', value: breezeKey, onChange: (ev) => setBreezeKey(ev.target.value) }),
              h('button', {
                style: styles.btn, onClick: async () => {
                  try { await api({ op: 'setBreezeKey', key: breezeKey.trim() }); setPMsg('✅ Key 已保存'); setBreezeKey(''); reloadBal && reloadBal(p.id) }
                  catch (e) { alert(((e && e.message) || e)) }
                },
              }, '保存 Key'))
          : h('div', null,
            h('div', { style: styles.row },
              h(Picker, {
                testId: 'prov-voice:' + entryKey + ':' + p.id, value: cur, items: list.map((v) => ({
                  value: v.id,
                  label: aliasOf(v.id) ? aliasOf(v.id) + '（' + (v.name || v.id) + '）' : (v.name || v.id),
                  group: v.group || '其他',
                })),
                onPick: (v) => setPick(v),
              }),
              h('button', {
                style: { ...styles.btn, ...(busy === p.id + ':' + cur ? styles.btnOn : {}) },
                onClick: () => play(p.id, cur, '你好主人，这是' + (aliasOf(cur) || '当前') + '的声音，可以随时换我哦。', (s) => setBusy(s ? p.id + ':' + cur : '')),
              }, busy === p.id + ':' + cur ? '⏳' : '▶ 试听'),
              h('button', {
                style: live ? { ...styles.btnGhost, opacity: .7, cursor: 'default' } : { ...styles.btn, background: 'rgba(124,92,255,.22)' },
                disabled: live,
                'data-djh-apply': p.id,
                title: live ? '这个音色正在用' : '点一下把它设成这个入口的播报音色',
                onClick: () => { if (!live) onSelect(p.id, cur) },
              }, live ? '✓ 正在用' : '✅ 用这个播报（' + ENTRY_SHORT[entryKey] + '）')),
            h('div', { style: styles.row },
              h('input', { style: styles.input, placeholder: '别名（给这个音色起个好记的名字）', value: aliasDraft, onChange: (ev) => setAliasDraft(ev.target.value) }),
              h('button', {
                style: styles.btn, onClick: async () => {
                  const aliases = { ...st.aliases, [p.id]: { ...(st.aliases[p.id] || {}), [cur]: aliasDraft.trim() } }
                  await save({ aliases })
                  setPMsg('✅ 别名已保存'); setTimeout(() => setPMsg(''), 2000)
                },
              }, '💾 保存别名'),
              aliasOf(cur) && h('button', {
                style: styles.btn, onClick: async () => {
                  const next = { ...st.aliases[p.id] }; delete next[cur]
                  await save({ aliases: { ...st.aliases, [p.id]: next } }); setAliasDraft('')
                },
              }, '🗑 删别名')),

            /* 我的音色：从官网拉真实音色列表（Breeze 的 design/clone 音色、各家复刻音色） */
            h('div', { style: styles.row },
              h('span', { style: styles.muted }, '🌐 我的音色：'),
              h('button', {
                style: styles.btnGhost, disabled: refreshing,
                'data-djh-refresh-voices': p.id,
                onClick: async () => {
                  setRefreshing(true)
                  try {
                    const r = await onRefreshVoices(p.id)
                    setPMsg(r || '✅ 已刷新'); setTimeout(() => setPMsg(''), 4000)
                  } catch (e) { setPMsg('⚠ ' + ((e && e.message) || e)); setTimeout(() => setPMsg(''), 5000) }
                  setRefreshing(false)
                },
              }, refreshing ? '⏳ 拉取中…' : '↻ 从官网刷新'),
              h('span', { style: styles.muted }, '（拉到的音色直接进上面的下拉，分组「官网音色」）')),

            h('div', { style: styles.row },
              h('input', { style: styles.input, placeholder: '手动加音色 ID（如火山 S_xxx）', value: newId, onChange: (ev) => setNewId(ev.target.value) }),
              h('input', { style: styles.input, placeholder: '别名（如 呱呱）', value: newAlias, onChange: (ev) => setNewAlias(ev.target.value) }),
              h('button', {
                style: styles.btn, onClick: async () => {
                  if (!newId.trim()) return
                  const item = { id: newId.trim(), alias: newAlias.trim() || newId.trim() }
                  const custom = { ...st.custom, [p.id]: [...(st.custom[p.id] || []), item] }
                  await save({ custom })
                  setNewId(''); setNewAlias(''); setPMsg('✅ 已添加'); setTimeout(() => setPMsg(''), 2000)
                },
              }, '＋ 添加')),
            (st.custom[p.id] || []).length > 0 && h('div', { style: styles.row },
              ...st.custom[p.id].map((c) => h('button', {
                key: c.id, style: { ...styles.btn, fontSize: 12 },
                onClick: async () => {
                  const custom = { ...st.custom, [p.id]: st.custom[p.id].filter((x) => x.id !== c.id) }
                  await save({ custom })
                },
              }, '✕ ' + (aliasOf(c.id) || c.alias || c.id)))))
      )
    }

    /* ───────── 主组件 ───────── */
    function TtsSection() {
      const [st, setSt] = useState(null) // {entries,aliases,custom,keysOk}
      const [voices, setVoices] = useState({}) // provider → [voice]
      const [bals, setBals] = useState({}) // provider → {ok,text|error}
      const [usage, setUsage] = useState({ last: null, lastByProvider: {}, byProvider: {} })
      const [models, setModels] = useState({})
      const [tab, setTab] = useState('chat')
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const playRaw = useAudio()
      /* 试听完顺手把「上次播报花费」刷新出来（否则要刷新页面才看到） */
      const play = async (provider, voice, text, onState) => {
        try { await playRaw(provider, voice, text, onState) } finally {
          try { const j = await api({ op: 'state' }); if (j && j.usage) setUsage(j.usage) } catch {}
        }
      }

      const loadBalances = async (only) => {
        try {
          const j = await api({ op: 'balances', provider: only || '' })
          setBals((old) => ({ ...old, ...(j.providers || {}) }))
        } catch {}
      }

      const reload = async () => {
        try {
          const j = await api({ op: 'state' })
          setSt(j)
          setModels(j.models || {})
          setUsage(j.usage || { last: null, lastByProvider: {}, byProvider: {} })
          for (const p of PROVIDERS) {
            if (p.id === 'breeze' && !j.keysOk.breeze) continue
            api({ op: 'voices', provider: p.id, model: p.id === 'aliyun' ? (j.models || {}).aliyun : '' }).then((v) => setVoices((old) => ({ ...old, [p.id]: v.voices }))).catch(() => {})
          }
          loadBalances()
        } catch (e) { setMsg('加载失败：' + ((e && e.message) || e)) }
      }
      useEffect(() => { reload() }, [])

      const save = async (patch) => {
        try {
          await api({ op: 'save', ...patch })
          setMsg('✅ 已保存')
          setTimeout(() => setMsg(''), 2000)
        } catch (e) { setMsg('保存失败：' + ((e && e.message) || e)) }
      }

      const refreshVoices = async (pid) => {
        const j = await api({ op: 'voices', provider: pid, refresh: true, model: pid === 'aliyun' ? models.aliyun : '' })
        setVoices((old) => ({ ...old, [pid]: j.voices }))
        if (j.remote && j.remote.ok === false) throw new Error(j.remote.error || '拉取失败')
        const n = (j.voices || []).filter((v) => (v.group || '').indexOf('官网') >= 0).length
        return n ? ('✅ 从官网拉到 ' + n + ' 个音色') : '✅ 已刷新（这家没有可拉的官网音色）'
      }

      if (!st) return h('div', { style: styles.hint }, '加载中…')

      const voiceList = (p) => [
        ...(voices[p] || []),
        ...(st.custom[p] || []).map((c) => ({ id: c.id, name: (st.aliases[p] || {})[c.id] || c.alias || c.id, group: '⭐ 手动添加', custom: true })),
      ]
      const nameOf = (p, v) => (st.aliases[p] || {})[v] || ((voiceList(p).filter((x) => x.id === v)[0] || {}).name || v)

      const setAliModel = async (model) => {
        const next = { ...models, aliyun: model }
        setModels(next)
        setVoices((old) => ({ ...old, aliyun: [] }))
        await save({ models: next })
        try { const v = await api({ op: 'voices', provider: 'aliyun' }); setVoices((old) => ({ ...old, aliyun: v.voices })) } catch {}
        setMsg('✅ 阿里合成模型切到 ' + model + '（音色目录已换成该模型的）')
        setTimeout(() => setMsg(''), 3500)
      }

      const select = async (entryKey, provider, voice) => {
        const prev = st.entries[entryKey] || {}
        const entries = {
          ...st.entries,
          [entryKey]: { ...prev, provider, voice, byProvider: { ...(prev.byProvider || {}), [provider]: voice } },
        }
        setSt({ ...st, entries })
        await save({ entries })
        const pname = (PROVIDERS.filter((x) => x.id === provider)[0] || {}).label || provider
        setMsg('✅ 已设为「' + ENTRY_SHORT[entryKey] + '」播报音色：' + pname + ' · ' + nameOf(provider, voice))
        setTimeout(() => setMsg(''), 3000)
      }

      const e = st.entries[tab]
      const curUse = usage.lastByProvider && usage.lastByProvider[e.provider]

      return h('div', { 'data-dsh-tts': '1', style: { padding: '4px 0 24px', maxWidth: 900 } },
        h('h3', { style: { fontSize: 16, margin: '8px 0 4px' } }, '🎙 TTS 语音'),
        h('div', { style: styles.hint }, '四家语音来源 × 两个播报入口。每个音色都能试听、起别名；两个入口各存一份选择，互不影响。'),
        msg && h('div', { style: styles.ok }, msg),

        /* ① 两个子页签 */
        h('div', { style: styles.tabBar, role: 'tablist' },
          ['chat', 'orb'].map((k) => h('button', {
            key: k, role: 'tab', 'data-djh-tts-tab': k,
            'aria-selected': tab === k ? 'true' : 'false',
            style: { ...styles.tab, ...(tab === k ? styles.tabOn : {}) },
            onClick: () => setTab(k),
          }, ENTRY_LABEL[k]))),

        /* ② 当前入口的摘要 */
        h('div', { style: styles.card },
          h('div', { style: { ...styles.title, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            '当前用：',
            (PROVIDERS.filter((p) => p.id === e.provider)[0] || {}).emoji || '',
            (PROVIDERS.filter((p) => p.id === e.provider)[0] || {}).label || e.provider,
            ' · ',
            nameOf(e.provider, e.voice) || '（未选）'),
          h('div', { style: styles.row },
            h('button', {
              style: { ...styles.btn, ...(busy === 'sum' ? styles.btnOn : {}) },
              onClick: () => play(e.provider, e.voice, '你好主人，这是' + (nameOf(e.provider, e.voice) || '当前') + '的声音，' + ENTRY_LABEL[tab].replace(/[^\u4e00-\u9fff]/g, '') + '就用我啦。', (s) => setBusy(s ? 'sum' : '')),
            }, busy === 'sum' ? '⏳ 合成中…' : '▶ 试听这个入口'),
            h('span', { style: styles.muted }, '这个入口播报时就用上面这套「来源 + 音色」')),
          h('div', { style: styles.hint, 'data-djh-last': '1' },
            curUse
              ? ('上次播报（' + (ENTRY_SHORT[curUse.entry] || curUse.entry || '') + '）：' + curUse.chars + ' 字 · ' + curUse.costText)
              : '上次播报：还没有记录')),

        /* ③ 四家来源卡（每张卡选中的音色 = 这个入口要用的） */
        PROVIDERS.map((p) => h(ProvCard, {
          key: tab + ':' + p.id, p, entryKey: tab, st,
          list: voiceList(p.id),
          bal: bals[p.id],
          use: usage.lastByProvider && usage.lastByProvider[p.id],
          busy, setBusy, play,
          onSelect: (pid, v) => select(tab, pid, v),
          save, reloadBal: (pid) => loadBalances(pid),
          onRefreshVoices: refreshVoices,
          models, aliModels: (st.aliModels || []), onAliModel: setAliModel,
        })),

        h('div', { style: styles.hint }, '余额：DeepSeek / 火山云 / 阿里云 走各自账户接口（实测余额），Breeze 走积分接口；' +
          '「上次播报」按字数和各家公开单价估算，Breeze 按官方权重（中日韩字符=2、其他=1，10 权重=1 积分）精确算。'),
      )
    }

    const DICT = { zh: { 'section.label': 'TTS 语音' }, en: { 'section.label': 'TTS Voice' } }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('ttsVoice', DICT))
        const t = (k) => { try { const v = ctx.locale.bind('ttsVoice')(k); return v == null ? k : String(v) } catch { return k } }

        /* 自绘下拉的样式：注入一次，卸载清掉（教训40：注入必须自带清理） */
        ctx.effect(() => {
          document.querySelectorAll('#djh-tts-picker-css').forEach((n) => n.remove())
          const css = document.createElement('style')
          css.id = 'djh-tts-picker-css'
          css.textContent = PICKER_CSS
          document.head.appendChild(css)
          return () => { css.remove() }
        })

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'tts-voice', order: 11, label: () => t('section.label') },
            () => h(TtsSection),
          ),
        )

        // 2026-11-19 主人要求：删掉「内置插件」栏目 —— 直接隐藏设置导航里那一行（含 body）
        const hideCss = document.createElement('style')
        hideCss.textContent = '[data-djh-hide-builtin]{display:none!important}'
        document.head.appendChild(hideCss)
        ctx.effect(() => () => hideCss.remove())
        const hideBuiltin = () => {
          document.querySelectorAll('span').forEach((s) => {
            if ((s.textContent || '').trim() !== '内置插件') return
            const row = s.closest('[class*="_cell"],[role="menuitem"],button,li,div[class*="_item"]')
            if (row) row.setAttribute('data-djh-hide-builtin', '')
          })
        }
        const mo = new MutationObserver(hideBuiltin)
        mo.observe(document.body, { childList: true, subtree: true })
        hideBuiltin()
        ctx.effect(() => () => mo.disconnect())
      },
    }
  },
})
