/**
 * 并行子代理进度面板（Host 半）—— 只做一件事：
 * 把当前所有活 agent（含队友/子代理）的实时名册吐给前端 /agent-progress-api。
 *
 * 数据源全是宿主内存态（ctx.agents.list() + ctx.agentTeams），每次请求现查，
 * 没有缓存没有轮询——刷新频率由前端自己定（面板可见时 2s 一次）。
 */
export const name = '@local/dsh-agent-progress'
export const inject = ['agents', 'agentTeams', 'connection', 'webServer']

const ROUTE = '/agent-progress-api'

/** 安全读一个 agent 的字段（字段名来自 dsh-experimental-agent-team 的用法） */
function rowOf(agent) {
  const header = agent?.session?.header ?? {}
  return {
    id: agent.id,
    status: agent.status === 'running' ? 'running' : 'inactive',
    model: agent.options?.model ?? undefined,
    title: header.title ?? undefined,
    parent: header.parentSession ?? undefined,
  }
}

function snapshot(ctx) {
  const agents = ctx.agents.list()
  const byId = new Map(agents.map((a) => [a.id, a]))
  const roots = []
  const children = []
  for (const a of agents) {
    const row = rowOf(a)
    if (row.parent && byId.has(row.parent)) children.push(row)
    else if (!row.parent) roots.push(row)
    /* 父会话不在线的孤儿子代理也当根展示，别丢行 */
    else roots.push(row)
  }
  /* 队伍名册：lead 用 agentTeams.listMembers 拿队友名字/角色/失败原因 */
  for (const root of roots) {
    const agent = byId.get(root.id)
    let members = null
    try {
      const m = ctx.agentTeams.tryMembership(agent)
      if (m && m.role === 'lead') members = ctx.agentTeams.listMembers(agent)
    } catch {
      /* 没开 agent teams 或不是 lead —— 当普通会话行 */
    }
    if (Array.isArray(members)) {
      root.team = members.map((mem) => ({
        id: mem.id,
        name: mem.name,
        role: mem.role,
        status: mem.status,
        model: mem.model,
        description: mem.description,
        error: mem.diagnostics && mem.diagnostics.length ? String(mem.diagnostics[0]) : undefined,
      }))
    }
    root.children = children
      .filter((c) => c.parent === root.id)
      .map((c) => {
        const mem = root.team && root.team.find((t) => t.id === c.id)
        return mem ? { ...c, name: mem.name, status: mem.status === 'running' ? 'running' : mem.status } : c
      })
  }
  return { roots, at: Date.now() }
}

export function apply(ctx) {
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
        let value
        try {
          value = snapshot(ctx)
        } catch (e) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, value }))
      },
    }),
  )
}
