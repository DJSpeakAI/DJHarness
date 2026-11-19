/**
 * @local/dsh-preset-switch（Host 半，一次性工具）—— 把已有 Session 的 agentPreset 记录切成目标预设。
 *
 * 背景：agent-preset-registry 的 `select()` 只允许「空白会话」（没跑过 turn 的）改预设，
 * 已经开始的会话会报 `agent-preset/locked`。但会话日志（session.v4.jsonl.zstd）里
 * `agent-preset/selected` 是已知事件类型，`agentPreset` 投影 = 请求头里的预设 +
 * 最后一条 agent-preset/selected 事件 → 下次 resume / 重建 Agent 时按投影挂载预设。
 *
 * 所以本插件做的事：读请求文件，对目标会话 append 一条
 * `agent-preset/selected {agentPreset: <目标>}` 并 flush 落盘；重启后该会话的 Agent
 * 就会用目标预设重建（现场那个 Agent 的插件组合不会立即变，这是注册表的代际语义）。
 *
 * 请求：E:\DJH\home\preset-switch-request.json = { "sessionId": "...", "agentPreset": "butler" }
 * 结果：E:\DJH\home\preset-switch-result.json
 * 日志：E:\DJH\bin\preset-switch.log
 *
 * 成功处理完请求后删掉请求文件（避免下次开机器又跑一遍）；重复执行幂等。
 */
import fs from 'node:fs'

export const name = '@local/dsh-preset-switch'
export const inject = ['agents', 'sessions']

const REQUEST_PATH = 'E:\\DJH\\home\\preset-switch-request.json'
const RESULT_PATH = 'E:\\DJH\\home\\preset-switch-result.json'
const LOG_PATH = 'E:\\DJH\\bin\\preset-switch.log'
const START_DELAY_MS = 300

function log(line) {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

function writeResult(value) {
  try {
    fs.writeFileSync(RESULT_PATH, JSON.stringify(value, null, 2), 'utf8')
  } catch (error) {
    log(`result write failed: ${error && error.message}`)
  }
}

function errorText(error) {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

function readRequest() {
  try {
    return JSON.parse(fs.readFileSync(REQUEST_PATH, 'utf8'))
  } catch {
    return undefined
  }
}

function dropRequest() {
  try {
    fs.unlinkSync(REQUEST_PATH)
  } catch {}
}

async function switchPreset(ctx) {
  const req = readRequest()
  if (req === undefined) {
    log('no request; idle')
    return
  }
  if (req === null || typeof req.sessionId !== 'string' || typeof req.agentPreset !== 'string') {
    log('bad request shape')
    writeResult({ ok: false, error: 'bad request shape' })
    return
  }
  log(`request: ${req.sessionId} -> ${req.agentPreset}`)

  const presets = ctx.get('agentPresets')
  if (presets === undefined) {
    writeResult({ ok: false, error: 'agentPresets service unavailable' })
    log('agentPresets service unavailable')
    return
  }

  const live = ctx.agents.get(req.sessionId)
  if (live !== undefined) {
    let before
    try {
      before = presets.presetForSession(live.session)
    } catch {
      before = undefined
    }
    if (before === undefined || before === null) before = live.session.header.agentPreset ?? null
    if (before === req.agentPreset) {
      log(`already ${before}; nothing to record`)
      writeResult({ ok: true, already: true, mode: 'live-append', before, sessionSeq: live.session.seq })
      dropRequest()
      return
    }
    live.session.append('agent-preset/selected', { agentPreset: req.agentPreset })
    await ctx.sessions.flush(live.session)
    let after
    try {
      after = presets.presetForSession(live.session)
    } catch {
      after = undefined
    }
    log(`appended on live session ${req.sessionId}: before=${String(before)} after=${String(after)} seq=${live.session.seq}`)
    writeResult({
      ok: after === req.agentPreset,
      mode: 'live-append',
      before,
      after,
      sessionSeq: live.session.seq,
      note: 'live Agent composition unchanged; rebuilt on next process start / resume',
    })
    if (after === req.agentPreset) dropRequest()
    return
  }

  // 会话当前没有活 Agent：resume 并直接按目标预设挂载，再记录选择事件（与 Session controller 的复用路径一致）。
  log(`no live agent; resuming ${req.sessionId} with preset ${req.agentPreset}`)
  const handle = await ctx.agents.resume({
    resumeSessionId: req.sessionId,
    setup: async (agentCtx, agent) => {
      await presets.mount(agentCtx, req.agentPreset)
      if (agent !== undefined && presets.presetForSession(agent.session) !== req.agentPreset) {
        agent.session.append('agent-preset/selected', { agentPreset: req.agentPreset })
      }
    },
  })
  const agent = handle.agent
  await ctx.sessions.flush(agent.session)
  const after = presets.presetForSession(agent.session)
  log(`resumed with preset: after=${String(after)} seq=${agent.session.seq}`)
  writeResult({ ok: after === req.agentPreset, mode: 'resume-mount', after, sessionSeq: agent.session.seq })
  if (after === req.agentPreset) dropRequest()
}

export function apply(ctx) {
  log('boot: mounted')
  const timer = setTimeout(() => {
    Promise.resolve()
      .then(() => switchPreset(ctx))
      .catch((error) => {
        log(`switch failed: ${errorText(error)}`)
        writeResult({ ok: false, error: errorText(error) })
      })
  }, START_DELAY_MS)
  ctx.effect(() => () => clearTimeout(timer))
}
