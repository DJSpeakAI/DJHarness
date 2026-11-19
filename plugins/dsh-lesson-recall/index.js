/**
 * 教训自动检索（Host 半）—— dsh-lesson-recall
 *
 * 知识库：$DSH_HOME/knowledge/lessons.json（唯一真相，AGENTS.md 教训段已拆出）。
 * 每轮组装系统提示词时（systemPrompt.context 动态求值）：
 *   取本会话最近几条消息文本 → 按 keys 触发词打分 → 只注入相关的少数几条全文。
 * 没命中就不注入正文（索引在 AGENTS.md 里常驻，需要时可读文件查全库）。
 * 知识库文件热加载（mtime 轮询 60s），改 lessons.json 不用重启。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = '@local/dsh-lesson-recall'
export const inject = ['systemPrompt']

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const KB_FILE = path.join(HOME, 'knowledge', 'lessons.json')

const TOP_N = 6
const MAX_LESSON_CHARS = 1200
const MAX_BLOB_CHARS = 8000
const RELOAD_MS = 60_000

/** 知识库缓存（mtime 热加载）。 */
let cache = { lessons: [], mtime: 0, checkedAt: 0 }

function loadLessons(force = false) {
  const now = Date.now()
  if (!force && now - cache.checkedAt < RELOAD_MS && cache.lessons.length) return cache.lessons
  cache.checkedAt = now
  try {
    const st = fs.statSync(KB_FILE)
    if (st.mtimeMs !== cache.mtime) {
      const raw = JSON.parse(fs.readFileSync(KB_FILE, 'utf8'))
      const lessons = Array.isArray(raw && raw.lessons) ? raw.lessons : []
      cache = { lessons, mtime: st.mtimeMs, checkedAt: now }
    }
  } catch {
    /* 读不了就沿用旧缓存；库空则本插件静默不注入 */
  }
  return cache.lessons
}

/** 从一条消息里抠纯文本（user/assistant；content 可能是 string 或块数组）。 */
function messageText(msg) {
  if (!msg) return ''
  const role = msg.role || (msg.user ? 'user' : '')
  if (role !== 'user' && role !== 'assistant') return ''
  const c = msg.content ?? msg.text ?? ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .filter(b => b && (b.type === 'text' || typeof b.text === 'string'))
      .map(b => (typeof b.text === 'string' ? b.text : ''))
      .join('\n')
  }
  return ''
}

/** 最近任务文本（最后 8 条消息，截尾 8000 字符，小写）。 */
function recentBlob(session) {
  try {
    const msgs = session && typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
    const texts = []
    for (let i = msgs.length - 1, taken = 0; i >= 0 && taken < 8; i--) {
      const t = messageText(msgs[i])
      if (t) {
        texts.unshift(t)
        taken++
      }
    }
    return texts.join('\n').slice(-MAX_BLOB_CHARS).toLowerCase()
  } catch {
    return ''
  }
}

/** 打分：每个 key 命中记 key 出现次数（封顶 3，防一个词刷屏）。 */
function scoreLesson(lesson, blob) {
  let score = 0
  for (const key of lesson.keys || []) {
    if (!key) continue
    const k = String(key).toLowerCase()
    let hit = blob.indexOf(k)
    let n = 0
    while (hit !== -1 && n < 3) {
      n++
      hit = blob.indexOf(k, hit + k.length)
    }
    score += n
  }
  return score
}

function render(session) {
  // 注意：本函数注册在 systemPrompt.context 且 interpolate:false，框架会直接对
  // 返回值取 .length（dsh-system-prompt/lib/index.js renderContextSections）。
  // 因此「无命中」必须返回空字符串 ''，绝不能返回 undefined——否则 undefined.length
  // 抛 TypeError，会让该会话每一轮 turn 直接崩掉、消息发不出去（2026-11-18 事故：
  // 历史很短、命中不到教训的新会话（如「项目经理」）最先中招）。
  try {
    const lessons = loadLessons()
    if (!lessons.length) return ''
    const blob = recentBlob(session)
    if (!blob.trim()) return ''
    const ranked = lessons
      .map(l => ({ l, s: scoreLesson(l, blob) }))
      .filter(r => r.s >= 2)
      .sort((a, b) => b.s - a.s)
      .slice(0, TOP_N)
    if (!ranked.length) return ''
    const lines = [
      '【教训检索】下面是按当前任务关键词从教训库自动捞出的相关条目（完整 ' + lessons.length + ' 条在 ' + KB_FILE + ' 与 AGENTS.md 索引）：',
    ]
    for (const { l } of ranked) {
      const text = String(l.text ?? l.body ?? l.detail ?? l.title ?? '')
      lines.push(`— 教训${l.id ?? '?'}：${text.length > MAX_LESSON_CHARS ? text.slice(0, MAX_LESSON_CHARS) + '…' : text}`)
    }
    return lines.join('\n')
  } catch {
    // 教训61：本函数在提示词组装阶段执行，任何异常=整轮 turn 直接崩。
    // 数据坏了（如 2026-11-19 教训 65/66 字段写成 body/detail 导致 text undefined）
    // 也宁可不注入，绝不抛错。永远返回字符串。
    return ''
  }
}

export function apply(ctx) {
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'lesson-recall',
      order: 131,
      interpolate: false,
      text: (context) => render(context.agent?.session),
    }),
  )
}
