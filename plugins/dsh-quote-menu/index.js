/**
 * 划词菜单（Host 半）—— 给「问 AI」小浮窗当后端。
 *
 * 两个接口（都挂在 /quote-menu-api 前缀下，走宿主 webServer）：
 *
 *   POST /quote-menu-api/models
 *       返回「可选的模型清单」：优先用 client 的 ctx.modelDirectories（跟输入框
 *       右下角那个选择器同一份目录），这里只是它拿不到时的兜底 —— 直接问
 *       llm.listProviders() / llm.listModels()。
 *
 *   POST /quote-menu-api/ask   （流式，NDJSON，一行一个事件）
 *       入参 { sessionId, provider, model, turns: [{role, text}] }
 *       ① 用 session.deriveMessages() 取当前会话「模型可见的完整历史」，
 *          只保留 user / assistant 的纯文本（丢掉 system、开发者提示、工具调用
 *          和工具结果，避免把几万字的工具输出也塞进去）；
 *       ② 客户端自己那几轮临时对话接在后面；
 *       ③ 走 ctx.llm.stream() 直连模型 —— **完全不写会话日志**，所以主会话
 *          不会被这轮问答污染，这就是主人要的「不入会话的临时小窗」。
 *
 * 之所以走 HTTP 而不是 harness.handle：需要边生成边推给前端（流式打字），
 * handle 只能一次性返回 JSON。
 */
export const name = '@local/dsh-quote-menu'
export const inject = ['webServer', 'connection', 'sessions', 'llm']

const ROUTE = '/quote-menu-api'
/** 请求体上限（临时对话再长也就几十 KB）。 */
const MAX_BODY = 512 * 1024
/** 会话上下文的字符预算：超了就从最老的开始丢，保证请求不炸窗口。 */
const MAX_CONTEXT_CHARS = 400000
/** 临时对话本身的上限（轮数 / 字符），防止前端异常把请求撑爆。 */
const MAX_TURNS = 40
const MAX_TURN_CHARS = 20000

const SYSTEM_PROMPT = [
  '你是一个浮动小窗里的学习助手。用户在 DSH 的会话里选中了一段文字，正在向你提问。',
  '',
  '最重要的一条：下面附上的「当前会话的对话记录」只是**背景材料**，不是你现在要接的话。',
  '不要接着说那段对话、不要点评它、也不要假装你在继续那场对话。你只回答用户在小窗里提的这一个问题。',
  '',
  '回答规则：',
  '1. 结合背景理解用户所指的那个概念，不要脱离背景泛泛而谈。',
  '2. 用户的目标是「搞懂知识点」：先用一两句话说清它是什么、解决什么问题，再讲作用与特点，必要时和相近的概念做对比，最后给一个具体的小例子。',
  '3. 回答要短、要密，按行分段。用纯文本 + 简单的 1. 2. 3. 或 - 分点；不要写 Markdown 标题、表格、星号加粗、代码围栏。',
  '4. 背景里没有依据、你也不确定的，直接说不确定，不要编造。',
  '5. 你只能说话：不能执行命令、不能读写文件，也不要让用户去点别的地方。',
].join('\n')

/** 一条消息里所有纯文本块拼起来；没有文字就返回空串。 */
function textOf(message) {
  const blocks = message && Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text) parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 把会话历史压成「纯文本 user/assistant 轮次」，超预算就从最老的丢。 */
function contextOf(ctx, sessionId) {
  if (!sessionId) return { messages: [], truncated: false, derived: 0 }
  let session
  try {
    session = ctx.sessions.get(sessionId)
  } catch {
    session = undefined
  }
  if (!session) return { messages: [], truncated: false, derived: 0 }

  let derived = []
  try {
    derived = session.deriveMessages()
  } catch {
    derived = []
  }

  const kept = []
  let budget = MAX_CONTEXT_CHARS
  let truncated = false
  /** 只留纯文本块；assistant 必须带 source（deepseek 适配器会读 source.kind），
   *  而且要把 replayState 丢掉 —— 块已经被裁过，旧的重放信封对不上会报错。 */
  const rebuild = (message, text) => {
    if (message.role === 'assistant') {
      const source = message.source || {}
      return {
        id: typeof message.id === 'string' ? message.id : 'quote-menu-ctx-assistant',
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: {
          kind: 'model',
          provider: typeof source.provider === 'string' ? source.provider : '',
          model: typeof source.model === 'string' ? source.model : '',
        },
      }
    }
    return {
      id: typeof message.id === 'string' ? message.id : 'quote-menu-ctx-user',
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }
  }
  for (let i = derived.length - 1; i >= 0; i -= 1) {
    const message = derived[i]
    if (!message) continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = textOf(message)
    if (!text) continue
    if (text.length > budget) {
      // 单条就超预算：只留尾部（最近的话），然后停
      kept.push(rebuild(message, text.slice(-budget)))
      truncated = true
      break
    }
    budget -= text.length
    kept.push(rebuild(message, text))
    if (budget <= 0) {
      truncated = true
      break
    }
  }
  kept.reverse()
  let chars = 0
  for (const message of kept) for (const block of message.content) chars += block.text.length
  return { messages: kept, truncated, derived: derived.length, chars }
}

