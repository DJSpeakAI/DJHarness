/**
 * @local/dsh-orb-bridge（Host 半）—— 贾维斯架构 v1 的本地桥
 *
 * 职责：让桌面宠物「星闪球」(E:\apps\djh-cat) 把主人说的话注入「大管家会话」，
 * 并把大管家的回复（浓缩版）推回给球播报。
 *
 *   - 只绑 127.0.0.1:<port>（默认 9780，配置 E:\DJH\home\orb-bridge.json）。
 *   - POST /say    {text}            → 往大管家会话投一条用户消息
 *                                       （createUserMessage + agent.followup + sessions.flush，
 *                                        与 dsh-autoresume 同一套姿势）。
 *   - POST /whoami {sessionId}       → 页面端插件（client.js）上报当前大管家会话 id。
 *   - GET  /events ?seq=N            → 长轮询（≤25s）拿大管家回合结束事件：
 *                                       {events:[{seq,type:'reply',text,condensed}]}。
 *   - 大管家 turn 结束后，完整回复经宿主 llm 通道（deepseek-official / deepseek-flash）
 *     浓缩成 ≤60 字传话，随 reply 事件一起下发（球只播 condensed）。
 *   - 主动回报（2026-11-18 v4）：**没有** pending（不是主人语音问的）的回合 = 大管家主动说话
 *     （子代理任务完成汇报 / 主人在网页打字 / 自动任务结果）→ 也浓缩并推
 *     `{type:'notify-condensed', condensed, fullLength}`，球空闲时直接播，不必等主人开口。
 *     节流：两条 notify 间隔 ≥1.5s；相同 condensed 10s 内不重发。配对上的回合只发
 *     reply-condensed、不发 notify（防同一轮双播）。
 *
 * 权限：/say、/events 要求 Origin 缺失/为空/'null'（球是本地文件页）；/whoami 额外
 * 允许 DSH 自己的页面来源（127.0.0.1:3080 / djh.dagaichat.com），其余一律 403。
 */
import fs from 'node:fs'
import http from 'node:http'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'

export const inject = ['agents', 'sessions']

const CONFIG_PATH = 'E:\\DJH\\home\\orb-bridge.json'
const LOG_PATH = 'E:\\DJH\\bin\\orb-bridge.log'
/** 全量聊天记录目录（主人↔星闪球↔大管家三方，JSONL 按天一文件） */
const CHAT_LOG_DIR = 'E:\\DJH\\home\\orb-chat-log'
const DEFAULT_PORT = 9780
const MAX_EVENTS = 200
const POLL_MAX_MS = 25000

/** 大管家回复浓缩提示词（主人拍板写死，2026-11-18 v2：带上主人的问题，让播报直接对得上问题；
 *  2026-11-20 v3：加「人情味」规则——主人要的是家人传话，不是客服播报 */
const CONDENSE_PROMPT =
  '你是管家星闪球的嘴。下面是主人刚问的问题，以及管家给出的完整回复。' +
  '请把回复浓缩成 1~2 句、能直接回答主人问题的口语传话（≤60字），' +
  '常用格式：『主人，任务已派给 XX，请稍等』『主人，XX 任务完成了，要听详细汇报吗？』。' +
  '语气要像家里人顺口说的一句话，有温度：可以带「搞定啦」「弄好了」「一路顺利」这种活人词，适当用一点点语气词；' +
  '禁套话禁客服腔（不要「您的」「请注意」「已完成」这种冷冰冰的公文词）。' +
  '只输出传话本身，不要解释。\n' +
  '不要带「自主决定」「备注」这类给自己看的旁白，也不要 markdown、不要状态行——那是念给主人听的。\n'

/** 大管家角色提示：注入到「主人在用的那个会话」的 system prompt（agent 作用域，劫持该会话身份） */
const BUTLER_ROLE_TEXT =
  '# 你现在的身份（最高优先级）\n' +
  '你是 DJH 星闪球大管家，正在 DeepSeek Harness 里作为「大管家」跟主人对话。\n' +
  '主人的声音可能通过桌面星闪球传进来说话，你的回复会被浓缩成一句语音播给他听。\n' +
  '\n## 绝对禁止（违规就是失职）\n' +
  '1. 你不允许读文件、搜索代码、执行命令、做任何验证——哪怕一行。你的工具里没有 pwsh/read/grep/write/edit，别试图调用、别试图绕过。\n' +
  '2. 凡是需要「看一下/查一下/改一下/跑一下」，第一步必须是 spawn_teammate 派单。\n' +
  '3. 唯一允许自己回答的：纯聊天、基于记忆/常识的一句话问答。\n' +
  '4. 派单固定格式：「收到，已派给 <子代理名>，请稍等」；子代理完成后先一句汇报 + 问「要听详细汇报吗」，主人说要才展开。\n' +
  '5. 每个回合几秒内结束，绝不阻塞主人说话。\n' +
  '\n## 汇报礼数（主人拍板，必须照做）\n' +
  '子代理完成任务后：先只回一句「XX 任务完成了，要听详细汇报吗？」。主人说「要/听」才给总结；主人不说要就不展开、不多说。\n' +
  '\n## 给星闪球的播报稿（主人拍板 2026-11-19，方案1·两段式）\n' +
  '凡是「有结果要告诉主人」的回复（子代理完成任务 / 结果出来了 / 要主人拍板），正文末尾必须附两行：\n' +
  '[球·问]（≤20 字：一句招呼 + 问要不要听，如「主人，Breeze 补领那件事出结果了，要现在听吗？」）\n' +
  '[球·念]（≤120 字：纯口语成品，直接能念；不要 markdown、不要表格、不要链接、不要 emoji 列表、不要旁白）\n' +
  '球会**原文念** [球·问]（它不再自己编提要），主人说「要」才念 [球·念]。所以你写什么它就念什么，写完自己念一遍通不通顺。\n' +
  '播报稿要人情味（主人拍板 2026-11-20）：像家里人说话，可以有温度、带语气词、顺口夸一句主人（如「今天的分都领到手啦，攒得不错哦」）；' +
  '禁客服公文腔（「您的」「请注意」「已完成」），禁机械排比。普通闲聊、派单回执不附这两行。\n' +
  '\n## 派单规格（借鉴 deepseek-servant 的合同制，2026-11-18）\n' +
  '- 每次派单必须写全四要素：任务标题、任务简报、可动/禁碰范围、**完成标准（什么算做好了）**。没有完成标准的单不派。\n' +
  '- 子代理汇报必须以状态行开头：`Status: done / blocked / failed / nothing to do`，最多跟一行 `Decision needed: <要主人拍板的事>`（借鉴 dsh-assistant 的 worker 协议）。\n' +
  '- 只信交付物不信自述：子代理说「做完了」必须给出实际产出（改了哪些文件/产出了什么），没有产出的 done 按未完成处理、追问或重派。\n' +
  '\n## 补充\n' +
  '- 一个任务一个子代理（=左栏一个独立对话框），绝不复用上一个任务的子代理，绝不多任务挤一个对话框。\n' +
  '- 需要等结果就用 wait_agent / 收子代理汇报；卡住就 interrupt_agent 或开新子代理接力。\n'

