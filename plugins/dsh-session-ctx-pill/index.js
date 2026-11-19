/**
 * 会话行上下文百分比（Host 半）—— 移植自 little DJ 的 task189：
 *
 *   左侧会话列表每一行后面跟一颗「42%」小胶囊，代表这条会话「下一次请求会把
 *   多少上下文喂给模型」。点不出来、不点也没有副作用，纯只读。
 *
 * 口径（DSH 原生投影，不自己算 token）：
 *   - 分子：`contextPressure.projectedTokens ?? pressureTokens`
 *     （最近一次请求实际读入的 prompt tokens，含缓存命中；加上此后对话的增量）
 *   - 分母：`contextPressure.contextWindow`（该会话模型自报的窗口）
 *   - 百分比 = min(100, round(used / win * 100))
 *
 * 数据源分两条路（和官方会话列表一致）：
 *   - 活着的会话：`sessionProjections.snapshot(session, ['contextPressure'])`（实时）
 *   - 已落盘的会话：`sessionProjectionCache.cachedSnapshot(header, ['contextPressure'])`
 *     这是官方列表行用的同一个零 I/O 读口，值可能落后一个 checkpoint，但不会错。
 *
 * 接口：POST /session-ctx-api/state  →  { ok, value: { at, map: { [sessionId]: {pct, used, win} } } }
 *       缺源（没有 request/context 或还没跑过一轮）的会话不出现在 map 里 —— 缺源不编数。
 */
export const name = '@local/dsh-session-ctx-pill'
export const inject = ['connection', 'webServer', 'sessions', 'sessionPersistence', 'sessionProjections']

const ROUTE = '/session-ctx-api'
const LIST_CACHE_MS = 10000
const KEY = 'contextPressure'

export function apply(ctx) {
  let listCache = { at: 0, snapshots: null }

  async function storedSnapshots() {
    if (listCache.snapshots && Date.now() - listCache.at < LIST_CACHE_MS) return listCache.snapshots
    const snapshots = await ctx.sessionPersistence.list()
    listCache = { at: Date.now(), snapshots }
    return snapshots
  }

  /** 一条会话的上下文占用；拿不到返回 null（不猜数）。 */
  function pressureOf(session, header) {
    const projections = ctx.get('sessionProjections')
    if (!projections) return null
    let values
    try {
      if (session) {
        values = projections.snapshot(session, [KEY]).values
      } else {
        const cache = ctx.get('sessionProjectionCache')
        if (!cache) return null
        values = cache.cachedSnapshot(header, [KEY])?.values
      }
    } catch {
      return null
    }
    const p = values && values[KEY]
    if (!p) return null
    const used = p.projectedTokens ?? p.pressureTokens
    const win = p.contextWindow
    if (!(used > 0) || !(win > 0)) return null
    return { pct: Math.min(100, (used / win) * 100), used, win }
  }

  async function snapshot() {
    const map = {}
    const seen = new Set()
    let snapshots = []
    try {
      snapshots = await storedSnapshots()
    } catch {
      snapshots = []
    }
    for (const snap of snapshots) {
      const id = snap.header.id
      seen.add(id)
      const live = ctx.sessions.get(id)
      const info = pressureOf(live, snap.header)
      if (info) map[id] = info
    }
    // 还没落盘的活会话（刚建、还没 flush 的）也补上
    for (const live of ctx.sessions.list()) {
      if (seen.has(live.id)) continue
      const info = pressureOf(live, live.header)
      if (info) map[live.id] = info
    }
    return { at: Date.now(), map }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        const admission = ctx.connection.admit({ headers: req.headers })
        if ('rejection' in admission) {
          res.writeHead(admission.rejection, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('method not allowed')
          return
        }
        let endpoint = ''
        try {
          endpoint = new URL(req.url || '/', 'http://localhost').pathname.slice(ROUTE.length + 1)
        } catch {
          endpoint = ''
        }
        // 读掉请求体（前端固定发 {}），顺便防大包
        try {
          let size = 0
          for await (const chunk of req) {
            size += chunk.length
            if (size > 16 * 1024) throw new Error('请求体过大')
          }
        } catch {
          /* 忽略：本接口不吃 payload */
        }
        let value
        try {
          if (endpoint === 'state') value = await snapshot()
          else throw new Error('未知接口：' + String(endpoint))
        } catch (e) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String((e && e.message) || e) } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, value }))
      },
    }),
  )
}
