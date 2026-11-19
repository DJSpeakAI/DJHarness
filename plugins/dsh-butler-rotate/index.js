/**
 * @local/dsh-butler-rotate（Host 半）—— 大管家自动换脑
 *
 * 2026-11-18 主人拍板：大管家会话（星闪球桥指向的那条）上下文占用到 40% 就自动换脑：
 *   1) 先对老会话做一次压缩（compaction），摘要留在老会话日志里；
 *   2) 新建一个大管家会话（agentPreset=butler，物理禁手预设）；
 *   3) 把星闪球桥的目标会话切到新会话（写 orb-bridge.json + POST /whoami 热同步运行时）；
 *   4) 老会话留一条助手消息说明「上下文到 40%，已切到新会话 xxx」，然后归档（左栏隐藏，不删）；
 *   5) 推一条桥事件 {type:'rotate', text} 让星闪球播报（球页面轮询 /events）。
 *
 * 取数口径（与插件 dsh-session-ctx-pill 完全一致，不自己算 token）：
 *   ctx.sessionProjections.snapshot(session, ['contextPressure']).values.contextPressure
 *   pct = (projectedTokens ?? pressureTokens) / contextWindow
 *
 * 触发点：桥目标会话的 turn/end（一回合结束、agent 空闲）+ 启动后 / 兜底定时。
 * 防抖：换完 30 秒内不再触发；同一会话只换一次（进程内集合 + 老会话归档后即不可能再当目标）。
 * 阈值：插件 config（默认 0.4），运行时可被 E:\DJH\home\butler-rotate.json 覆盖（调试/测试用，不用重启）。
 *
 * HTTP（仅本机、需 DSH 页面令牌）：POST /butler-rotate-api/state|check|rotate-now
 */
import fs from 'node:fs'
import http from 'node:http'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = '@local/dsh-butler-rotate'
export const inject = ['agents', 'sessions', 'sessionProjections', 'webServer', 'connection']

const BRIDGE_CONFIG_PATH = 'E:\\DJH\\home\\orb-bridge.json'
const RUNTIME_CONFIG_PATH = 'E:\\DJH\\home\\butler-rotate.json'
const STATE_PATH = 'E:\\DJH\\home\\butler-rotate-state.json'
const LOG_PATH = 'E:\\DJH\\bin\\butler-rotate.log'
const ROUTE = '/butler-rotate-api'
const PRESSURE_KEY = 'contextPressure'
const DEFAULT_PORT = 9780
const COMPACT_TIMEOUT_MS = 10 * 60 * 1000
const TURN_END_DELAY_MS = 1800
const STARTUP_DELAY_MS = 15000
const FALLBACK_TICK_MS = 60000
const MAX_ROTATE_EVENTS = 200

const DEFAULTS = {
  threshold: 0.4,
  cooldownMs: 30000,
  preset: 'butler',
  /** 新会话的模型：butler 会话不要 preset 级默认模型（Host 单例会撞），创建后按会话选。 */
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  defaultCwd: 'E:\\DJH\\workspaces\\default-workspace',
  autoRotate: true,
  /** 是否推 rotate 事件让星闪球播报（默认开；测试时可关）。 */
  notify: true,
  /** 调试/验证：true 时客户端插件与球播报的「生产语义」关闭（见 client.js / state.testMode）。 */
  testMode: false,
}

function log(line) {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

function errorText(error) {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

function readJson(path, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') return parsed
  } catch {}
  return fallback
}

function writeJson(path, value) {
  try {
    fs.writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
    return true
  } catch (error) {
    log(`write ${path} failed: ${errorText(error)}`)
    return false
  }
}

/** 会话 id 有 "session-<uuid>" 与裸 UUID 两种历史形状（teammate 会话是裸 UUID），统一比对。 */
function bareId(id) {
  return String(id || '').replace(/^session:/, '').replace(/^session-/, '')
}

function sameId(a, b) {
  return bareId(a) !== '' && bareId(a) === bareId(b)
}

/** 一次本机 HTTP POST（JSON），返回解析后的对象；失败抛错。 */
function postJson(url, value, timeoutMs) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch (error) {
      reject(error)
      return
    }
    const body = Buffer.from(JSON.stringify(value === undefined ? {} : value), 'utf8')
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': body.length },
        timeout: timeoutMs || 5000,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'))
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(body)
  })
}

