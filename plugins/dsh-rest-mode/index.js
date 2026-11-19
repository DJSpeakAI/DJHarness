/**
 * 休息模式（Host 半）—— 移植 little DJ 输入框里的 ☾ 休息态：
 *
 *   在线  = AI 不懂就问（ask_user_question 多问主人）
 *   休息中 = 主人已授权：别问，按自己的理解和推荐直接决断并推进
 *
 * 真相在宿主：状态存 $DSH_HOME/storages/rest-mode.json（多端、多会话共用一份），
 * 每轮请求组装系统提示词时动态求值（ctx.systemPrompt.context），
 * 所以切换后**下一轮**立即生效，不需要重启、不需要主人再说一遍。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = '@local/dsh-rest-mode'
export const inject = ['connection', 'webServer', 'systemPrompt']

const ROUTE = '/rest-mode-api'
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(HOME, 'storages')
const STATE_FILE = path.join(STATE_DIR, 'rest-mode.json')

/** 唯一真相（内存镜像，落盘持久）。 */
let state = { on: false, since: 0 }

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    state = { on: raw && raw.on === true, since: Number(raw && raw.since) || 0 }
  } catch {
    state = { on: false, since: 0 }
  }
}

function saveState() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ on: state.on, since: state.since, updatedAt: Date.now() }, null, 2),
      'utf8',
    )
  } catch {
    /* 写盘失败不影响内存态，只是重启后丢状态 */
  }
}

function hhmm(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

/** 注入系统提示词的那段话：主人点了休息模式就换成自主决断口径。 */
function renderModeText() {
  if (state.on) {
    return [
      '【当前模式：休息中' + (state.since ? '（' + hhmm(state.since) + ' 起）' : '') + '】',
      '主人已授权你自主推进：不要用 ask_user_question 打断他。遇到不确定的地方，按你自己的理解和推荐直接决定并执行。',
      '如果有明显取舍，在回复结尾用一行「自主决定：……」说明你选了什么、为什么。',
    ].join('\n')
  }
  return [
    '【当前模式：在线】',
    '主人要你主动沟通：不确定的、缺关键信息的、或者有两条以上合理路线而选择会影响他实际使用的，先用 ask_user_question 问清楚，不要猜着往下做。',
  ].join('\n')
}

export function apply(ctx) {
  loadState()

  // ── 每轮组装系统提示词时求值：切模式后下一轮立即生效 ──
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'rest-mode',
      order: 130,
      text: () => renderModeText(),
      interpolate: false,
    }),
  )

  // ── 客户端用的读写口 ──
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
        let payload = {}
        try {
          const chunks = []
          let size = 0
          for await (const chunk of req) {
            size += chunk.length
            if (size > 64 * 1024) throw new Error('请求体过大')
            chunks.push(chunk)
          }
          const raw = Buffer.concat(chunks).toString('utf8')
          if (raw) payload = JSON.parse(raw)
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: { code: 'bad-body', message: '请求体不是合法 JSON' } }))
          return
        }
        let value
        try {
          if (endpoint === 'state') {
            value = { on: state.on, since: state.since }
          } else if (endpoint === 'toggle') {
            const next = payload && typeof payload.on === 'boolean' ? payload.on : !state.on
            if (next !== state.on) {
              state = { on: next, since: next ? Date.now() : 0 }
              saveState()
            }
            value = { on: state.on, since: state.since }
          } else {
            throw new Error('未知接口：' + String(endpoint))
          }
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