/** 客户端那几轮临时对话 → 请求消息。 */
function turnMessages(turns, provider, model) {
  const out = []
  const list = Array.isArray(turns) ? turns.slice(-MAX_TURNS) : []
  for (let i = 0; i < list.length; i += 1) {
    const turn = list[i]
    if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) continue
    const text = typeof turn.text === 'string' ? turn.text.slice(0, MAX_TURN_CHARS) : ''
    if (!text.trim()) continue
    if (turn.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text }] })
    } else {
      out.push({
        id: 'quote-menu-ask-' + String(i),
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider, model },
      })
    }
  }
  return out
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}

function json(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

export function apply(ctx) {
  /** 兜底模型清单：直接问 llm 服务。 */
  async function modelList() {
    const providers = []
    let all = []
    try {
      all = ctx.llm.listProviders()
    } catch {
      all = []
    }
    for (const provider of all) {
      const entry = { id: provider.id, name: provider.name, models: [] }
      try {
        const models = await ctx.llm.listModels(provider.id)
        entry.models = models.map((m) => ({ id: m.id, name: m.name || m.id }))
      } catch (err) {
        entry.error = String((err && err.message) || err)
      }
      if (entry.models.length === 0) continue
      providers.push(entry)
    }
    let current = null
    try {
      const selection = ctx.get('agentDefaultModel')
      const value = selection && selection.currentSelection ? selection.currentSelection() : null
      if (value && value.provider && value.model) current = { provider: value.provider, model: value.model }
    } catch {
      current = null
    }
    return { providers, current }
  }

  async function ask(req, res, payload) {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    const provider = typeof payload.provider === 'string' ? payload.provider : ''
    const model = typeof payload.model === 'string' ? payload.model : ''
    if (!provider || !model) {
      json(res, 200, { ok: false, error: '没有指定模型' })
      return
    }

    const context = contextOf(ctx, sessionId)
    const turns = turnMessages(payload.turns, provider, model)
    const messages = context.messages.slice()
    if (messages.length > 0 && turns.length > 0) {
      // 合成一句「分界线」：不然模型会把小窗当成主会话的续写，接着上一段话往下写。
      messages.push({
        id: 'quote-menu-ask-boundary',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '（背景已收到。用户现在开了一个独立的小窗向我提问，我只需要回答那一个问题，不续写、不点评上面的对话。）',
          },
        ],
        source: { kind: 'model', provider, model },
      })
    }
    for (const message of turns) messages.push(message)
    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
      json(res, 200, { ok: false, error: '没有问题内容' })
      return
    }

    // 流式：NDJSON，一行一个事件
    const controller = new AbortController()
    let closed = false
    res.on('close', () => {
      closed = true
      if (!res.writableEnded) controller.abort()
    })
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
      'transfer-encoding': 'chunked',
    })
    const push = (event) => {
      if (closed || res.writableEnded) return
      try {
        res.write(JSON.stringify(event) + '\n')
      } catch {
        closed = true
      }
    }

    push({ type: 'start', backed: context.messages.length, truncated: context.truncated, chars: context.chars })
    try {
      const request = {
        provider,
        model,
        messages,
        system: SYSTEM_PROMPT,
        signal: controller.signal,
      }
      if (sessionId) request.sessionId = sessionId
      for await (const chunk of ctx.llm.stream(request)) {
        if (!chunk) continue
        if (chunk.type === 'text-delta' && chunk.text) {
          push({ type: 'delta', text: chunk.text })
          continue
        }
        if (chunk.type === 'reasoning-delta') {
          push({ type: 'reasoning', text: chunk.text || '' })
          continue
        }
        if (chunk.type === 'usage') {
          push({ type: 'usage', usage: chunk.usage })
          continue
        }
        if (chunk.type === 'finish') {
          const reason = chunk.reason || {}
          if (reason.kind === 'error') {
            push({ type: 'error', message: (reason.failure && reason.failure.message) || '模型调用失败' })
          } else if (reason.kind === 'max-tokens') {
            push({ type: 'error', message: '回答太长，被 max-tokens 截断了' })
          }
        }
      }
      push({ type: 'done' })
    } catch (err) {
      if (controller.signal.aborted) {
        push({ type: 'aborted' })
      } else {
        push({ type: 'error', message: String((err && err.message) || err) })
      }
    } finally {
      if (!res.writableEnded) res.end()
    }
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
        let payload
        try {
          payload = await readJson(req)
        } catch {
          json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        try {
          if (endpoint === 'models') {
            json(res, 200, { ok: true, value: await modelList() })
          } else if (endpoint === 'ask') {
            await ask(req, res, payload)
          } else {
            json(res, 404, { ok: false, error: '未知接口：' + String(endpoint) })
          }
        } catch (err) {
          if (res.writableEnded) return
          if (res.headersSent) {
            try {
              res.end()
            } catch {
              /* 已经废了就别再抛 */
            }
            return
          }
          json(res, 200, { ok: false, error: String((err && err.message) || err) })
        }
      },
    }),
  )
}