/** 一次本机 HTTP GET（JSON），返回解析后的对象；失败返回 null。 */
function getJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(url)
    } catch {
      resolve(null)
      return
    }
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: 'GET',
        timeout: timeoutMs || 4000,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'))
          } catch {
            resolve(null)
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(null))
    req.end()
  })
}

export function apply(ctx, config) {
  const base = { ...DEFAULTS }
  if (config !== null && typeof config === 'object') {
    for (const key of Object.keys(config)) {
      if (config[key] !== undefined) base[key] = config[key]
    }
  }

  /** 插件 config + 运行时覆盖文件（E:\DJH\home\butler-rotate.json）。 */
  function effective() {
    let value = { ...base }
    const runtime = readJson(RUNTIME_CONFIG_PATH, {})
    for (const key of Object.keys(DEFAULTS)) {
      if (runtime[key] !== undefined && runtime[key] !== null) value[key] = runtime[key]
    }
    const threshold = Number(value.threshold)
    value.threshold = Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : DEFAULTS.threshold
    const cooldownMs = Number(value.cooldownMs)
    value.cooldownMs = Number.isFinite(cooldownMs) && cooldownMs >= 0 ? cooldownMs : DEFAULTS.cooldownMs
    value.autoRotate = value.autoRotate !== false
    value.testMode = value.testMode === true
    if (typeof value.preset !== 'string' || value.preset.trim() === '') value.preset = DEFAULTS.preset
    if (typeof value.defaultCwd !== 'string' || value.defaultCwd.trim() === '') value.defaultCwd = DEFAULTS.defaultCwd
    return value
  }

  /** 桥配置：目标会话 + 端口（2s 内存缓存：session/event 全局监听会高频读）。 */
  let targetCache = { at: 0, value: null }
  function bridgeTarget() {
    const now = Date.now()
    if (targetCache.value !== null && now - targetCache.at < 2000) return targetCache.value
    const bridge = readJson(BRIDGE_CONFIG_PATH, {})
    const port = Number(bridge.port) > 0 ? Number(bridge.port) : DEFAULT_PORT
    const value = { sessionId: typeof bridge.sessionId === 'string' ? bridge.sessionId : '', port }
    targetCache = { at: now, value }
    return value
  }
  /** 切桥后立刻让缓存失效（否则 2s 内还看旧目标）。 */
  function invalidateTargetCache() {
    targetCache = { at: 0, value: null }
  }

  /* ── 状态 ── */
  const rotated = new Set() // 已换过脑的会话（bare id）
  const compacted = new Set() // 已压缩过的会话（bare id），失败重试时不重复压缩
  let cooldownUntil = 0
  let inFlight = false
  let scheduled = null
  let lastPressure = null // { pct, used, win }
  let lastRotation = readJson(STATE_PATH, null)
  if (lastRotation !== null && typeof lastRotation !== 'object') lastRotation = null
  const recentEvents = [] // 本插件内部留痕（/state 返回，最多 MAX_ROTATE_EVENTS 条）

  function remember(kind, text) {
    recentEvents.push({ at: Date.now(), kind, text })
    if (recentEvents.length > MAX_ROTATE_EVENTS) recentEvents.splice(0, recentEvents.length - MAX_ROTATE_EVENTS)
  }

  function saveState() {
    if (lastRotation !== null) writeJson(STATE_PATH, lastRotation)
  }

  /* ── 找会话 / Agent ── */
  function sessionCandidates(rawId) {
    const id = String(rawId || '')
    if (!id) return []
    const bare = bareId(id)
    return [id, `session-${bare}`, bare].filter((value, index, list) => value !== '' && list.indexOf(value) === index)
  }

  function findSession(rawId) {
    for (const id of sessionCandidates(rawId)) {
      try {
        const session = ctx.sessions.get(id)
        if (session !== undefined && session !== null) return session
      } catch {}
    }
    return undefined
  }

  function findAgent(rawId) {
    for (const id of sessionCandidates(rawId)) {
      try {
        const agent = ctx.agents.get(id)
        if (agent !== undefined && agent !== null) return agent
      } catch {}
    }
    return undefined
  }

  /** 活着的 Agent；不在就通过 sessionController 恢复（会挂回 preset）。 */
  async function ensureAgent(rawId) {
    let agent = findAgent(rawId)
    if (agent) return agent
    const controller = ctx.get('sessionController')
    if (controller === undefined || typeof controller.resolveAgent !== 'function') return undefined
    const result = await controller.resolveAgent(rawId)
    if (result !== undefined && result !== null) {
      if (result.agent !== undefined) return result.agent
      if (result.error !== undefined) throw result.error
    }
    return undefined
  }

  /** 上下文占用率（与 dsh-session-ctx-pill 完全同一口径）；拿不到返回 null。 */
  function pressureOf(session) {
    const projections = ctx.get('sessionProjections')
    if (!projections || typeof projections.snapshot !== 'function') return null
    let values
    try {
      values = projections.snapshot(session, [PRESSURE_KEY]).values
    } catch {
      return null
    }
    const pressure = values && values[PRESSURE_KEY]
    if (!pressure) return null
    const used = pressure.projectedTokens ?? pressure.pressureTokens
    const win = pressure.contextWindow
    if (!(used > 0) || !(win > 0)) return null
    return { pct: Math.min(1, used / win), used, win }
  }

  /* ── 换脑各步 ── */

  /** 1) 压缩老会话（compactNow 需要 idle agent 的 runMaintenance）。返回摘要结果或 null。 */
  async function compactOld(agent, sessionBare) {
    if (compacted.has(sessionBare)) {
      log('compaction skipped (already compacted in this process)')
      return null
    }
    // 2026-11-18 修：本插件挂在顶层 host 域，压缩后端(dsh-compaction-basic)是 preset 子域服务
    // （dsh-web-app 明确把 root 的 compaction-basic 禁用、移到各 preset 的 isolate 组里）。
    // 顶层 ctx.get('compaction') 恒为 undefined → 原来压缩步骤被静默跳过。
    // 正确取法：agentPresets.serviceFor(agent,'compaction')（官方为「取 agent 的 preset 子域服务」提供的方法），
    // 再兜底 agent.ctx.get / 顶层 ctx.get（兼容未来把后端放回 host 域）。
    const presets = ctx.get('agentPresets')
    let compaction
    try {
      if (presets && typeof presets.serviceFor === 'function') compaction = presets.serviceFor(agent, 'compaction')
    } catch (error) {
      log(`agentPresets.serviceFor(compaction) failed: ${errorText(error)}`)
    }
    if (!compaction && agent && agent.ctx && typeof agent.ctx.get === 'function') {
      try {
        compaction = agent.ctx.get('compaction')
      } catch (error) {
        log(`agent.ctx.get(compaction) failed: ${errorText(error)}`)
      }
    }
    if (!compaction) compaction = ctx.get('compaction')
    if (!compaction || typeof compaction.compactNow !== 'function') {
      log('compaction service unavailable; continue without summary')
      return null
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), COMPACT_TIMEOUT_MS)
    try {
      const result = await compaction.compactNow(agent, controller.signal)
      if (result === null || result === undefined) {
        log('compaction returned null (no safe range); continue without summary')
      } else {
        log(`compaction done: shadowed ${result.shadowedSeqs.length} nodes (~${result.shadowedTokenCount} tokens)`)
      }
      compacted.add(sessionBare)
      return result || null
    } catch (error) {
      const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
      if (code === 'busy') {
        // agent 不空闲（可能刚好来了新消息）：本轮不换，等下一次触发；不标 compacted。
        log('compaction busy; defer rotation to the next idle window')
        return { deferred: true }
      }
      // 其它失败：摘要没写成也要换脑（否则会话会一直涨到 80% 被自动压缩），老日志仍在。
      log(`compaction failed (${errorText(error)}); continue rotation without summary`)
      compacted.add(sessionBare)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** 老会话归档前留一条系统留痕（surface append，不触发模型步骤）。
   *  2026-11-18 修：原来这里硬写 assistant/message——但归档时 agent 空闲、没有打开的 turn/step，
   *  会话日志校验器（assertReleasedV4Relationships）在下次加载时报
   *  "assistant/message does not match an open turn and step" → 整条会话打不开
   *  （2026-11-18 实锤损坏了 session-5807c617 seq3666 / session-ebf42d50 seq4）。
   *  assistant 消息只能由回合内产生；turn 外只有 user/message 可以裸 append（校验器对它无 turn/step 要求）。
   *  所以留痕改用 user/message（source.kind='user'），文案标明是系统自动行为。 */
  function appendRotationNote(agent, newSessionId, pct, reason) {
    try {
      const session = agent.session
      const text =
        `（系统·自动换脑）上下文已用到 ${Math.round(pct * 100)}%（${reason}），` +
        `已切换到新的大管家会话：${newSessionId}。本会话已归档（左栏隐藏，日志与压缩摘要都保留）。`
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      session.append('user/message', message, { surfaceOp: 'append' })
      log(`note appended to old session (user/message, id=${message.id || 'n/a'})`)
    } catch (error) {
      log(`note append failed: ${errorText(error)}`)
    }
  }

  /** 2) 新建大管家会话（同工作区、preset=butler），返回新会话 id。 */
  async function createButlerSession(oldSession, eff) {
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.create !== 'function') throw new Error('sessionController.unavailable')
    const request = { agentPreset: eff.preset }
    let workspaceId
    try {
      const registry = ctx.get('workspaceRegistry')
      const workspaces = registry ? registry.list() : []
      const owner = workspaces.find((workspace) => workspace.sessionIds.some((id) => sameId(id, oldSession.id)))
      if (owner) workspaceId = owner.id
    } catch (error) {
      log(`workspace lookup failed: ${errorText(error)}`)
    }
    if (workspaceId !== undefined) request.workspaceId = workspaceId
    else request.cwd = oldSession.header.cwd || eff.defaultCwd
    const created = await controller.create(request)
    const newSessionId = created && created.sessionId !== undefined ? String(created.sessionId) : ''
    if (!newSessionId) throw new Error('sessionController.create returned no sessionId')
    // 2026-11-18 主人报「左栏没有大管家会话框」：用 cwd 建的会话不进 Workspace sessionIds，
    // 左栏按成员分组渲染 → 换脑新会话看不见。这里立刻补挂 + pin（幂等）。
    try {
      const registry = ctx.get('workspaceRegistry')
      const workspaces = registry && typeof registry.list === 'function' ? registry.list() : []
      const cwd = String((oldSession && oldSession.header && oldSession.header.cwd) || eff.defaultCwd || '')
      const owner = workspaces.find((ws) => cwd && String(ws.path || '').toLowerCase() === cwd.toLowerCase())
      const target = owner || workspaces.find((ws) => String(ws.path || '').endsWith('default-workspace'))
      if (target) {
        await target.attachSession(newSessionId)
        log(`new butler session attached to workspace ${target.path}`)
      }
      if (registry && typeof registry.pinSession === 'function') {
        await registry.pinSession(newSessionId)
        log(`new butler session pinned`)
      }
    } catch (error) {
      log(`workspace attach for new butler session failed: ${errorText(error)}`)
    }
    const newSession = findSession(newSessionId)
    if (newSession) {
      try {
        await ctx.sessions.flush(newSession)
      } catch (error) {
        log(`flush new session failed: ${errorText(error)}`)
      }
      // 固定角色名（主人拍板 2026-11-18：大管家会话就叫「大管家」三个字，换脑后名字不丢）
      try {
        const titles = ctx.get('sessionTitle')
        if (titles && typeof titles.rename === 'function') {
          titles.rename(newSession, '大管家')
          await ctx.sessions.flush(newSession)
          log(`new butler session renamed -> 大管家`)
        }
      } catch (error) { log(`butler rename failed: ${errorText(error)}`) }
    }
    return newSessionId
  }

  /** 2a) 没有 user 消息的会话不进左栏常规列表（只在选中时显示；v0.128 星闪球 intro 同款坑）：
   *  换脑新会话必须补一条 user 开场白并 followup（触发回合 → 生成标题 → 左栏可见），幂等。 */
  async function ensureWelcome(sessionId, eff, oldSessionId) {
    const session = findSession(sessionId)
    if (!session) {
      log(`welcome note skipped for ${sessionId}: session not found`)
      return false
    }
    let hasUser = false
    try {
      const dump = JSON.stringify(typeof session.deriveMessages === 'function' ? session.deriveMessages() : [])
      hasUser = dump.includes('"user"')
    } catch (error) {
      log(`deriveMessages failed for ${sessionId}: ${errorText(error)}`)
    }
    if (hasUser) return false
    const text = oldSessionId
      ? `（系统·自动换脑）上一条大管家会话上下文到阈值已归档，这是新的大管家会话，请简短确认在位即可。`
      : `（系统）这是大管家会话，请简短确认在位即可。`
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    const agent = await ensureAgent(sessionId)
    if (!agent || typeof agent.followup !== 'function') {
      log(`welcome followup skipped for ${sessionId}: agent not live`)
      return false
    }
    agent.followup(message)
    try {
      await ctx.sessions.flush(agent.session)
    } catch (error) {
      log(`flush welcome note failed: ${errorText(error)}`)
    }
    log(`welcome user message sent to ${sessionId} (old=${oldSessionId || 'none'})`)
    remember('welcome', `session=${sessionId}`)
    return true
  }

  /** 2b) 新会话的模型按会话选（butler 预设不再挂 preset 级 default-model）。 */
  function selectModelForNewSession(newSessionId, eff) {
    const agent = findAgent(newSessionId)
    if (!agent || !agent.model || typeof agent.model.select !== 'function') {
      log(`model select skipped for ${newSessionId}: agent not live`)
      return
    }
    try {
      agent.model.select({ provider: eff.provider, model: eff.model })
      log(`model selected for ${newSessionId}: ${eff.provider}/${eff.model}`)
    } catch (error) {
      log(`model select failed for ${newSessionId}: ${errorText(error)}`)
    }
  }

  /** 3) 切桥：先写盘（重启/球重连要读），再 /whoami 热同步运行时 butlerId，最后 /health 校验。 */
  async function switchBridge(newSessionId, port) {
    const bridge = readJson(BRIDGE_CONFIG_PATH, {})
    bridge.sessionId = newSessionId
    if (!writeJson(BRIDGE_CONFIG_PATH, bridge)) throw new Error('bridge config write failed')
    invalidateTargetCache()
    let result
    try {
      result = await postJson(`http://127.0.0.1:${port}/whoami`, { sessionId: newSessionId }, 5000)
    } catch (error) {
      throw new Error(`bridge /whoami unreachable: ${errorText(error)}`)
    }
    if (result === null || result.ok !== true) throw new Error(`bridge /whoami rejected: ${JSON.stringify(result)}`)
    const health = await getJson(`http://127.0.0.1:${port}/health`, 4000)
    if (health && health.ok && !sameId(health.butler, newSessionId)) {
      throw new Error(`bridge still reports butler=${health.butler}`)
    }
    log(`bridge switched to ${newSessionId} (health butler=${health && health.butler})`)
  }

  /** 5) 推 rotate 事件给星闪球（球页面轮询 /events 播报）。 */
  async function pushRotateEvent(port, text, oldSessionId, newSessionId, pct) {
    const result = await postJson(
      `http://127.0.0.1:${port}/event`,
      { type: 'rotate', text, oldSessionId, newSessionId, pct: Math.round(pct * 100) },
      5000,
    )
    if (result === null || result.ok !== true) throw new Error(`bridge /event rejected: ${JSON.stringify(result)}`)
  }

  async function rotate(agent, target, eff, reason, options) {
    const session = agent.session
    const oldSessionId = String(session.id)
    const oldBare = bareId(oldSessionId)
    const pressure = pressureOf(session) || lastPressure || { pct: 0, used: 0, win: 0 }
    const force = !!(options && options.force)
    if (rotated.has(oldBare)) {
      log(`rotate skipped: ${oldSessionId} already rotated in this process`)
      return false
    }
    inFlight = true
    log(`ROTATE start reason=${reason}${force ? ' (forced)' : ''} session=${oldSessionId} pct=${(pressure.pct * 100).toFixed(1)}% threshold=${(eff.threshold * 100).toFixed(1)}%`)
    remember('start', `reason=${reason} session=${oldSessionId} pct=${(pressure.pct * 100).toFixed(1)}%`)
    try {
      // 1) 压缩
      const compactResult = await compactOld(agent, oldBare)
      if (compactResult !== null && compactResult.deferred === true) {
        cooldownUntil = Date.now() + 15000
        return false
      }
      // 2) 新会话
      const newSessionId = await createButlerSession(session, eff)
      selectModelForNewSession(newSessionId, eff)
      await ensureWelcome(newSessionId, eff, oldSessionId)
      log(`created new butler session ${newSessionId}`)
      // 3) 切桥（失败就整体回滚意图：新会话留着无妨，老会话不归档、桥保持旧目标）
      await switchBridge(newSessionId, target.port)
      // 4) 老会话留痕 + 归档
      appendRotationNote(agent, newSessionId, pressure.pct, reason)
      let archived = false
      try {
        const registry = ctx.get('workspaceRegistry')
        if (!registry || typeof registry.archiveSession !== 'function') throw new Error('workspaceRegistry.unavailable')
        await registry.archiveSession(oldSessionId, { stopActivity: true })
        archived = true
        log(`old session archived: ${oldSessionId}`)
      } catch (error) {
        log(`archive old session failed: ${errorText(error)}`)
      }
      // 5) 球播报
      const text = `主人，上下文到 ${Math.round(pressure.pct * 100)}% 了，我开了个新会话接着聊`
      let notified = false
      if (eff.notify !== false) {
        try {
          await pushRotateEvent(target.port, text, oldSessionId, newSessionId, pressure.pct)
          notified = true
          log('rotate event pushed to orb bridge')
        } catch (error) {
          log(`rotate event push failed: ${errorText(error)}`)
        }
      }
      lastRotation = {
        at: Date.now(),
        oldSessionId,
        newSessionId,
        pct: pressure.pct,
        used: pressure.used,
        win: pressure.win,
        reason,
        testMode: eff.testMode === true,
        archived,
        notified,
        compacted: compactResult !== null && compactResult !== undefined && compactResult.shadowedSeqs !== undefined
          ? { shadowedNodes: compactResult.shadowedSeqs.length, shadowedTokens: compactResult.shadowedTokenCount }
          : null,
      }
      saveState()
      rotated.add(oldBare)
      cooldownUntil = Date.now() + eff.cooldownMs
      remember('done', `old=${oldSessionId} new=${newSessionId} archived=${archived} notified=${notified}`)
      log(`ROTATE done old=${oldSessionId} new=${newSessionId} archived=${archived} notified=${notified}`)
      return true
    } catch (error) {
      cooldownUntil = Date.now() + 20000
      remember('error', errorText(error))
      log(`ROTATE failed: ${errorText(error)}`)
      return false
    } finally {
      inFlight = false
    }
  }

  /** 检查一次（默认按阈值；force 无视阈值，供调试/验证）。 */
  async function runCheck(reason, options) {
    const force = !!(options && options.force)
    const eff = effective()
    if (inFlight) return { skipped: 'in-flight' }
    if (!force && eff.autoRotate === false) return { skipped: 'disabled' }
    const target = bridgeTarget()
    if (!target.sessionId) return { skipped: 'no-bridge-target' }
    const targetBare = bareId(target.sessionId)
    if (rotated.has(targetBare)) return { skipped: 'already-rotated' }
    if (Date.now() < cooldownUntil) return { skipped: 'cooldown' }
    const registry = ctx.get('workspaceRegistry')
    if (registry && Array.isArray(registry.archivedSessionIds) && registry.archivedSessionIds.some((id) => sameId(id, target.sessionId))) {
      return { skipped: 'target-archived' }
    }
    let agent
    try {
      agent = await ensureAgent(target.sessionId)
    } catch (error) {
      log(`agent resolve failed for ${target.sessionId}: ${errorText(error)}`)
      return { skipped: 'agent-unavailable' }
    }
    if (!agent) return { skipped: 'agent-unavailable' }
    const session = agent.session
    const pressure = pressureOf(session)
    lastPressure = pressure
    if (pressure === null) {
      if (!force) return { skipped: 'no-pressure-reading' }
    } else if (!force && pressure.pct < eff.threshold) {
      return { skipped: 'below-threshold', pct: pressure.pct, threshold: eff.threshold }
    }
    if (agent.status !== 'idle') {
      // 忙：等下一次 turn/end / 空闲事件
      return { skipped: 'agent-busy', status: agent.status }
    }
    const ok = await rotate(agent, target, eff, reason, { force })
    return ok ? { rotated: true } : { skipped: 'rotate-failed' }
  }

  function scheduleCheck(reason, delay) {
    if (scheduled !== null) clearTimeout(scheduled)
    scheduled = setTimeout(() => {
      scheduled = null
      Promise.resolve()
        .then(() => runCheck(reason))
        .catch((error) => log(`scheduled check error: ${errorText(error)}`))
    }, delay === undefined ? TURN_END_DELAY_MS : delay)
  }

  /* ── 事件监听 ── */
  const offSessionEvent = ctx.on(
    'session/event',
    (session, event) => {
      try {
        const id = session && typeof session === 'object' ? session.id : session
        const target = bridgeTarget()
        if (!target.sessionId || !sameId(id, target.sessionId)) return
        if (!event || event.type !== 'turn/end') return
        const reason = event.data && event.data.reason && event.data.reason.kind ? event.data.reason.kind : 'unknown'
        log(`turn/end on butler session (reason=${reason}); scheduling pressure check`)
        scheduleCheck('turn-end')
      } catch (error) {
        log(`session/event handler error: ${errorText(error)}`)
      }
    },
    { global: true },
  )

  const offAgentStatus = ctx.on(
    'agent/status',
    (payload) => {
      try {
        const agent = payload && payload.agent ? payload.agent : payload
        const id = agent && agent.session ? agent.session.id : undefined
        const target = bridgeTarget()
        if (!target.sessionId || !sameId(id, target.sessionId)) return
        if (payload && payload.status === 'idle') scheduleCheck('agent-idle', 2500)
      } catch {}
    },
    { global: true },
  )

  /* ── 启动兜底 + 定时兜底 ── */
  const startupTimer = setTimeout(() => {
    Promise.resolve()
      .then(async () => {
        // 兜底修复：桥目标会话若仍是空的（换脑后没来得及补开场白/历史遗留），补一条让左栏可见。
        const target = bridgeTarget()
        if (target.sessionId) await ensureWelcome(target.sessionId, effective())
        await runCheck('startup')
      })
      .catch((error) => log(`startup check error: ${errorText(error)}`))
  }, STARTUP_DELAY_MS)
  const fallbackTimer = setInterval(() => {
    Promise.resolve()
      .then(() => runCheck('tick'))
      .catch((error) => log(`fallback check error: ${errorText(error)}`))
  }, FALLBACK_TICK_MS)

  /* ── 本机 HTTP：状态读数 + 手动检查（令牌校验与 dsh-session-ctx-pill 同款） ── */
  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 16 * 1024) throw new Error('body too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  function sendJson(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        const admission = ctx.connection.admit({ headers: req.headers })
        if ('rejection' in admission) {
          sendJson(res, admission.rejection, { ok: false, error: admission.rejection === 401 ? 'unauthorized' : 'forbidden' })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
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
          const raw = await readBody(req)
          if (raw.trim() !== '') payload = JSON.parse(raw)
        } catch {
          /* 本接口 payload 可选 */
        }
        try {
          if (endpoint === 'state') {
            const target = bridgeTarget()
            const eff = effective()
            let pressure = lastPressure
            try {
              const agent = findAgent(target.sessionId)
              if (agent) {
                pressure = pressureOf(agent.session)
                lastPressure = pressure
              }
            } catch {}
            sendJson(res, 200, {
              ok: true,
              value: {
                at: Date.now(),
                butler: target.sessionId,
                port: target.port,
                threshold: eff.threshold,
                autoRotate: eff.autoRotate,
                testMode: eff.testMode,
                inFlight,
                rotated: [...rotated],
                pressure: pressure === null ? null : { pct: pressure.pct, used: pressure.used, win: pressure.win },
                lastRotation,
                events: recentEvents.slice(-20),
              },
            })
            return
          }
          if (endpoint === 'check' || endpoint === 'rotate-now') {
            const force = endpoint === 'rotate-now'
            const result = await runCheck(force ? 'manual-force' : 'manual-check', { force })
            sendJson(res, 200, { ok: true, value: result })
            return
          }
          if (endpoint === 'create-test-session') {
            // 验证用：在指定目录建一个 butler 预设的测试会话（返回 sessionId）。
            const eff = effective()
            const controller = ctx.get('sessionController')
            if (!controller || typeof controller.create !== 'function') throw new Error('sessionController.unavailable')
            const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : 'E:\\DJH\\workspaces\\evals-ws'
            const created = await controller.create({ cwd, agentPreset: eff.preset })
            const sessionId = created && created.sessionId !== undefined ? String(created.sessionId) : ''
            const session = findSession(sessionId)
            if (session) {
              try {
                await ctx.sessions.flush(session)
              } catch {}
            }
            log(`test session created: ${sessionId} (cwd=${cwd})`)
            sendJson(res, 200, { ok: true, value: { sessionId, cwd } })
            return
          }
          if (endpoint === 'archive-session') {
            // 验证用：归档指定会话（清掉测试会话，不动主人会话）。
            const registry = ctx.get('workspaceRegistry')
            if (!registry || typeof registry.archiveSession !== 'function') throw new Error('workspaceRegistry.unavailable')
            if (typeof payload.sessionId !== 'string' || !payload.sessionId) throw new Error('missing sessionId')
            await registry.archiveSession(payload.sessionId, { stopActivity: true })
            log(`session archived via debug endpoint: ${payload.sessionId}`)
            sendJson(res, 200, { ok: true, value: { archived: payload.sessionId } })
            return
          }
          sendJson(res, 404, { ok: false, error: 'unknown endpoint: ' + String(endpoint) })
        } catch (error) {
          log(`http ${endpoint} error: ${errorText(error)}`)
          sendJson(res, 500, { ok: false, error: errorText(error) })
        }
      },
    }),
  )

  ctx.effect(() => () => {
    offSessionEvent()
    offAgentStatus()
    clearTimeout(startupTimer)
    clearInterval(fallbackTimer)
    if (scheduled !== null) clearTimeout(scheduled)
    log('butler-rotate stopped')
  })

  log(`boot: threshold=${(base.threshold * 100).toFixed(1)}% cooldown=${base.cooldownMs}ms preset=${base.preset} runtime=${RUNTIME_CONFIG_PATH}`)
  remember('boot', `threshold=${base.threshold}`)
}
