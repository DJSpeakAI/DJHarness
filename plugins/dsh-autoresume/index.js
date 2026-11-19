/**
 * @local/dsh-autoresume
 *
 * 1) Restart 后续跑：Host 启动后读 `E:\DJH\home\autoresume-queue.json`，
 *    对每个 { sessionId, prompt } 恢复该 Session 并作为用户消息投递，
 *    让被重启打断的对话自动接着干。
 *    队列由 AI 在重启前写入（DJH-Guard 的重启流程会保留它）。
 *    投递方式与内置 schedule 插件一致：createUserMessage + agent.followup + sessions.flush。
 *
 * 2) 断网恢复续跑（2026-11-15）：监听 `agent/error`，错误文本像网络故障
 *    （fetch failed / timeout / ECONNRESET / 502…）时记入待续队列；后台每 15s
 *    探测一次外网（HEAD https://api.deepseek.com），网络通了且该 Agent 空闲
 *    就自动注入「网络已恢复，继续任务」的 followup。每会话每小时最多自动续 2 次，
 *    防止对不可恢复的错误无限循环。
 */
import fs from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * Cordis dependency declaration: required before ctx.agents / ctx.sessions are readable.
 * `sessionController` / `agentPresets` are resolved optionally with ctx.get() so this
 * plugin also loads in a host that lacks the Web Session API.
 */
export const inject = ['agents', 'sessions']

const QUEUE_PATH = 'E:\\DJH\\home\\autoresume-queue.json'
const LOG_PATH = 'E:\\DJH\\bin\\autoresume.log'
const START_DELAY_MS = 12000

/** 保持恢复出来的 Agent 句柄存活，避免被回收。 */
const handles = []

