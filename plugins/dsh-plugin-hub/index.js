/**
 * 插件专区（Host 半）—— 把本地插件目录（plugins/）的清单吐给前端。
 * 官方「插件」页是插件市场页，本地自研插件不在市场里，所以一直读不出内容；
 * 这里直接列本机 13+ 个 DJH 插件，让专区成为 DJ 自己插件的家。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const name = '@local/dsh-plugin-hub'
export const inject = ['connection', 'webServer']

const ROUTE = '/djh-plugins-api'
const PLUGINS_DIR = 'E:/DJH/workspaces/default-workspace/plugins'
const CACHE_MS = 60 * 1000

let cache = { at: 0, value: null }

function listPlugins() {
  const now = Date.now()
  if (cache.value && now - cache.at < CACHE_MS) return cache.value
  const items = []
  try {
    for (const name of readdirSync(PLUGINS_DIR).sort()) {
      const dir = join(PLUGINS_DIR, name)
      let pkg = null
      try {
        if (!statSync(dir).isDirectory()) continue
        pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      } catch {
        continue
      }
      items.push({
        id: (pkg.name || name).replace('@local/', ''),
        version: pkg.version || '',
        description: pkg.description || '',
      })
    }
  } catch {}
  cache = { at: now, value: { items } }
  return cache.value
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
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, value: listPlugins() }))
      },
    }),
  )
}
