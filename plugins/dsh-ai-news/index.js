/**
 * AI 新闻（Host 半）—— 只做一件事：把 apps/ai-news/news.json 吐给前端。
 *
 * 数据由 DSH 自动化任务「AI 新闻搜集」每天 09:00 写入（保留最近 7 天），
 * 这里读文件加 30s 缓存，面板打开永远秒开。
 */
import { readFileSync } from 'node:fs'

export const name = '@local/dsh-ai-news'
export const inject = ['connection', 'webServer']

const ROUTE = '/ai-news-api'
const NEWS_PATH = 'E:/DJH/workspaces/default-workspace/apps/ai-news/news.json'
const REPOS_PATH = 'E:/DJH/workspaces/default-workspace/apps/treasure-radar/repos.json'
const WEEKLY_PATH = 'E:/DJH/workspaces/default-workspace/apps/treasure-radar/weekly.json'
const CACHE_MS = 30 * 1000

let cache = { at: 0, value: null }

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function readAll(force) {
  const now = Date.now()
  if (!force && cache.value && now - cache.at < CACHE_MS) return cache.value
  const value = {
    news: readJson(NEWS_PATH, { days: [] }),
    repos: readJson(REPOS_PATH, { days: [] }),
    weekly: readJson(WEEKLY_PATH, { weeks: [] }),
  }
  cache = { at: now, value }
  return value
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
        const value = readAll(false)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, value }))
      },
    }),
  )
}