function log(line) {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

/**
 * Resume one Session exactly the way the Web UI does.
 *
 * `ctx.agents.resume()` alone loads the persisted log but never mounts the
 * Session's Agent preset, so the resumed Agent only has core host tools
 * (`working_directory`) and every `pwsh` / `read` / `write` call fails with
 * `unknown tool`. The Session controller resolves the recorded preset and mounts
 * it before the Agent starts, so route through it whenever it exists.
 *
 * @param {any} ctx host context carrying the optional services
 * @param {string} id Session to resume
 * @returns {Promise<any>} the live Agent
 */
async function resumeAgent(ctx, id) {
  const controller = ctx.get('sessionController')
  if (controller !== undefined && typeof controller.resolveAgent === 'function') {
    try {
      const result = await controller.resolveAgent(id)
      if (result !== undefined && result !== null) {
        if (result.agent !== undefined) return result.agent
        if (result.error !== undefined) throw result.error
      }
    } catch (error) {
      // Keep going: a plain resume still delivers the queued message, it just
      // leaves the Agent without its preset tools, which is better than silence.
      log(`sessionController resume failed for ${id}: ${errorText(error)}; trying plain resume`)
    }
  }
  // Fallback for a host without the Web Session API: mount the default preset
  // ourselves, then resume. The selection event keeps the Session projection in
  // sync with the composition the Agent actually runs.
  const presets = ctx.get('agentPresets')
  const setup = presets === undefined ? undefined : async (agentCtx, agent) => {
    const mounted = await presets.mount(agentCtx)
    if (
      agent !== undefined
      && mounted !== undefined
      && mounted.id !== undefined
      && presets.presetForSession(agent.session) !== mounted.id
    ) {
      agent.session.append('agent-preset/selected', { agentPreset: mounted.id })
    }
  }
  const handle = await ctx.agents.resume({
    resumeSessionId: id,
    ...(setup === undefined ? {} : { setup }),
  })
  handles.push(handle)
  return handle.agent
}

/** @param {unknown} error */
function errorText(error) {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

async function run(ctx) {
  let queue
  try {
    queue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'))
  } catch (error) {
    log(`queue read skipped (${errorText(error)})`)
    return
  }
  if (queue !== null && !Array.isArray(queue) && typeof queue === 'object' && typeof queue.sessionId === 'string') {
    // 2026-11-16：容错——历史脚本用 ConvertTo-Json 单元素数组写过对象形状，
    // 严格 Array.isArray 会静默跳过（拉回失败却零日志）。单对象视为单条队列。
    queue = [queue]
  }
  if (!Array.isArray(queue) || queue.length === 0) {
    log('queue empty or not a list; nothing to resume')
    return
  }

  log(`queue has ${queue.length} item(s)`)
  const remaining = []

  for (const item of queue) {
    try {
      const raw = item && item.sessionId
      if (!raw || typeof raw !== 'string') throw new Error('missing sessionId')

      // 2026-11-16：ID 归一化——历史队列写过裸 UUID（缺 "session-" 前缀），
      // resume 全部 "session not found" 还静默留队。两种形状都试，先原样后补/去前缀。
      const candidates = raw.startsWith('session-')
        ? [raw, raw.slice('session-'.length)]
        : [raw, `session-${raw}`]

      let agent
      let usedId
      let lastError
      for (const id of candidates) {
        try {
          agent = ctx.agents.get(id)
          if (!agent) agent = await resumeAgent(ctx, id)
          usedId = id
          break
        } catch (error) {
          lastError = error
          agent = undefined
        }
      }
      if (!agent) throw lastError || new Error('resume failed for all id candidates')
      const id = usedId

      const text = typeof item.prompt === 'string' && item.prompt.trim()
        ? item.prompt
        : '（DSH 刚重启过，这是自动续跑消息）继续之前的任务，先确认走到哪一步了。'
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      agent.followup(message)
      await ctx.sessions.flush(agent.session)
      log(`resumed ${id}${id !== raw ? ` (normalized from ${raw})` : ''}`)
    } catch (error) {
      log(`failed ${item && item.sessionId}: ${error && error.message}`)
      remaining.push(item)
    }
  }

  try {
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(remaining, null, 2), 'utf8')
  } catch (error) {
    // 写不回去=未完成的续跑项会丢，必须留痕，否则只看到 "done, N left" 像成功了。
    log(`queue write FAILED (${remaining.length} item(s) not persisted): ${error && error.message}`)
  }
  log(`done, ${remaining.length} left`)
}

export function apply(ctx) {
  log(`boot: watching ${QUEUE_PATH} (resume in ${START_DELAY_MS}ms)`)
  const timer = setTimeout(() => {
    Promise.resolve()
      .then(() => run(ctx))
      .catch((error) => log(`run error: ${error && error.message}`))
  }, START_DELAY_MS)
  ctx.effect(() => () => clearTimeout(timer))
  ctx.effect(() => startNetback(ctx))
}

/* ---------- 2) 断网恢复续跑 ---------- */

const NET_PROBE_URL = 'https://api.deepseek.com'
const NET_PROBE_INTERVAL_MS = 15000
const NET_PROBE_TIMEOUT_MS = 6000
const NETBACK_TTL_MS = 30 * 60 * 1000
const NETBACK_MAX_PER_HOUR = 2
const NET_ERROR_RE =
  /fetch failed|network|timeout|timed out|econnreset|econnrefused|enotfound|eai_again|socket hang up|connection (closed|reset|aborted)|aborted|502|503|504|bad gateway|service unavailable/i

/** 待续条目：sessionId -> { at, count }；count 一小时窗口内的自动续跑次数。 */
const netbackQueue = new Map()
/** 记录 Agent 空闲态：来自 agent/status 事件；未知时视为空闲（宁可少续不可错杀对面在跑的）。 */
const runningAgents = new Set()

function looksNetworky(error) {
  return NET_ERROR_RE.test(errorText(error))
}

async function probeNet() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NET_PROBE_TIMEOUT_MS)
  try {
    // 任何 HTTP 应答（含 4xx/5xx）都说明外网可达；只有请求本身失败才算断网。
    await fetch(NET_PROBE_URL, { method: 'HEAD', signal: controller.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function startNetback(ctx) {
  const offStatus = ctx.on('agent/status', (payload) => {
    const id = payload.agent?.session?.id ?? payload.agent?.session
    if (typeof id !== 'string') return
    if (payload.status === 'running') runningAgents.add(id)
    else runningAgents.delete(id)
  })

  const offError = ctx.on('agent/error', (payload) => {
    const id = payload.agent?.session?.id ?? payload.agent?.session
    if (typeof id !== 'string') return
    if (!looksNetworky(payload.error)) return
    netbackQueue.set(id, { at: Date.now() })
    log(`netback queued ${id} (network-ish error: ${errorText(payload.error).slice(0, 120)})`)
  })

  const ticker = setInterval(() => {
    Promise.resolve()
      .then(() => drainNetback(ctx))
      .catch((error) => log(`netback tick error: ${error && error.message}`))
  }, NET_PROBE_INTERVAL_MS)

  return () => {
    offStatus()
    offError()
    clearInterval(ticker)
  }
}

async function drainNetback(ctx) {
  if (netbackQueue.size === 0) return
  if (!(await probeNet())) return
  const now = Date.now()
  for (const [id, entry] of [...netbackQueue]) {
    if (now - entry.at > NETBACK_TTL_MS) {
      netbackQueue.delete(id)
      continue
    }
    if (runningAgents.has(id)) continue // 还在跑（可能在重试或干别的），等下一轮
    let agent
    try {
      agent = ctx.agents.get(id)
    } catch {}
    if (!agent) {
      netbackQueue.delete(id) // Agent 已不在（会话关了/重启了），交给重启队列机制
      continue
    }
    if (entry.count >= NETBACK_MAX_PER_HOUR) {
      log(`netback give up ${id}: reached ${NETBACK_MAX_PER_HOUR}/hour limit`)
      netbackQueue.delete(id)
      continue
    }
    try {
      const message = createUserMessage({
        content: [
          {
            type: 'text',
            text: '（网络已恢复 · 自动续跑）刚才网络中断打断了任务，请从中断处继续完成，不要从头开始，先确认已做到哪一步。',
          },
        ],
        source: { kind: 'user' },
      })
      agent.followup(message)
      await ctx.sessions.flush(agent.session)
      entry.count = (entry.count ?? 0) + 1
      entry.at = Date.now() // 顺延窗口，连环断网时按次数熔断
      if (entry.count >= NETBACK_MAX_PER_HOUR) netbackQueue.delete(id)
      log(`netback resumed ${id} (attempt ${entry.count}/${NETBACK_MAX_PER_HOUR})`)
    } catch (error) {
      log(`netback failed ${id}: ${errorText(error)}`)
      netbackQueue.delete(id)
    }
  }
}
