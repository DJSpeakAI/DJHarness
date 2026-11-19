/**
 * 主人画像（Host 半）—— 读/写 home/owner-profile/profile.json。
 *
 * GET  /owner-profile-api        → 画像 JSON（30s 缓存，写入后立即失效）
 * POST /owner-profile-api {op:'save', value} → 校验+备份+落盘+changelog
 *
 * 画像是「统一主人画像」：同一份文件与鸿蒙 PC 小 DJ 的
 * ~/littleDJ/config/owner-profile/profile.json 字节一致，两边同步更新。
 *
 * 更新制度（2026-11-16 主人定的）：
 *   1. 画像不能一成不变：AI 会话中发现主人新的稳定偏好/重要事实 → 主动提议入画像；
 *      主人说「画像加/改/删一条」→ AI 直接改这份文件。
 *   2. 每次改动自动写 changelog.md（时间 + 动作 + 维度/条目数）。
 *   3. 每 30 天 AI 主动回顾一次画像，提出修订建议。
 *   4. 每次写入自动备份（保留最近 10 份 .bak）。
 */
import { readFileSync, writeFileSync, copyFileSync, readdirSync, unlinkSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const name = '@local/dsh-owner-profile'
export const inject = ['connection', 'webServer']

const ROUTE = '/owner-profile-api'
const DIR = 'E:/DJH/home/owner-profile'
const PROFILE_PATH = join(DIR, 'profile.json')
const CHANGELOG_PATH = join(DIR, 'changelog.md')
const MAX_BACKUPS = 10
const MAX_BODY = 1024 * 1024

let cache = { at: 0, value: null }

function readProfile() {
  const now = Date.now()
  if (cache.value && now - cache.at < 30 * 1000) return cache.value
  let value = { dimensions: [] }
  try {
    value = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'))
  } catch {
    /* 文件缺失时返回空，页面显示「还没有画像」 */
  }
  cache = { at: now, value }
  return value
}

function validProfile(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.dimensions)) return false
  for (const dim of value.dimensions) {
    if (!dim || typeof dim !== 'object' || typeof dim.id !== 'string' || !dim.id) return false
    if (!Array.isArray(dim.items)) return false
    for (const it of dim.items) {
      if (!it || typeof it !== 'object' || typeof it.text !== 'string' || !it.text.trim()) return false
      if (it.text.length > 4000) return false
    }
  }
  return true
}

function countItems(value) {
  return value.dimensions.reduce((s, d) => s + (d.items ? d.items.length : 0), 0)
}

function rotateBackups() {
  try {
    const files = readdirSync(DIR)
      .filter((f) => /^profile\.json\.bak-\d{4}-\d{2}-\d{2}T/.test(f))
      .sort()
    while (files.length >= MAX_BACKUPS) {
      unlinkSync(join(DIR, files.shift()))
    }
  } catch {
    /* 清理失败不阻塞写入 */
  }
}

function appendChangelog(action, value) {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const line = `- ${stamp} ${action}（${value.dimensions.length} 维度 / ${countItems(value)} 条）\n`
  try {
    const prev = readFileSync(CHANGELOG_PATH, 'utf8')
    writeFileSync(CHANGELOG_PATH, prev + line, 'utf8')
  } catch {
    writeFileSync(CHANGELOG_PATH, line, 'utf8')
  }
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
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
        try {
          if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, value: readProfile() }))
            return
          }
          if (req.method === 'POST') {
            const body = await readBody(req)
            if (!body || body.op !== 'save' || !validProfile(body.value)) {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: { message: 'invalid profile payload' } }))
              return
            }
            const value = body.value
            value.updated = Date.now()
            mkdirSync(DIR, { recursive: true })
            // 已有旧文件 → 备份后覆盖；首次写入无需备份
            try {
              if (statSync(PROFILE_PATH).size > 0) {
                rotateBackups()
                const bakName = 'profile.json.bak-' + new Date().toISOString().replace(/[:.]/g, '-')
                copyFileSync(PROFILE_PATH, join(DIR, bakName))
              }
            } catch {
              /* 旧文件不存在 → 直接写 */
            }
            writeFileSync(PROFILE_PATH, JSON.stringify(value, null, 2) + '\n', 'utf8')
            appendChangelog(body.action || '页面编辑保存', value)
            cache = { at: 0, value: null }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, value }))
            return
          }
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('method not allowed')
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: { message: String(err && err.message ? err.message : err) } }))
        }
      },
    }),
  )
}