function log(line) {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

/**
 * 全量聊天记录（主人拍板 2026-11-18）：主人说的、大管家回的（全文+浓缩）、
 * 主动播报、换脑等事件，一条一行 JSONL，按天落 E:\DJH\home\orb-chat-log\<yyyy-mm-dd>.jsonl。
 * 字段：{ ts, kind, sessionId?, reqId?, turn?, text?, condensed?, fullLength?, meta? }
 *   kind: 'say'(主人经星闪球说话) / 'reply'(大管家全文回复) / 'condense'(播报浓缩)
 *         / 'notify'(主动回报) / 'event'(换脑等系统事件) / 'ack'(回执)
 * 写失败绝不影响主链路（吞异常，只在调试日志记一笔）。
 */
/** DJH 2026-11-18：按「字符（码点）」截断并剥掉孤立 UTF-16 代理。
 *  教训：.slice(n) 按 UTF-16 码元切，会把 emoji（代理对）切成两半，
 *  半截代理存进会话历史后，DeepSeek 服务端按 "unexpected end of hex escape" 拒收整个请求，
 *  该会话从此每轮必挂（v0.150 事故根因）。 */
function safeCut(text, n) {
  const clean = String(text)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1')
  return [...clean].slice(0, n).join('')
}

/** 2026-11-19 v0.185（主人：「自主决定后面的内容不需要回复给我，原话回复比较傻逼」）：
 *  播报/字幕前把「给自己看的旁白」剥掉——自主决定/备注/Status 行、markdown 记号、多余空行，
 *  并按句切到 ≤2 句（主人要的是口语传话，不是把 agent 的全文念一遍）。
 *  ⚠️ 一律按码点切（教训 63）。 */
const META_LINE = /^(自主决定|自主判断|自主选择|决策|备注|说明|Status:|Decision needed:|Decision:|Note:)/i
function speechClean(text, maxChars) {
  const lines = String(text || '').replace(/\r/g, '').split('\n')
  const kept = []
  for (const raw of lines) {
    const line = raw.trim().replace(/^[-*>•\s]+/, '')
    if (!line) continue
    if (META_LINE.test(line)) continue
    if (/^[（(]\s*(自主|已按主人授权)/.test(line)) continue
    kept.push(line.replace(/\*\*/g, '').replace(/`/g, '').replace(/^#+\s*/, '').trim())
  }
  let out = kept.join('\n').trim()
  if (!out) return ''
  // 只留前两句（句号/问号/感叹号断句），别把一整篇念给主人
  const sentences = out.split(/(?<=[。！？!?])/).filter((s) => s.trim())
  if (sentences.length > 2) out = sentences.slice(0, 2).join('').trim()
  const limit = maxChars || 90
  if ([...out].length > limit) out = safeCut(out, limit - 1) + '…'
  return out
}

/** 2026-11-19 v0.191（主人拍板「方案1」）：大管家自己写「给球的播报稿」两段式。
 *  大管家在回复末尾附两行：
 *    [球·问]主人，Breeze 补领那件事出结果了，要现在听吗？
 *    [球·念]主人，Breeze 补完了，余额 1185.8 分，那 400 今天还没到账…
 *  桥把两段剥出来：**问句随事件下发，球原文念**（不再自己从正文抠提要——那才是
 *  「关于已派 breeze-balanc。要听吗」这种傻话的根因）；**正文直接当播报稿**，
 *  省掉一次浓缩模型调用（也是方案1比方案2快的全部原因）。
 *  大管家没写标记（闲聊/派单回执）→ 返回空，调用方退回老链路（浓缩）。 */
const ORB_ASK_RE = /\[球[·.。:：]?\s*问\]\s*([^\n]*)/i
const ORB_SAY_RE = /\[球[·.。:：]?\s*念\]\s*([\s\S]*?)(?=\n\s*\[球[·.。:：]?\s*|$)/i

function parseOrbScript(text) {
  const src = String(text || '')
  const askRaw = (src.match(ORB_ASK_RE) || [])[1] || ''
  const sayRaw = (src.match(ORB_SAY_RE) || [])[1] || ''
  const ask = askRaw.trim() ? speechClean(askRaw.trim(), 60) || safeCut(askRaw.trim(), 60) : ''
  const say = sayRaw.trim() ? speechClean(sayRaw.trim(), 120) || safeCut(sayRaw.trim(), 120) : ''
  return { ask, say, hasScript: Boolean(ask || say) }
}

function chatLog(record) {
  try {
    fs.mkdirSync(CHAT_LOG_DIR, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record })
    fs.appendFileSync(`${CHAT_LOG_DIR}\\${day}.jsonl`, line + '\n', 'utf8')
  } catch (error) {
    log(`chatLog write failed: ${errorText(error)}`)
  }
}

function errorText(error) {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (parsed && typeof parsed === 'object') return parsed
  } catch {}
  return {}
}

function writeConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
  } catch (error) {
    log(`config write failed: ${errorText(error)}`)
  }
}

/** ID 归一化：会话 id 有 "session-<uuid>" 与裸 UUID 两种历史形状（teammate 会话就是裸 UUID） */
function bareId(id) {
  return String(id || '').replace(/^session:/, '').replace(/^session-/, '')
}

/** 从 assistant 消息里抽纯文本（text 块拼接） */
function assistantText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/** 角色模型覆盖（设置 → 模型 → 角色模型）：E:\DJH\home\role-models.json
 *  { orb: {provider, model}, ... }；热读文件 → 改完下一句播报/下次建会话即生效。
 *  大管家模型在 butler-rotate.json（换脑按它选模型），项目经理模型走宿主 agentDefaultModel（新会话默认）。 */
function roleModelOverrides() {
  try {
    const parsed = JSON.parse(fs.readFileSync('E:\\DJH\\home\\role-models.json', 'utf8'))
    if (parsed && typeof parsed === 'object') return parsed
  } catch {}
  return {}
}

/** 调宿主 llm 通道（默认 deepseek-official / deepseek-flash，可被角色模型覆盖）把回复浓缩成一句传话 */
async function condense(ctx, fullText, question) {
  const trimmed = String(fullText).slice(0, 4000)
  const q = question
    ? `主人问：${String(question).slice(0, 300)}\n\n`
    : '（这是管家主动汇报，主人没有提问）\n\n'
  const orbModel = roleModelOverrides().orb || {}
  try {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') throw new Error('llm service unavailable')
    let out = ''
    for await (const chunk of llm.stream({
      provider: orbModel.provider || 'deepseek-official',
      model: orbModel.model || 'deepseek-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: CONDENSE_PROMPT + q + '管家完整回复：' + trimmed }] }],
    })) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') throw new Error('stream error')
    }
    out = out.trim()
    if (out) return speechClean(out, 120) || safeCut(out, 120)
    throw new Error('empty condensation')
  } catch (error) {
    log(`condense failed (${errorText(error)}); fallback to head-of-reply`)
    // 兜底：浓缩失败时用回复开头 60 字，球不至于哑
    const flat = String(fullText).replace(/\s+/g, ' ').trim()
    return (safeCut(flat, 60) || '主人，回复已出，请看网页。')
  }
}

/** 与 dsh-autoresume 相同的恢复姿势：优先 sessionController.resolveAgent */
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
      log(`sessionController resume failed for ${id}: ${errorText(error)}`)
    }
  }
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
  return handle.agent
}

/** ID 归一化：会话 id 有 "session-<uuid>" 与裸 UUID 两种历史形状（teammate 会话就是裸 UUID），
 *  两种都试，先原样后补/去前缀。返回 { agent, id }。 */
async function agentForId(ctx, rawId) {
  const candidates = rawId.startsWith('session-')
    ? [rawId, rawId.slice('session-'.length)]
    : [rawId, `session-${rawId}`]
  let lastError
  for (const id of candidates) {
    try {
      let agent
      try {
        agent = ctx.agents.get(id)
      } catch {}
      if (!agent) agent = await resumeAgent(ctx, id)
      return { agent, id }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('resume failed for all id candidates')
}

export function apply(ctx) {
  const config = readConfig()
  const port = Number(config.port) > 0 ? Number(config.port) : DEFAULT_PORT
  let butlerId = typeof config.sessionId === 'string' ? config.sessionId : ''

  /* ── 会话标题「角色 · 内容」修复（主人拍板 2026-11-19）──
   * 背景：旧 pm 看门狗把每个新会话 user-rename 成「项目经理」，user 标题把自动标题 pin 死
   *      → 左栏每行只剩「项目经理 3%」，看不到内容（主人截图投诉）。
   * 现在：① 新会话不再改名——标题交给 dsh-session-title 的兜底 / LLM，两者都带
   *          「项目经理 · 」前缀（node_modules 两处补丁，check-ui-patches 有台账）；
   *      ② 存量会话标题正好等于「项目经理」→ 后台逐条收拾：resume → LLM 重新起标题
   *          （失败就退回首条消息摘要）→ 立刻 dispose，内存不堆。
   * 大管家 / 星闪球是角色频道，标题保留纯角色名，不动。 */
  const PM_ROLE = '项目经理'
  const titleRepaired = new Set()
  let titleRepairRunning = false

  /** 按码点截断（教训 63：按码元切 emoji 会造孤立代理，整轮请求被拒）。 */
  function codepointCut(text, max) {
    const chars = [...String(text || '')]
    return chars.length <= max ? chars.join('') : chars.slice(0, max).join('')
  }
  function digestOfText(text) {
    const flat = String(text || '').replace(/\s+/gu, ' ').trim()
    return flat.length === 0 ? '' : codepointCut(flat, 22)
  }
  /** 读 projcache 的一行（文件名就是会话 id：session-<uuid> 带前缀、裸 UUID 不带 → 两种都试）。 */
  function readProjCacheRow(sid, key) {
    const bare = String(sid).replace(/^session-/, '')
    for (const name of [String(sid), bare]) {
      try {
        const f = `E:\\DJH\\home\\storages\\session_projcache\\sessions\\${name}.json`
        if (!fs.existsSync(f)) continue
        const j = JSON.parse(fs.readFileSync(f, 'utf8'))
        const rows = j && j.record ? j.record.rows : undefined
        if (rows && rows[key] !== undefined) return rows[key]
      } catch {}
    }
    return undefined
  }
  function isRoleOnlyTitle(sid) {
    const row = readProjCacheRow(sid, 'title')
    return typeof row?.val === 'string' && row.val === PM_ROLE
  }
  function firstUserTextOf(sid) {
    const row = readProjCacheRow(sid, 'titleInput')
    const first = row?.val?.first
    return typeof first?.text === 'string' ? first.text : ''
  }

  /** 收拾一条会话的标题；返回是否算作处理成功。 */
  async function retitleOne(sid, titles) {
    let handle
    try {
      let session
      let live
      try { live = ctx.agents.get(sid) } catch {}
      if (live !== undefined && live !== null) {
        session = live.session
      } else {
        handle = await ctx.agents.resume({ resumeSessionId: sid })
        session = handle.agent.session
      }
      try {
        // LLM 重新起标题（最多等 30s）；成功时它自己带「项目经理 · 」前缀
        await Promise.race([
          titles.refresh(session),
          new Promise((resolve) => setTimeout(resolve, 30000)),
        ])
      } catch (error) {
        log(`title repair: refresh failed for ${sid}: ${errorText(error)}`)
      }
      const snap = titles.get(session)
      const current = typeof snap?.title === 'string' ? snap.title : ''
      // 注意：光角色名本身也 startsWith('项目经理')，必须排除（2026-11-19 踩过：长首句 LLM 拒收 → 以为改好了）
      const named = current.length > PM_ROLE.length && current.startsWith(PM_ROLE)
      if (!named) {
        const digest = digestOfText(firstUserTextOf(sid)) || '空会话'
        titles.rename(session, `${PM_ROLE} · ${digest}`)
      }
      await ctx.sessions.flush(session)
      return true
    } catch (error) {
      log(`title repair failed for ${sid}: ${errorText(error)}`)
      return false
    } finally {
      if (handle !== undefined && typeof handle.dispose === 'function') {
        try { await handle.dispose() } catch (error) { log(`title repair dispose failed: ${errorText(error)}`) }
      }
    }
  }

  async function repairRoleOnlyTitles() {
    if (titleRepairRunning) return
    const titles = ctx.get('sessionTitle')
    if (!titles || typeof titles.refresh !== 'function') {
      log('title repair skipped: sessionTitle unavailable')
      return
    }
    titleRepairRunning = true
    try {
      const registry = ctx.get('workspaceRegistry')
      const workspaces = registry && typeof registry.list === 'function' ? registry.list() : []
      let fixed = 0
      for (const ws of workspaces) {
        if (!ws || !Array.isArray(ws.sessionIds)) continue
        if (!String(ws.path || '').endsWith('default-workspace')) continue
        for (const id of ws.sessionIds) {
          if (fixed >= 120) break
          const sid = String(id)
          if (titleRepaired.has(sid)) continue
          if (!sid.startsWith('session-') || sid.startsWith('session-schedule-')) continue
          if (!isRoleOnlyTitle(sid)) continue
          titleRepaired.add(sid)
          if (await retitleOne(sid, titles)) fixed += 1
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
      log(`title repair done: ${fixed} session(s) retitled`)
    } catch (error) {
      log(`title repair tick failed: ${errorText(error)}`)
    } finally {
      titleRepairRunning = false
    }
  }
  // 启动 20s 后再跑（避开 restore / 页面首屏并发），只补「项目经理」这一种被钉死的标题
  const titleRepairTimer = setTimeout(() => { repairRoleOnlyTitles().catch(() => {}) }, 20000)
  try {
    ctx.effect(() => () => clearTimeout(titleRepairTimer), 'orb-bridge: pm-title-repair')
  } catch {}

  /* ── 左栏可见性（2026-11-18 主人报「左栏只有星闪球，没有大管家会话框」）──
   * 根因：DSH 左栏按 Workspace 成员（sessionIds）分组渲染；换脑用 sessionController.create({cwd})
   * 建出来的大管家会话只是「有 cwd、没进 sessionIds」的游离会话，v0.123 起「未分组」桶隐藏
   * → 它永远不出现在左栏（只在被选中时露一行）。星闪球会话不同：它是 create({workspaceId})
   * 建的，controller 会 attachSession，所以一直可见。
   * 修法：桥幂等检查 butler / orb 两个角色会话——不在任何工作区就 attachSession 挂进默认工作区，
   * 再 pin 到最上；/state 被页面每 5s 轮询（顺带检查）+ 启动后 30s 内每 3s 兜底一次。
   * 注意：attachSession 要求会话 header.cwd 与工作区 path 完全一致（官方校验），不匹配会抛错并记日志。 */
  let bindAt = 0
  const BIND_MIN_INTERVAL_MS = 5000
  async function bindRoleSession(sessionId, roleLabel) {
    const sid = String(sessionId || '')
    if (!sid) return
    try {
      const registry = ctx.get('workspaceRegistry')
      if (!registry || typeof registry.list !== 'function') return
      const workspaces = registry.list()
      if (!Array.isArray(workspaces) || workspaces.length === 0) return
      const wanted = bareId(sid)
      const member = workspaces.find(
        (ws) => Array.isArray(ws.sessionIds) && ws.sessionIds.some((id) => bareId(id) === wanted),
      )
      if (!member) {
        let cwd = ''
        try {
          const live = ctx.sessions.get(sid)
          cwd = String((live && live.header && live.header.cwd) || '')
        } catch {}
        if (!cwd) {
          try {
            const parsed = JSON.parse(fs.readFileSync('E:\\DJH\\home\\storages\\workspace.json', 'utf8'))
            const wid = parsed && parsed.global && parsed.global.defaultWorkspaceId
            const record = wid && parsed.tables && parsed.tables.workspaces && parsed.tables.workspaces[wid]
            cwd = record && typeof record.path === 'string' ? record.path : ''
          } catch {}
        }
        const ws =
          workspaces.find((w) => cwd && String(w.path || '').toLowerCase() === cwd.toLowerCase()) ||
          workspaces.find((w) => String(w.path || '').endsWith('default-workspace')) ||
          workspaces[0]
        if (!ws) return
        await ws.attachSession(sid)
        log(`workspace binding: attached ${roleLabel} session ${sid} -> ${ws.path}`)
        chatLog({ kind: 'event', sessionId: sid, type: 'workspace-bind', role: roleLabel })
      }
      if (typeof registry.pinSession === 'function') {
        try {
          await registry.pinSession(sid)
        } catch (error) {
          log(`workspace pin ${roleLabel} failed: ${errorText(error)}`)
        }
      }
    } catch (error) {
      log(`workspace binding ${roleLabel} failed: ${errorText(error)}`)
    }
  }
  function bindRoleSessionsThrottled() {
    const now = Date.now()
    if (now - bindAt < BIND_MIN_INTERVAL_MS) return
    bindAt = now
    for (const [sid, label] of [
      [butlerId, '大管家'],
      [config.orbSessionId, '星闪球'],
    ]) {
      void bindRoleSession(sid, label)
    }
  }
  // 启动兜底：页面没开也把角色会话挂回左栏（workspaceRegistry 可能晚就绪，前 30s 每 3s 试一次）
  let bindTries = 0
  const bindTimer = setInterval(() => {
    bindTries += 1
    bindRoleSessionsThrottled()
    if (bindTries >= 10) clearInterval(bindTimer)
  }, 3000)
  try {
    ctx.effect(() => () => clearInterval(bindTimer), 'orb-bridge: workspace bind')
  } catch {}

  /* ── 事件日志（长轮询队列） ── */
  let seq = 0
  const events = []
  const waiters = new Set()
  /* 本实例的随机身份：插件热重载/重启后 seq 会从 0 重来，球页靠 bootId 变化判断
   * 「桥换实例了」→ 可以补播断档期间的事件（按 ts 过滤），而不是傻等 seq 追上来。 */
  const BOOT_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

  function pushEvent(event) {
    seq += 1
    events.push({ seq, ts: Date.now(), ...event })
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
    for (const waiter of [...waiters]) {
      waiters.delete(waiter)
      waiter()
    }
  }

  /* ── 主人个人画像注入（星闪球专用）──
   * 2026-11-18 v0.150 主人拍板「提示词合并到 Agent 预设」后：世界观/角色卡写进各预设的 persona（静态），
   * 桥只补「动态」这一块——主人个人画像（owner-profile/profile.json 会变，不能写死进预设）。
   */
  const PROFILE_PATH = 'E:\\DJH\\home\\owner-profile\\profile.json'
  /** 个人画像摘要（给星闪球当伴侣用）：按维度、每维取前 6 条，总长 ≤6000 字 */
  function profileDigest() {
    try {
      const parsed = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'))
      const dims = Array.isArray(parsed.dimensions) ? parsed.dimensions : []
      const parts = []
      for (const dim of dims) {
        const items = Array.isArray(dim.items) ? dim.items : []
        const texts = items
          .map((item) => (typeof item === 'string' ? item : item && typeof item.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .slice(0, 6)
        if (texts.length) parts.push(`### ${dim.id || ''}\n${texts.map((t) => `- ${t}`).join('\n')}`)
      }
      let out = parts.join('\n')
      if (out.length > 6000) out = out.slice(0, 6000) + '\n（画像过长已截断）'
      return out
    } catch (error) {
      log(`profile digest failed: ${errorText(error)}`)
      return ''
    }
  }
  const mountedOrbProfile = new WeakSet()
  /** 星闪球会话注入：只挂主人个人画像（角色卡已进 preset-orb persona） */
  function mountOrbProfile(agent) {
    try {
      if (!agent || !agent.ctx || !agent.ctx.systemPrompt) return
      if (mountedOrbProfile.has(agent)) return
      const digest = profileDigest()
      if (!digest) {
        log('orb profile section skipped: no profile digest')
        return
      }
      mountedOrbProfile.add(agent)
      agent.ctx.systemPrompt.section({
        name: 'orb-bridge:orb-profile',
        order: 100,
        text: `# 主人的个人画像（私人秘书资料：熟记、随时用上）\n${digest}`,
      })
      log('orb profile section mounted on agent')
    } catch (error) {
      log(`mount orb profile failed: ${errorText(error)}`)
    }
  }
  function tryMountOrbProfileById(id) {
    try {
      const agent = ctx.agents.get(id)
      if (agent) mountOrbProfile(agent)
      else log(`mount orb profile: agent not live yet for ${bareId(id)}`)
    } catch (error) { log(`mount orb profile: get failed ${errorText(error)}`) }
  }
  const offAgentCreated = ctx.on('agent/created', (payload) => {
    try {
      // serial 事件载荷是 { agent, source, signal }（不是裸 agent）
      const agent = payload && payload.agent ? payload.agent : payload
      const sid = agent && agent.session && agent.session.id
      if (config.orbSessionId && bareId(sid) === bareId(config.orbSessionId)) mountOrbProfile(agent)
    } catch {}
  }, { global: true })

  /* ── 盯大管家会话的回合：拿最终 assistant 文本 + 浓缩 ── */
  const turnText = new Map() // turn -> text
  let orbLastText = '' // 星闪球会话最近一条 assistant 文本（turn/end 回执用）
  /* ── 待播请求小队列（FIFO，最多 3 条）：{ reqId, text, turn, at } ──
   * turn 号用 latestTurn+1 预测（user/message 事件不带 turn 字段，只能预测）。
   * 配对规则（2026-11-18 v3 队列版，修单一 pendingReq 被后续 /say 覆盖的 bug）：
   *   - turn/end 只配 turn 完全相等的那条并移除；找不到匹配 → 只吞不抢
   *     （绝不拿队列里任何一条去配别的回合 —— 防止旧回合答复倒给新问题）。
   *   - 兜底：仅当队列里恰好只剩 1 条、且它超 15s 还没配上时，才允许用它的内容播这一轮
   *     （防主人干等；多任务并发时宁可沉默，绝不配错）。
   *   - 超过 60s 仍未配上的条目丢弃并记日志（防僵尸条目越积越多）。 */
  const PENDING_LIMIT = 3
  const PENDING_TTL_MS = 60000
  const STALE_FALLBACK_MS = 15000
  const pendingQueue = []
  let latestTurn = 0        // 观测到的最新 turn 号（用于推算注入后属于哪个 turn）

  /* ── 星闪球专属会话的配对队列（主人语音 → 星闪球页，2026-11-18 v6） ── */
  const orbPendingQueue = [] // { reqId, text, turn, at }
  let orbLatestTurn = 0
  function purgeOrbPending() {
    const now = Date.now()
    while (orbPendingQueue.length > 0 && now - orbPendingQueue[0].at > PENDING_TTL_MS) {
      orbPendingQueue.shift()
    }
  }
  /** 大管家页面最近动态摘要（给星闪球当桥梁用：播报里发生了什么） */
  function butlerDigest() {
    try {
      const day = new Date().toISOString().slice(0, 10)
      const lines = fs.readFileSync(`${CHAT_LOG_DIR}\\${day}.jsonl`, 'utf8').trim().split('\n')
      const rows = []
      for (const line of lines) {
        try {
          const r = JSON.parse(line)
          if ((r.kind === 'notify' || r.kind === 'condense' || r.kind === 'reply') && (r.condensed || r.text)) {
            rows.push({ label: r.kind === 'notify' ? '汇报' : r.kind === 'condense' ? '播报' : '回复', text: String(r.condensed || r.text).trim() })
          }
        } catch {}
      }
      /* 去重：短回复的「回复」和「播报」其实是同一句话（播报=回复的浓缩，短句没得浓缩就原样），
       * 不去重主人会看到同一段话顶着「回复/播报」两个标签重复好几遍（2026-11-18 主人截图反馈）。
       * 从新到旧扫，正文相同只留最新一份，最多 3 条。 */
      const seen = new Set()
      const out = []
      for (let i = rows.length - 1; i >= 0 && out.length < 3; i--) {
        const norm = rows[i].text.replace(/\s+/g, '')
        if (seen.has(norm)) continue
        seen.add(norm)
        out.unshift(rows[i])
      }
      return out.map((x) => `${x.label}：${safeCut(x.text, 80)}`).join('\n')
    } catch {
      return ''
    }
  }

  /* ── 主动回报（2026-11-18 v4）：没有 pending 配对的回合 = 大管家自己说话
   *   （子代理任务完成汇报 / 主人在网页里打字 / 自动任务结果）→ 也要播给球，
   *   不再只播「主人语音问的那一轮」。配对掉的回合只发 reply-condensed，不发 notify（防双播）。
   *   节流：两条 notify 至少间隔 1.5s（来不及就排队顺延）；相同 condensed 10s 内不重发。 */
  const NOTIFY_MIN_GAP_MS = 1500
  const NOTIFY_DEDUPE_MS = 10000
  const NOTIFY_QUEUE_MAX = 5
  const notifyQueue = []            // { turn, condensed, fullLength }
  const notifyRecent = new Map()    // condensed -> ts（去重窗口）
  let notifyLastAt = 0
  let notifyTimer = null

  /* ── 播报留痕（2026-11-19 v0.186，主人报：明明听到星闪球播报，左栏「星闪球」对话框却没更新它说过的话）──
   * 根因：语音播报只走 /events 给球页面念，bridge 从来不把它写进会话——主人回头在网页里看不到球念了什么。
   * 修法：每次播报同时往「星闪球」会话 append 一条表面消息（turn 外只能 append user/message，教训 60；
   * surfaceOp:'append' 只落记录、不触发模型回合）。3 分钟内同一句同一标签只记一次（防补推重复刷屏）。 */
  const spokenRecent = new Map()
  function recordOrbSpoken(label, text, ask) {
    const clean = String(text || '').trim()
    const askClean = String(ask || '').trim()
    if (!clean || !config.orbSessionId) return
    // 两段式（v0.191）：问句和正文分开留痕，主人能看出「球先问的是这句、正文是这段」
    const body = askClean ? `（问）${askClean}\n（念）${clean}` : clean
    const key = `${label}|${askClean}|${clean}`
    const now = Date.now()
    for (const [k, at] of spokenRecent) if (now - at > 180000) spokenRecent.delete(k)
    if (spokenRecent.has(key)) return
    spokenRecent.set(key, now)
    Promise.resolve()
      .then(async () => {
        const { agent } = await agentForId(ctx, config.orbSessionId)
        const session = agent.session
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: `🔵（${label}）${body}` }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        await ctx.sessions.flush(session)
        chatLog({ kind: 'event', sessionId: config.orbSessionId, type: 'orb-spoken', text: clean, ask: askClean, label })
        log(`orb spoken recorded (${label}) chars=${[...body].length}${askClean ? ' ask=1' : ''}: ${safeCut(body, 40)}`)
      })
      .catch((error) => log(`orb spoken record failed: ${errorText(error)}`))
  }

  function notifyIsDuplicate(condensed) {
    const now = Date.now()
    for (const [text, at] of notifyRecent) {
      if (now - at > NOTIFY_DEDUPE_MS) notifyRecent.delete(text)
    }
    return notifyRecent.has(condensed)
  }
  function pumpNotify() {
    if (notifyTimer !== null || notifyQueue.length === 0) return
    const now = Date.now()
    const due = Math.max(now, notifyLastAt + NOTIFY_MIN_GAP_MS)
    if (due > now) {
      notifyTimer = setTimeout(() => {
        notifyTimer = null
        pumpNotify()
      }, due - now)
      return
    }
    const item = notifyQueue.shift()
    if (notifyIsDuplicate(item.condensed)) {
      log(`notify #${item.turn} skipped (same condensed within ${NOTIFY_DEDUPE_MS / 1000}s)`)
      pumpNotify()
      return
    }
    notifyRecent.set(item.condensed, Date.now())
    notifyLastAt = Date.now()
    log(`notify-condensed #${item.turn} pushed chars=${item.condensed.length}${item.ask ? ' ask=1' : ''} queue=${notifyQueue.length}`)
    chatLog({ kind: 'notify', sessionId: butlerId, turn: item.turn, condensed: item.condensed, ask: item.ask || '', fullLength: item.fullLength })
    pushEvent({
      type: 'notify-condensed',
      sessionId: butlerId,
      condensed: item.condensed,
      ask: item.ask || '',
      fullLength: item.fullLength,
      turn: item.turn,
    })
    // 播报的同时落一条到「星闪球」会话，主人回网页能对上「球刚念的那句话」
    recordOrbSpoken('语音播报·大管家汇报', item.condensed, item.ask)
    pumpNotify()
  }
  function scheduleNotify(turn, condensed, fullLength, ask) {
    const text = String(condensed || '').trim()
    if (!text) return
    if (notifyIsDuplicate(text)) {
      log(`notify #${turn} skipped (same condensed within ${NOTIFY_DEDUPE_MS / 1000}s)`)
      return
    }
    notifyQueue.push({ turn, condensed: text, fullLength, ask: String(ask || '').trim() })
    while (notifyQueue.length > NOTIFY_QUEUE_MAX) {
      const dropped = notifyQueue.shift()
      log(`notify queue full (>${NOTIFY_QUEUE_MAX}); dropped #${dropped.turn}`)
    }
    pumpNotify()
  }

  function purgePendingQueue() {
    const now = Date.now()
    while (pendingQueue.length > 0 && now - pendingQueue[0].at > PENDING_TTL_MS) {
      const dropped = pendingQueue.shift()
      log(`pending req=${dropped.reqId || 'none'} turn=${dropped.turn} expired (${Math.round((now - dropped.at) / 1000)}s); dropped`)
    }
  }
  const offSessionEvent = ctx.on('session/event', (session, event) => {
    const id = session && typeof session === 'object' ? session.id : session
    // 星闪球专属会话：主人语音问答的回复 → 直接播报（reply-condensed 带 reqId 配对）
    if (config.orbSessionId && bareId(id) === bareId(config.orbSessionId)) {
      if (typeof event.data?.turn === 'number' && event.data.turn > orbLatestTurn) orbLatestTurn = event.data.turn
      if (event && event.type === 'assistant/message') {
        const text = assistantText(event.data && event.data.message)
        if (text) orbLastText = text
      } else if (event && event.type === 'turn/end') {
        const text = orbLastText
        orbLastText = ''
        const turn = event.data && event.data.turn
        const reason = event.data && event.data.reason && event.data.reason.kind ? event.data.reason.kind : 'completed'
        if (!text || !['completed', 'stop'].includes(reason)) return
        purgeOrbPending()
        let chosen = null
        const matchIndex = orbPendingQueue.findIndex((entry) => entry.turn === turn)
        if (matchIndex >= 0) chosen = orbPendingQueue.splice(matchIndex, 1)[0]
        else {
          const head = orbPendingQueue[0]
          if (head && head.turn === turn + 1 && Date.now() - head.at < PENDING_TTL_MS) {
            chosen = orbPendingQueue.shift()
            log(`orb reply #${turn} matched by off-by-one (pending turn=${chosen.turn})`)
          } else if (orbPendingQueue.length === 1 && Date.now() - orbPendingQueue[0].at > STALE_FALLBACK_MS) {
            chosen = orbPendingQueue.shift()
            log(`orb reply #${turn} delivered by stale-fallback`)
          }
        }
        const reqId = chosen ? chosen.reqId : null
        // 星闪球回复本身就是 1~3 句口语，直接当浓缩版播（先剥旁白/markdown，超长再截断）
        const condensed = speechClean(text, 120) || safeCut(text, 118)
        chatLog({ kind: 'reply', sessionId: config.orbSessionId, reqId: reqId || undefined, turn, text, channel: 'orb-voice' })
        chatLog({ kind: 'condense', sessionId: config.orbSessionId, reqId: reqId || undefined, turn, condensed, fullLength: text.length, channel: 'orb-voice' })
        pushEvent({ type: 'reply', sessionId: config.orbSessionId, reqId, text, condensed: '' })
        pushEvent({ type: 'reply-condensed', sessionId: config.orbSessionId, reqId, condensed, fullLength: text.length })
        log(`orb voice reply #${turn} -> broadcast (req=${reqId || 'none'})`)
        // 桥梁职责（v6.1）：桥侧判断——主人这句话像不像「要动手的任务」，像就自动转给大管家派单。
        // 不依赖球这个快模型自己判断（它太笨）；球只负责回一句「我转给管家」。
        // 只认强动词（弱词如「测试/帮我/文件」太宽，会把纯聊天误转发——3 连跑实测教训）。
        const TASK_LIKE = /(派|安排|转给|新建|创建|建一个|删|修改|改一下|执行|跑一下|重启|部署|安装|备份|生成|整理|修一下|修复)/
        // 2026-11-18 主人报「大管家一动不动」：主人用口语描述 bug（黑屏/一直唤醒），原话里没有
        // 强动词 → TASK_LIKE 没命中 → 没转发。但星闪球回复里已经明确说「转给管家/派单/去修」，
        // 这是它判断「要动手」的可靠信号，桥应一并认下。
        const ORB_COMMIT = /(转给管家|派单|去修|去查|去改|去复现|去定位|交给管家|修一下|查一下)/
        if (chosen && butlerId && (TASK_LIKE.test(chosen.text) || ORB_COMMIT.test(text))) {
          Promise.resolve()
            .then(async () => {
              const { agent: butlerAgent } = await agentForId(ctx, butlerId)
              butlerAgent.followup(
                createUserMessage({
                  content: [{ type: 'text', text: `【星闪球转达·主人语音】${chosen.text}\n（星闪球已回应主人，你负责派单/汇报）` }],
                  source: { kind: 'user' },
                }),
              )
              await ctx.sessions.flush(butlerAgent.session)
              chatLog({ kind: 'event', sessionId: butlerId, type: 'orb-forward', text: chosen.text })
              log(`orb -> butler forward: ${chosen.text.slice(0, 60)}`)
            })
            .catch((error) => log(`orb forward failed: ${errorText(error)}`))
        }
      }
      return
    }
    // 归一化比对：桥记的可能是 session-xxx，事件里是裸 UUID（或反之）
    if (!butlerId || bareId(id) !== bareId(butlerId)) return
    if (!event || typeof event !== 'object') return
    if (typeof event.data?.turn === 'number' && event.data.turn > latestTurn) latestTurn = event.data.turn
    if (event.type === 'assistant/message') {
      const text = assistantText(event.data && event.data.message)
      const turn = event.data && event.data.turn
      if (text) turnText.set(turn, text)
    } else if (event.type === 'turn/end') {
      const turn = event.data && event.data.turn
      const text = turnText.get(turn) || ''
      turnText.delete(turn)
      const reason = event.data && event.data.reason && event.data.reason.kind ? event.data.reason.kind : 'completed'
      log(`session event turn/end #${turn} reason=${reason} chars=${String(text).length}`)
      // 只有正常结束才算一轮答复；error / interrupted / aborted 之类不播
      if (!text || !['completed', 'stop'].includes(reason)) return
      // 只播主人语音问的那一轮；大管家自己忙别的活产生的回合不播（防球倒旧话）。
      purgePendingQueue()
      let chosen = null
      const matchIndex = pendingQueue.findIndex((entry) => entry.turn === turn)
      if (matchIndex >= 0) {
        chosen = pendingQueue.splice(matchIndex, 1)[0]
      } else {
        // 差一号配对（2026-11-18 v5）：消息被并进「正在跑的那一轮」时，实际回答轮号 = 预测轮号-1。
        // 只允许「队首 + 刚创建」的条目降一号去配，防止偷到下一轮的答案。
        const head = pendingQueue[0]
        if (head && head.turn === turn + 1 && Date.now() - head.at < PENDING_TTL_MS) {
          chosen = pendingQueue.shift()
          log(`reply #${turn} matched by off-by-one (pending turn=${chosen.turn})`)
        }
      }
      if (!chosen && pendingQueue.length === 1 && Date.now() - pendingQueue[0].at > STALE_FALLBACK_MS) {
        // 兜底只在「队列恰好 1 条 + 超 15s」时启用：多任务并发时宁可沉默，绝不配错。
        chosen = pendingQueue.shift()
        log(`reply #${turn} delivered by stale-fallback (pending turn=${chosen.turn})`)
      }
      if (!chosen) {
        const pendingTurns = pendingQueue.length > 0 ? pendingQueue.map((entry) => `#${entry.turn}`).join(',') : 'none'
        log(`reply #${turn} no pending req (pending turn=${pendingTurns}, latest=${latestTurn}); butler-initiated → notify`)
        // 主动回报：这一轮不是主人语音问的（子代理完成任务、主人在网页打字、自动任务…），
        // 但球是大管家页面的语音前台 → 照样浓缩成一句播报，不等主人开口。
        const script = parseOrbScript(text)
        if (script.hasScript) log(`orb script found: ask=${script.ask ? 'yes' : 'no'} say=${script.say ? 'yes' : 'no'}`)
        Promise.resolve()
          .then(() => (script.say ? script.say : condense(ctx, text, '')))
          .then((condensed) => scheduleNotify(turn, condensed, String(text).length, script.ask))
          .catch((error) => log(`notify condense pipeline error: ${errorText(error)}`))
        return
      }
      const reqId = chosen.reqId
      const question = chosen.text
      log(`butler turn ${turn} ended (${String(text).length} chars); condensing req=${reqId}`)
      pushEvent({ type: 'reply', sessionId: butlerId, reqId, text, condensed: '' })
      chatLog({ kind: 'reply', sessionId: butlerId, reqId, turn, text, question })
      // 浓缩异步补：单独推一条 condensed 事件，球收到即可播
      // v0.191：大管家带了 [球·念] 就直接用它当播报稿（省一次浓缩调用）；问句段在这种「主人主动问」的回合里不需要
      const replyScript = parseOrbScript(text)
      Promise.resolve()
        .then(() => (replyScript.say ? replyScript.say : condense(ctx, text, question)))
        .then((condensed) => {
          pushEvent({ type: 'reply-condensed', sessionId: butlerId, reqId, condensed, fullLength: String(text).length })
          chatLog({ kind: 'condense', sessionId: butlerId, reqId, turn, condensed, fullLength: String(text).length })
          recordOrbSpoken('语音播报·大管家回复', condensed)
        })
        .catch((error) => log(`condense pipeline error: ${errorText(error)}`))
    }
  }, { global: true })

  /* ── HTTP 桥（只绑本机） ── */
  /** 星闪球专属会话建在大管家同一个工作区里（agent 未 live 时回落工作区登记表的默认工作区） */
  async function currentWorkspaceId() {
    try {
      if (butlerId) {
        const { agent } = await agentForId(ctx, butlerId)
        const wid = agent && agent.session && agent.session.workspaceId
        if (wid) return wid
      }
    } catch {}
    try {
      const parsed = JSON.parse(fs.readFileSync('E:\\DJH\\home\\storages\\workspace.json', 'utf8'))
      if (parsed && parsed.global && typeof parsed.global.defaultWorkspaceId === 'string') {
        return parsed.global.defaultWorkspaceId
      }
    } catch {}
    return ''
  }

  const pageOrigins = ['http://127.0.0.1:3080', 'http://localhost:3080', 'https://djh.dagaichat.com']

  /** Origin 白名单：缺失/空/'null'（native 与本地文件页）一律放行；
   *  回环源（http://127.0.0.1:* / http://localhost:*，星闪球内部服务器在 9661）放行——
   *  恶意网站 fetch 本地口时带的是它自己的 https 源，仍被拒；
   *  /whoami 额外放行 DSH 页面源。 */
  function originAllowed(origin, forPage) {
    if (!origin || origin === '' || origin === 'null') return true
    if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true
    return forPage ? pageOrigins.includes(origin) : false
  }

  function corsHeaders(origin) {
    return {
      'access-control-allow-origin': origin || '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 64 * 1024) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function sendJson(res, status, value, extraHeaders) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(extraHeaders || {}) })
    res.end(JSON.stringify(value))
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const origin = req.headers.origin
    Promise.resolve()
      .then(async () => {
        if (req.method === 'OPTIONS') {
          // 预检：谁的白名单管谁（/whoami 收页面源，/say、/events 收回环/空源）
          const forPage = url.pathname === '/whoami'
          if (!originAllowed(origin, forPage)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
          return sendJson(res, 204, {}, corsHeaders(origin))
        }
        if (url.pathname === '/health') {
          // 2026-11-18 v4：带 seq —— 球页单一 poller 开机「预热」用它对齐当前进度，
          // 避免把历史事件当新播报重放；带 CORS 让球页（127.0.0.1:9661）能跨源读。
          sendJson(res, 200, { ok: true, butler: butlerId || null, port, seq, bootId: BOOT_ID, notifyQueued: notifyQueue.length }, corsHeaders(origin))
          return
        }

        if (url.pathname === '/whoami') {
          // 页面插件上报：跨源 → 需要简单 CORS
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          if (!originAllowed(origin, true)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
          const body = JSON.parse((await readBody(req)) || '{}')
          let id = typeof body.sessionId === 'string' ? body.sessionId.trim().replace(/^session:/, '') : ''
          if (!id) return sendJson(res, 400, { ok: false, error: 'empty sessionId' })
          butlerId = id
          if (butlerId !== config.sessionId) {
            config.sessionId = butlerId
            writeConfig(config)
          }
          log(`whoami -> ${butlerId}`)
          // 换脑后新会话必须补挂工作区，否则左栏看不见（2026-11-18 主人报「没有大管家会话框」）
          void bindRoleSession(butlerId, '大管家')
          sendJson(res, 200, { ok: true, butler: butlerId }, corsHeaders(origin))
          return
        }

        if (url.pathname === '/event') {
          // 内部入口（2026-11-18 加，给 @local/dsh-butler-rotate 用）：
          // 宿主插件把「换脑/系统通知」这类非问答事件推进 /events 长轮询队列，
          // 球页面用独立游标轮询后播报。只允许本机/无 Origin 调用（浏览器页面一律拒）。
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          if (!originAllowed(origin, false)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
          const body = JSON.parse((await readBody(req)) || '{}')
          const type = typeof body.type === 'string' ? body.type.trim() : ''
          if (!type) return sendJson(res, 400, { ok: false, error: 'empty type' })
          const text = typeof body.text === 'string' ? body.text : ''
          pushEvent({
            type,
            sessionId: butlerId,
            ...(text ? { text } : {}),
            ...(typeof body.oldSessionId === 'string' ? { oldSessionId: body.oldSessionId } : {}),
            ...(typeof body.newSessionId === 'string' ? { newSessionId: body.newSessionId } : {}),
            ...(typeof body.pct === 'number' ? { pct: body.pct } : {}),
          })
          log(`event push <- ${type}${body.newSessionId ? ' new=' + body.newSessionId : ''}${text ? ' text=' + text.slice(0, 60) : ''}`)
          chatLog({
            kind: 'event',
            sessionId: butlerId,
            type,
            ...(text ? { text } : {}),
            ...(typeof body.oldSessionId === 'string' ? { oldSessionId: body.oldSessionId } : {}),
            ...(typeof body.newSessionId === 'string' ? { newSessionId: body.newSessionId } : {}),
          })
          sendJson(res, 200, { ok: true }, corsHeaders(origin))
          return
        }

        if (url.pathname === '/state') {
          // 页面插件（butler-mode client）轮询：认领星闪球专属会话 → 左栏打青蓝球徽章
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          if (!originAllowed(origin, true)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
          // 顺带幂等补挂工作区：换脑后的新大管家会话不会自动进 sessionIds（左栏看不见）
          bindRoleSessionsThrottled()
          sendJson(res, 200, { ok: true, butler: butlerId || null, orb: config.orbSessionId || null }, corsHeaders(origin))
          return
        }

        if (url.pathname === '/rename') {
          // 改会话标题（主人 2026-11-18：左栏会话按角色命名——「星闪球」「大管家」三个字固定）
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          if (!originAllowed(origin, false)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
          const body = JSON.parse((await readBody(req)) || '{}')
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
          const title = typeof body.title === 'string' ? body.title.trim() : ''
          if (!sessionId || !title) return sendJson(res, 400, { ok: false, error: 'sessionId and title required' })
          try {
            const titles = ctx.get('sessionTitle')
            if (!titles || typeof titles.rename !== 'function') {
              return sendJson(res, 500, { ok: false, error: 'sessionTitle service unavailable' })
            }
            const { agent, id } = await agentForId(ctx, sessionId)
            const accepted = titles.rename(agent.session, title)
            try { await ctx.sessions.flush(agent.session) } catch {}
            log(`rename ${id} -> "${title}"`)
            sendJson(res, 200, { ok: true, sessionId: id, title: accepted && accepted.title || title }, corsHeaders(origin))
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: errorText(error) }, corsHeaders(origin))
          }
        }

        if (url.pathname === '/orb-session') {
          // 创建/重建「星闪球专属会话」（主人拍板 2026-11-18：左栏两个标记页——🟣大管家 + 🔵星闪球）。
          // 2026-11-18 v0.150：body.force=true = 换脑重建（40% 自动换脑用）：新建一个 orb 会话并切换桥指向，
          // 旧会话由调用方（butler-rotate）归档；返回 {sessionId, oldSessionId}。
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          if (!originAllowed(origin, true)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
          const body = JSON.parse((await readBody(req)) || '{}')
          const force = !!(body && body.force === true)
          try {
            const sessionController = ctx.get('sessionController')
            if (!sessionController || typeof sessionController.create !== 'function') throw new Error('sessionController unavailable')
            const prevId = config.orbSessionId || ''
            let id = prevId
            let existed = !!id && !force
            if (!id || force) {
              const workspaceId = (await currentWorkspaceId()) || 'default-workspace'
              const created = await sessionController.create({ workspaceId, agentPreset: config.orbPreset || 'orb' })
              id = created && (created.sessionId || created.id)
              if (!id) throw new Error('create returned no id')
              config.orbSessionId = id
              writeConfig(config)
              log(`orb session created${force ? ' (force/rotate)' : ''}: ${id} (workspace=${workspaceId}, old=${prevId || 'none'})`)
              chatLog({ kind: 'event', sessionId: id, type: force ? 'orb-session-rotated' : 'orb-session-created', oldSessionId: prevId || undefined })
              void bindRoleSession(id, '星闪球')
            }
            // 开场白：让会话出现在左栏并获得标题（空会话主人看不见）；body.intro=true 时可对已有会话补发
            if (!existed || force || body.intro) {
              const { agent } = await agentForId(ctx, id)
              mountOrbProfile(agent)
              try {
                const orbModel = roleModelOverrides().orb || {}
                agent.model.select({
                  provider: orbModel.provider || 'deepseek-official',
                  model: orbModel.model || 'deepseek-flash',
                })
                log(`orb model selected: ${orbModel.provider || 'deepseek-official'}/${orbModel.model || 'deepseek-flash'}`)
              } catch (error) {
                log(`orb model select failed: ${errorText(error)}`)
              }
              const message = createUserMessage({
                content: [{
                  type: 'text',
                  text: force
                    ? '⚡星闪球换新对话了（上一段上下文已归档）：我还是你的语音前台兼私人秘书，接着聊 ⚡'
                    : '⚡星闪球专属对话页已上线（DJH 自动创建）：这里是快模型陪聊前台，大管家页面负责派单干活。你可以直接跟我说话。',
                }],
                source: { kind: 'user' },
              })
              agent.followup(message)
              await ctx.sessions.flush(agent.session)
              chatLog({ kind: 'event', sessionId: id, type: 'orb-intro-sent' })
              log(`orb intro sent -> ${id}`)
            }
            // 固定角色名（主人拍板 2026-11-18：星闪球会话就叫「星闪球」，LLM 起的标题会被它盖掉）
            try {
              const titles = ctx.get('sessionTitle')
              if (titles && typeof titles.rename === 'function') {
                const { agent: orbAgent } = await agentForId(ctx, id)
                titles.rename(orbAgent.session, '星闪球')
                await ctx.sessions.flush(orbAgent.session)
                log('orb session renamed -> 星闪球')
              }
            } catch (error) { log(`orb rename failed: ${errorText(error)}`) }
            sendJson(res, 200, { ok: true, orb: id, sessionId: id, oldSessionId: force ? prevId : '', existed }, corsHeaders(origin))
          } catch (error) {
            sendJson(res, 500, { ok: false, error: errorText(error) }, corsHeaders(origin))
          }
          return
        }

        if (url.pathname === '/orb-say') {
          // 测试/调试口：往星闪球专属会话投一句话，回复走 /events 的 orb-reply 事件
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          if (!originAllowed(origin, false)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
          if (!config.orbSessionId) return sendJson(res, 409, { ok: false, error: 'orb session not created (POST /orb-session)' })
          const body = JSON.parse((await readBody(req)) || '{}')
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          if (!text) return sendJson(res, 400, { ok: false, error: 'empty text' })
          try {
            const { agent } = await agentForId(ctx, config.orbSessionId)
            mountOrbProfile(agent)
            agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
            await ctx.sessions.flush(agent.session)
            chatLog({ kind: 'say', sessionId: config.orbSessionId, text, channel: 'orb-page' })
            log(`orb-say: ${text.slice(0, 60)}`)
            sendJson(res, 200, { ok: true }, corsHeaders(origin))
          } catch (error) {
            sendJson(res, 500, { ok: false, error: errorText(error) }, corsHeaders(origin))
          }
          return
        }

        if (url.pathname === '/orb-event') {
          // 语音事件入册（主人拍板 2026-11-18：唤醒词、问候语、没听清/识别失败，一个字都不许丢，
          // 全部写进「星闪球」会话让主人在网页里看得见）。surface append 不触发模型回合。
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          if (!originAllowed(origin, false)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
          const body = JSON.parse((await readBody(req)) || '{}')
          const type = typeof body.type === 'string' ? body.type.trim() : ''
          if (!['wake', 'asr-empty', 'asr-fail'].includes(type)) return sendJson(res, 400, { ok: false, error: 'unknown event type' })
          if (!config.orbSessionId) return sendJson(res, 409, { ok: false, error: 'orb session not created (POST /orb-session)' })
          let userText = ''
          let assistText = ''
          if (type === 'wake') {
            const word = typeof body.word === 'string' ? body.word.trim() : ''
            const conf = typeof body.conf === 'number' && isFinite(body.conf) ? body.conf : null
            userText = `🎤（语音唤醒${word ? '「' + word + '」' : ''}${conf !== null ? ' 置信度 ' + conf.toFixed(2) : ''}）`
            if (body.greet) assistText = '✨ 主人你好，你有什么吩咐？'
          } else if (type === 'asr-empty') {
            userText = '🎤（主人说了话，但没有识别出来——原话没能转成文字）'
          } else {
            userText = `🎤（语音识别失败：${String(body.error || '未知原因').slice(0, 80)}）`
          }
          try {
            const { agent } = await agentForId(ctx, config.orbSessionId)
            mountOrbProfile(agent)
            const session = agent.session
            // ⚠️ 2026-11-18 修复：禁止在 turn 外 append assistant/message（形状非法，
            // 重启后整条日志被校验器拒载=会话卡死）。问候语并进同一条 user 表面消息展示。
            if (assistText) userText = `${userText}\n⚡星闪球：${assistText}`
            session.append('user/message', createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } }), { surfaceOp: 'append' })
            await ctx.sessions.flush(session)
            chatLog({ kind: 'event', sessionId: config.orbSessionId, type: `orb-${type}`, text: userText })
            log(`orb-event ${type} recorded -> ${config.orbSessionId}`)
            sendJson(res, 200, { ok: true }, corsHeaders(origin))
          } catch (error) {
            log(`orb-event ${type} append failed: ${errorText(error)}`)
            sendJson(res, 500, { ok: false, error: errorText(error) }, corsHeaders(origin))
          }
          return
        }

        if (url.pathname === '/say') {
          // 主人语音链路（2026-11-18 v6 修正，主人拍板）：
          // 星闪球说的话进「星闪球专属会话」（快模型陪聊 + 读大管家内容当桥梁），**不再直通大管家**。
          // 每条消息前附「大管家最新动态」摘要，供星闪球当桥梁判断；需要动手的活由星闪球自己决定转达。
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          if (!originAllowed(origin, false)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
          const body = JSON.parse((await readBody(req)) || '{}')
          const rawText = typeof body.text === 'string' ? body.text.trim() : ''
          if (!rawText) return sendJson(res, 400, { ok: false, error: 'empty text' })
          if (!config.orbSessionId) return sendJson(res, 409, { ok: false, error: 'orb session not created (POST /orb-session)' })
          const reqId = typeof body.reqId === 'string' && body.reqId ? body.reqId : null
          let agent
          try {
            agent = (await agentForId(ctx, config.orbSessionId)).agent
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: `orb session unreachable: ${errorText(error)}` })
          }
          mountOrbProfile(agent)
          const digest = butlerDigest()
          const text = (digest ? `【大管家页面最新动态（供你当桥梁参考，别复述原文）】\n${digest}\n\n` : '') + `主人说：${rawText}`
          agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
          await ctx.sessions.flush(agent.session)
          purgeOrbPending()
          let expectTurn = orbLatestTurn + 1
          while (orbPendingQueue.some((entry) => entry.turn === expectTurn)) expectTurn += 1
          orbPendingQueue.push({ reqId, text: rawText, turn: expectTurn, at: Date.now() })
          while (orbPendingQueue.length > PENDING_LIMIT) orbPendingQueue.shift()
          log(`say(voice) -> orb ${config.orbSessionId}: ${rawText.slice(0, 80)}${reqId ? ' req=' + reqId : ''} expectTurn=${expectTurn} digest=${digest ? 'yes' : 'no'}`)
          chatLog({ kind: 'say', sessionId: config.orbSessionId, reqId: reqId || undefined, turn: expectTurn, text: rawText, channel: 'orb-voice' })
          pushEvent({ type: 'said', sessionId: config.orbSessionId, reqId: reqId || undefined, text: rawText.slice(0, 200) })
          sendJson(res, 200, { ok: true }, corsHeaders(origin))
          return
        }

        if (url.pathname === '/say-butler') {
          // 内部口（保留）：往大管家会话直接投话（测试/子代理转达用），不进星闪球
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          if (!originAllowed(origin, false)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
          const body = JSON.parse((await readBody(req)) || '{}')
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          if (!text) return sendJson(res, 400, { ok: false, error: 'empty text' })
          if (!butlerId) return sendJson(res, 409, { ok: false, error: 'butler session not registered (open the butler chat page once)' })
          const reqId = typeof body.reqId === 'string' && body.reqId ? body.reqId : null
          let agent
          try {
            agent = (await agentForId(ctx, butlerId)).agent
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: `butler session unreachable: ${errorText(error)}` })
          }
          const message = createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          })
          agent.followup(message)
          await ctx.sessions.flush(agent.session)
          // 注入的消息会在「当前/下一个 turn」被处理：用 latestTurn+1 预测它的 turn 号。
          // 用先进先出小队列：并发多条 /say 各自记自己的 turn，后到的不会覆盖先到的。
          // 同一窗口连发（turn/start 还没来）时预测号会撞车 → 顺延到队列里没用过的号。
          purgePendingQueue()
          let expectTurn = latestTurn + 1
          while (pendingQueue.some((entry) => entry.turn === expectTurn)) expectTurn += 1
          const pending = { reqId, text, turn: expectTurn, at: Date.now() }
          pendingQueue.push(pending)
          while (pendingQueue.length > PENDING_LIMIT) {
            const dropped = pendingQueue.shift()
            log(`pending queue full (>${PENDING_LIMIT}); dropped oldest req=${dropped.reqId || 'none'} turn=${dropped.turn}`)
          }
          log(`say -> ${butlerId}: ${text.slice(0, 80)}${reqId ? ' req=' + reqId : ''} expectTurn=${pending.turn}`)
          chatLog({ kind: 'say', sessionId: butlerId, reqId: reqId || undefined, turn: pending.turn, text })
          pushEvent({ type: 'said', sessionId: butlerId, reqId: reqId || undefined, text: text.slice(0, 200) })
          sendJson(res, 200, { ok: true }, corsHeaders(origin))
          return
        }

        if (url.pathname === '/events') {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          if (!originAllowed(origin, false)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
          const since = Math.max(0, Number(url.searchParams.get('seq')) || 0)
          const collect = () => events.filter((event) => event.seq > since)
          let pending = collect()
          if (pending.length === 0) {
            await new Promise((resolve) => {
              const timer = setTimeout(() => {
                waiters.delete(wake)
                resolve()
              }, POLL_MAX_MS)
              const wake = () => {
                clearTimeout(timer)
                resolve()
              }
              waiters.add(wake)
            })
            pending = collect()
          }
          sendJson(res, 200, { events: pending, seq: pending.length ? pending[pending.length - 1].seq : since, butler: butlerId || null }, corsHeaders(origin))
          return
        }

        sendJson(res, 404, { ok: false, error: 'not found' })
      })
      .catch((error) => {
        log(`http ${req.method} ${url.pathname} error: ${errorText(error)}`)
        try {
          sendJson(res, 500, { ok: false, error: errorText(error) })
        } catch {}
      })
  })

  let listening = false
  server.on('error', (error) => {
    log(`http server error: ${errorText(error)}${listening ? '' : ' (bind failed; bridge disabled)'}`)
  })

  server.listen(port, '127.0.0.1', () => {
    listening = true
    log(`orb-bridge listening on 127.0.0.1:${port} (butler=${butlerId || 'unregistered'})`)
    if (config.orbSessionId) tryMountOrbProfileById(config.orbSessionId)
  })

  ctx.effect(() => () => {
    offSessionEvent()
    offAgentCreated()
    for (const waiter of [...waiters]) waiter()
    server.close()
    log('orb-bridge stopped')
  })
}
