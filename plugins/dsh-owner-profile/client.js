/**
 * 主人画像（Client 半）—— 设置 › 主人画像 分区。
 *
 * 样式学小 DJ 的主人画像页：左侧一级导航（维度）+ 右侧二级内容（条目卡片）。
 * 支持增删改查：编辑模式下可改条目、删条目、加条目、增删维度，保存走 Host。
 * 数据与鸿蒙 PC 小 DJ 的主人画像是同一份（两边同步更新）。
 * 更新制度：AI 会话中发现新偏好主动提议入画像；改动自动记 changelog；
 * 每 30 天 AI 主动回顾修订。页面只读模式展示，编辑模式改。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-owner-profile',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect

    const DIM_TITLES = {
      identity: '身份与称呼',
      style: '沟通与风格',
      decide: '决策与协作',
      tech: '技术与环境',
      projects: '项目与事业',
      interests: '兴趣与关注',
      learning: '学习方式',
      phrases: '口头禅与触发词',
      rhythm: '作息与节奏',
      redline: '红线与关怀点',
    }

    const S = {
      shell: { display: 'flex', gap: 14, alignItems: 'stretch' },
      nav: {
        flex: '0 0 148px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '4px 0',
      },
      navBtn: {
        textAlign: 'left',
        font: 'inherit',
        fontSize: 12,
        padding: '7px 10px',
        borderRadius: 10,
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      },
      navBtnOn: {
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600,
      },
      navCount: {
        fontSize: 10.5,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 10,
        padding: '0 6px',
        marginLeft: 'auto',
      },
      main: { flex: '1 1 auto', minWidth: 0 },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11.5, lineHeight: '17px', marginBottom: 10 },
      toolbar: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' },
      btn: {
        font: 'inherit',
        fontSize: 12,
        padding: '5px 12px',
        borderRadius: 9,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      btnPrimary: {
        font: 'inherit',
        fontSize: 12,
        padding: '5px 14px',
        borderRadius: 9,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        cursor: 'pointer',
        fontWeight: 600,
      },
      btnGhost: {
        font: 'inherit',
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      btnWarn: { color: 'var(--dsw-alias-state-error-primary)' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, marginBottom: 8 },
      dimTitle: { fontSize: 13.5, fontWeight: 600, margin: '0 0 8px' },
      item: {
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        padding: '10px 14px',
        marginBottom: 8,
      },
      itemText: { fontSize: 12.5, lineHeight: '19px', whiteSpace: 'pre-wrap' },
      meta: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' },
      badge: {
        fontSize: 10.5,
        padding: '1px 7px',
        borderRadius: 20,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      itemActs: { display: 'flex', gap: 4, marginLeft: 'auto' },
      editor: {
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 12,
        padding: '10px 12px',
        marginBottom: 8,
      },
      ta: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: 12.5,
        lineHeight: '19px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '8px 10px',
        resize: 'vertical',
        minHeight: 56,
      },
      inp: {
        font: 'inherit',
        fontSize: 12,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '5px 9px',
        width: 200,
        boxSizing: 'border-box',
      },
      addCard: {
        width: '100%',
        textAlign: 'center',
        font: 'inherit',
        fontSize: 12,
        padding: '9px 0',
        borderRadius: 12,
        border: '1px dashed var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
    }

    const mkItem = () => ({ text: '', source: '', confidence: 0.95, status: 'confirmed', updated: Date.now() })

    function ProfileSection() {
      const [remote, setRemote] = useState(null)
      const [draft, setDraft] = useState(null) // 编辑中的整份画像
      const [active, setActive] = useState('')
      const [error, setError] = useState('')
      const [editing, setEditing] = useState(null) // {dim, idx} 编辑中的条目
      const [dimEditing, setDimEditing] = useState(false) // 维度改名中
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let alive = true
        fetch('/owner-profile-api', { credentials: 'same-origin' })
          .then((r) => {
            if (!r.ok) throw new Error('HTTP ' + r.status)
            return r.json()
          })
          .then((body) => {
            if (!alive) return
            if (!body || body.ok !== true) throw new Error('bad response')
            setRemote(body.value)
            const dims = (body.value && body.value.dimensions) || []
            if (dims.length && !dims.some((d) => d.id === active)) setActive(dims[0].id)
          })
          .catch((e) => alive && setError(String(e && e.message ? e.message : e)))
        return () => {
          alive = false
        }
      }, [])

      const editing_ = draft != null
      const data = editing_ ? draft : remote
      const dims = (data && data.dimensions) || []
      const dim = dims.find((d) => d.id === active) || dims[0]
      const dirty = editing_ && remote != null && JSON.stringify(draft) !== JSON.stringify(remote)

      const dimTitle = (d) => (d && d.title) || DIM_TITLES[d && d.id] || (d ? d.id : '')

      function beginEdit() {
        setDraft(JSON.parse(JSON.stringify(remote || { version: 1, dimensions: [] })))
      }
      function cancelEdit() {
        setDraft(null)
        setEditing(null)
        setDimEditing(false)
      }
      function setDims(fn) {
        setDraft((cur) => JSON.parse(JSON.stringify({ ...cur, dimensions: fn(cur.dimensions || []) })))
      }
      async function save() {
        setBusy(true)
        setError('')
        try {
          const res = await fetch('/owner-profile-api', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'save', action: '设置页编辑', value: draft }),
          })
          const body = await res.json()
          if (!res.ok || !body || body.ok !== true) throw new Error(body && body.error ? body.error.message : 'HTTP ' + res.status)
          setRemote(body.value)
          setDraft(null)
          setEditing(null)
          setDimEditing(false)
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { style: { padding: '2px 0 24px' }, 'data-owner-profile': 'root' },
        h(
          'div',
          { style: S.hint },
          '统一主人画像：159 个会话 / 122 万字全量提炼（2026-11-16），与鸿蒙 PC 小 DJ 保持同一份。更新制度：AI 发现新偏好会主动提议入画像，改动自动记档，每 30 天回顾一次——画像跟着主人走，不一成不变。',
        ),
        error ? h('div', { style: S.error }, '出错了：' + error) : null,
        h(
          'div',
          { style: S.toolbar },
          editing_
            ? [
                h('button', { key: 'save', type: 'button', style: dirty ? S.btnPrimary : S.btn, disabled: busy || !dirty, onClick: save }, busy ? '保存中…' : dirty ? '💾 保存改动' : '无改动'),
                h('button', { key: 'cancel', type: 'button', style: S.btn, disabled: busy, onClick: cancelEdit }, '放弃'),
                h('span', { key: 'tip', style: S.hint }, '改动在点「保存」后才写入文件并自动备份 + 记档'),
              ]
            : h('button', { key: 'edit', type: 'button', style: S.btn, onClick: beginEdit }, '✏️ 编辑（增删改）'),
        ),
        remote == null && !error
          ? h('div', { style: S.hint, padding: '18px 0' }, '加载中…')
          : null,
        data != null
          ? h(
              'div',
              { style: S.shell, className: 'dsh-owner-profile-shell' },
              // ── 一级导航：维度 ──
              h(
                'div',
                { style: S.nav, 'data-owner-profile': 'nav' },
                dims.map((d) =>
                  h(
                    'button',
                    {
                      key: d.id,
                      type: 'button',
                      style: d.id === (dim && dim.id) ? { ...S.navBtn, ...S.navBtnOn } : S.navBtn,
                      onClick: () => {
                        setActive(d.id)
                        setEditing(null)
                        setDimEditing(false)
                      },
                    },
                    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, dimTitle(d)),
                    h('span', { style: S.navCount }, String((d.items || []).length)),
                  ),
                ),
                editing_
                  ? h('button', {
                      key: '__add',
                      type: 'button',
                      style: { ...S.navBtn, color: 'var(--dsw-alias-label-secondary)' },
                      onClick: () => {
                        const n = dims.length + 1
                        const id = 'dim-' + Date.now().toString(36)
                        setDims((arr) => arr.concat([{ id, title: '新维度 ' + n, items: [] }]))
                        setActive(id)
                      },
                    }, '＋ 新维度')
                  : null,
              ),
              // ── 二级内容：条目 ──
              h(
                'div',
                { style: S.main, 'data-owner-profile': 'main' },
                !dim
                  ? h('div', { style: S.hint }, '还没有维度，点「编辑」添加第一个')
                  : [
                      dimEditing
                        ? h(
                            'div',
                            { key: 't', style: { ...S.dimTitle, display: 'flex', gap: 6, alignItems: 'center' } },
                            h('input', {
                              style: S.inp,
                              value: dimTitle(dim),
                              onChange: (e) => setDims((arr) => arr.map((d) => (d.id === dim.id ? { ...d, title: e.target.value } : d))),
                            }),
                            h('button', { type: 'button', style: S.btnGhost, onClick: () => setDimEditing(false) }, '✓ 名称'),
                            editing_
                              ? h('button', {
                                  key: 'deldim',
                                  type: 'button',
                                  style: { ...S.btnGhost, ...S.btnWarn },
                                  onClick: () => {
                                    setDims((arr) => arr.filter((d) => d.id !== dim.id))
                                    const rest = dims.filter((d) => d.id !== dim.id)
                                    setActive(rest.length ? rest[0].id : '')
                                  },
                                }, '🗑 删整个维度')
                              : null,
                          )
                        : h(
                            'div',
                            {
                              key: 't',
                              style: { ...S.dimTitle, cursor: editing_ ? 'pointer' : 'default' },
                              onClick: () => editing_ && setDimEditing(true),
                              title: editing_ ? '点击改名' : '',
                            },
                            dimTitle(dim) + (editing_ ? '（点我改名）' : ''),
                          ),
                      (dim.items || []).map((item, i) =>
                        editing && editing.dim === dim.id && editing.idx === i
                          ? h(
                              'div',
                              { key: i, style: S.editor },
                              h('textarea', {
                                style: S.ta,
                                value: item.text,
                                onChange: (e) => setDims((arr) => arr.map((d) => (d.id === dim.id ? { ...d, items: d.items.map((it, j) => (j === i ? { ...it, text: e.target.value } : it)) } : d))),
                              }),
                              h(
                                'div',
                                { style: { ...S.meta, marginTop: 8 } },
                                h('input', {
                                  style: S.inp,
                                  placeholder: '来源（如 主人原话 / 观察）',
                                  value: item.source || '',
                                  onChange: (e) => setDims((arr) => arr.map((d) => (d.id === dim.id ? { ...d, items: d.items.map((it, j) => (j === i ? { ...it, source: e.target.value } : it)) } : d))),
                                }),
                                h('span', { style: { flex: '1 1 auto' } }),
                                h('button', { type: 'button', style: S.btn, onClick: () => setEditing(null) }, '取消'),
                                h('button', { type: 'button', style: S.btnPrimary, onClick: () => setEditing(null) }, '✓ 完成'),
                              ),
                            )
                          : h(
                              'div',
                              { key: i, style: S.item },
                              h('div', { style: S.itemText }, item.text),
                              h(
                                'div',
                                { style: S.meta },
                                item.source ? h('span', { style: S.badge }, item.source) : null,
                                item.status === 'pending' ? h('span', { style: S.badge }, '待确认') : null,
                                editing_
                                  ? h(
                                      'span',
                                      { style: S.itemActs },
                                      h('button', { type: 'button', style: S.btnGhost, onClick: () => setEditing({ dim: dim.id, idx: i }) }, '✏️'),
                                      h('button', {
                                        type: 'button',
                                        style: { ...S.btnGhost, ...S.btnWarn },
                                        onClick: () => setDims((arr) => arr.map((d) => (d.id === dim.id ? { ...d, items: d.items.filter((_, j) => j !== i) } : d))),
                                      }, '🗑'),
                                    )
                                  : null,
                              ),
                            ),
                      ),
                      editing_
                        ? h('button', {
                            key: 'add',
                            type: 'button',
                            style: S.addCard,
                            onClick: () => {
                              setDims((arr) => arr.map((d) => (d.id === dim.id ? { ...d, items: (d.items || []).concat([mkItem()]) } : d)))
                              setEditing({ dim: dim.id, idx: (dim.items || []).length })
                            },
                          }, '＋ 添加条目')
                        : null,
                    ],
              ),
            )
          : null,
        h(
          'style',
          { key: 'css' },
          // 手机窄屏：一级导航变横向滚动条
          '@media (max-width: 899px){.dsh-owner-profile-shell{flex-direction:column;gap:8px}.dsh-owner-profile-shell>div:first-child{flex-direction:row;overflow-x:auto;flex:0 0 auto;padding-bottom:4px}}',
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'owner-profile',
              order: 2,
              label: () => '主人画像',
            },
            () => h(ProfileSection),
          ),
        )
      },
    }
  },
})
