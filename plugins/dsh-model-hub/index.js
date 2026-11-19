/**
 * 模型中心（Host 半）—— 从 little DJ 经典版移植
 *
 *   1. server/skills/model-pricing.js —— 三个官方定价页的抓取与解析
 *      （DeepSeek 官方 / GLM 按量 / GLM Token Plan）
 *   2. 设置 → API Key → 供应商 Key 库（多 Key / 别名 / 测试 / 余额 / 额度）
 *
 * Host 只做三件事：抓取解析定价、保管 Key、回答 Client 的 RPC。
 * Client 半在 client.js，用 window.open 开独立小窗渲染。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileP = promisify(execFile)

export const name = '@local/dsh-model-hub'
export const inject = ['connection', 'credentials', 'webServer', 'timer']

const ROUTE = '/model-hub-api'
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(HOME, 'storage', 'model-hub')
const KEYS_FILE = path.join(DATA_DIR, 'keys.json')
const PRICES_FILE = path.join(DATA_DIR, 'prices.json')
/** 云账号实拉模型列表（apps/cloud-balance/fetch-models.mjs 产出，runScan 时合并） */
const LIVE_MODELS_FILE = path.join(DATA_DIR, 'live-models.json')
const SCAN_EVERY_MS = 3 * 24 * 60 * 60 * 1000
const SCAN_HOUR = 8

/** 三家供应商：envRef 是真正喂给 DSH 模型路由的凭据名。 */
const PROVIDERS = [
  {
    id: 'deepseek',
    title: 'DeepSeek 官方',
    api: 'api.deepseek.com',
    apiFull: 'https://api.deepseek.com',
    envRef: 'DEEPSEEK_API_KEY',
    routeIds: ['deepseek-official', 'deepseek-account'],
    probe: 'deepseek',
    keyHint: 'sk-…',
    // DeepSeek 官方路由走自己的 llm-deepseek 配置（models[].name 同样当别名用）
    configEntryId: 'llm-deepseek',
  },
  {
    id: 'zhipu-plan',
    title: 'GLM Token Plan',
    api: 'open.bigmodel.cn/api/coding/paas/v4',
    apiFull: 'https://open.bigmodel.cn/api/coding/paas/v4',
    envRef: 'ZAI_CODING_CN_API_KEY',
    routeIds: ['zai-coding-cn'],
    keyHint: 'id.secret',
  },
  {
    id: 'siliconflow',
    title: '硅基流动',
    api: 'api.siliconflow.cn/v1',
    apiFull: 'https://api.siliconflow.cn/v1（OpenAI 兼容，多款模型免费）',
    envRef: 'MODELHUB_SILICONFLOW_API_KEY',
    routeIds: ['siliconflow-cn'],
    probe: 'siliconflow',
    keyHint: 'sk-…',
  },
  {
    id: 'modelscope',
    title: '魔搭 ModelScope（免费）',
    api: 'api-inference.modelscope.cn/v1',
    apiFull: 'https://api-inference.modelscope.cn/v1（OpenAI 兼容，免费推理·限速）',
    envRef: 'MODELHUB_MODELSCOPE_API_KEY',
    routeIds: ['modelscope-cn'],
    probe: 'modelscope',
    keyHint: 'ms-…（魔搭访问令牌）',
  },
  {
    id: 'volc',
    title: '火山方舟（豆包）',
    api: 'ark.cn-beijing.volces.com/api/v3',
    apiFull: 'https://ark.cn-beijing.volces.com/api/v3（OpenAI 兼容）',
    envRef: 'MODELHUB_VOLC_API_KEY',
    routeIds: ['volc-ark-cn'],
    probe: 'volc',
    keyHint: '方舟 API Key',
  },
  {
    id: 'aliyun',
    title: '阿里百炼（通义千问）',
    api: 'dashscope.aliyuncs.com/compatible-mode/v1',
    apiFull: 'https://dashscope.aliyuncs.com/compatible-mode/v1（OpenAI 兼容）',
    envRef: 'MODELHUB_ALIYUN_API_KEY',
    routeIds: ['aliyun-dashscope'],
    probe: 'aliyun',
    keyHint: 'sk-…',
  },
]

/**
 * 火山方舟（豆包）静态价目表 —— 官方定价页是 JS 渲染抓不到表格，
 * 这里内置主流文本模型（价格：元 / 百万 tokens，2026-11 快照）。
 * 上下文/输出上限来自官方模型列表页，供别名单首次添加时作默认。
 */
const VOLC_MODELS = [
  { id: 'doubao-seed-1.6', name: 'Doubao-Seed-1.6', contextWindow: 256000, maxTokens: 32768, input: ['text'], miss: 8, hit: 2, out: 32 },
  { id: 'doubao-seed-1.6-flash', name: 'Doubao-Seed-1.6-Flash', contextWindow: 256000, maxTokens: 32768, input: ['text', 'image'], miss: 0.3, hit: 0.08, out: 1.2 },
  { id: 'doubao-seed-1.6-thinking', name: 'Doubao-Seed-1.6-Thinking', contextWindow: 256000, maxTokens: 32768, input: ['text', 'image'], miss: 8, hit: 2, out: 32 },
  { id: 'doubao-seed-1-6-250615', name: 'Doubao-Seed-1.6 (250615)', contextWindow: 256000, maxTokens: 32768, input: ['text'], miss: 8, hit: 2, out: 32 },
  { id: 'doubao-1-5-pro-32k', name: 'Doubao-1.5-Pro-32k', contextWindow: 32000, maxTokens: 12000, input: ['text'], miss: 0.8, hit: 0.2, out: 2 },
  { id: 'doubao-1-5-pro-256k', name: 'Doubao-1.5-Pro-256k', contextWindow: 256000, maxTokens: 12000, input: ['text'], miss: 5, hit: 1.2, out: 12 },
  { id: 'doubao-1-5-lite-32k', name: 'Doubao-1.5-Lite-32k', contextWindow: 32000, maxTokens: 12000, input: ['text'], miss: 0.3, hit: 0.08, out: 0.6 },
  { id: 'deepseek-v4-1-flash', name: 'DeepSeek-V4.1-Flash（方舟）', contextWindow: 128000, maxTokens: 32768, input: ['text'], miss: 2, hit: 0.5, out: 8 },
]

/**
 * 阿里云百炼（通义千问）静态价目 —— 同火山：官方定价页 JS 渲染抓不到，
 * 内置快照（元 / 百万 tokens，2026-11）。命中 = 隐式缓存命中价。
 */
const ALIYUN_MODELS = [
  { id: 'qwen-flash', name: 'Qwen-Flash（最便宜）', contextWindow: 1000000, maxTokens: 65536, input: ['text'], miss: 0.15, hit: 0.03, out: 0.75 },
  { id: 'qwen-plus', name: 'Qwen-Plus', contextWindow: 1000000, maxTokens: 65536, input: ['text'], miss: 0.8, hit: 0.2, out: 2 },
  { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', contextWindow: 1000000, maxTokens: 65536, input: ['text'], miss: 0.15, hit: 0.03, out: 0.75 },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', contextWindow: 262144, maxTokens: 32768, input: ['text'], miss: 2.4, hit: 0.6, out: 9.6 },
  { id: 'qwen4-max', name: 'Qwen4-Max（旗舰）', contextWindow: 262144, maxTokens: 32768, input: ['text'], miss: 2.4, hit: 0.6, out: 9.6 },
  { id: 'qwen3.6-35b-a3b', name: 'Qwen3.6-35B-A3B（开源）', contextWindow: 262144, maxTokens: 32768, input: ['text'], miss: 0.38, hit: 0.05, out: 1.9 },
  { id: 'qwen3-vl-plus', name: 'Qwen3-VL-Plus（视觉）', contextWindow: 131072, maxTokens: 32768, input: ['text', 'image'], miss: 0.8, hit: 0.2, out: 2 },
]

/**
 * 硅基流动（SiliconFlow）静态价目（元 / 百万 tokens，2026-11 快照）。
 * 输入框模型选择器里那两款免费千问就是这家的（llm-pi-ai 的 siliconflow-cn 路由），
 * 之前比价缓存里没有这家 → 比价表查不到它们，2026-11-19 补上。
 * 两款当前 ¥0（免费档），官方以后改价就在这张表改。
 */
const SILICONFLOW_MODELS = [
  { id: 'Qwen/Qwen3-8B', name: 'Qwen3-8B（免费·硅基）', contextWindow: 131072, maxTokens: 8192, input: ['text'], free: true, miss: 0, hit: 0, out: 0 },
  { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen2.5-7B（免费·硅基）', contextWindow: 32768, maxTokens: 8192, input: ['text'], free: true, miss: 0, hit: 0, out: 0 },
]

/**
 * 魔搭 ModelScope 静态价目（2026-11）：免费推理档（每天 2000 次调用限额），
 * 价格全 0。模型 id 用魔搭官方命名；2026-11-19 实拉清单里 Qwen3-235B 已下架，
 * 免费旗舰换成 Qwen3.5-397B-A17B（比 235B 更强）。
 * 2026-11-19 v0.193：删掉 moonshotai/Kimi-K3.1-Pro —— 实测每次 52ms 秒拒
 * 400「has no provider supported」（魔搭挂名没挂推理后端），与调用频率/额度无关。
 * ⚠️ 前提：账号需在魔搭官网绑定阿里云账号，否则 chat 返回 401 bind alibaba。
 */
const MODELSCOPE_MODELS = [
  { id: 'Qwen/Qwen3.5-397B-A17B', name: 'Qwen3.5-397B（免费·魔搭）', contextWindow: 131072, maxTokens: 16384, input: ['text'], free: true, miss: 0, hit: 0, out: 0 },
]

/** 腾讯云混元静态价目（元 / 百万 tokens，2026-11 快照）。
 *  主人 2026-11-18 指正：混元很多模型免费、部分夜间(0-8 点)特惠约 5 折~1 折 ——
 *  lite/standard 系列免费已在下表标出；夜间价按官方控制台实时为准，快照不编数。 */
const TENCENT_MODELS = [
  { id: 'hunyuan-turbos', name: 'Hunyuan-TurboS', contextWindow: 256000, maxTokens: 32000, input: ['text'], miss: 0.8, hit: 0.2, out: 2 },
  { id: 'hunyuan-large', name: 'Hunyuan-Large', contextWindow: 256000, maxTokens: 32000, input: ['text'], miss: 4, hit: 1, out: 12 },
  { id: 'hunyuan-standard', name: 'Hunyuan-Standard（免费）', contextWindow: 32000, maxTokens: 16000, input: ['text'], miss: 0, hit: 0, out: 0, free: true },
  { id: 'hunyuan-standard-256k', name: 'Hunyuan-Standard-256K', contextWindow: 256000, maxTokens: 16000, input: ['text'], miss: 5, hit: 1.2, out: 15 },
  { id: 'hunyuan-lite', name: 'Hunyuan-Lite（免费）', contextWindow: 256000, maxTokens: 16000, input: ['text'], miss: 0, hit: 0, out: 0, free: true },
]

/** 月之暗面 Kimi 静态价目（元 / 百万 tokens，2026-11 快照，来自聚合价目核对）。 */
const MOONSHOT_MODELS = [
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 1000000, maxTokens: 65536, input: ['text'], miss: 12.97, hit: 1.3, out: 67.83 },
  { id: 'kimi-k3.1-pro-highspeed', name: 'Kimi K3.1 Pro Highspeed', contextWindow: 1000000, maxTokens: 65536, input: ['text'], miss: 25.94, hit: 1.3, out: 135.67 },
]

/** 百度千帆 ERNIE 静态价目（元 / 百万 tokens，2026-11 快照；Speed/Lite 免费）。 */
const BAIDU_MODELS = [
  { id: 'ernie-4.5-x1', name: 'ERNIE-4.5-X1', contextWindow: 131072, maxTokens: 32768, input: ['text'], miss: 2, hit: 0.4, out: 8 },
  { id: 'ernie-4.5-turbo', name: 'ERNIE-4.5-Turbo', contextWindow: 131072, maxTokens: 32768, input: ['text'], miss: 0.8, hit: 0.2, out: 2 },
  { id: 'ernie-speed', name: 'ERNIE-Speed（免费）', contextWindow: 128000, maxTokens: 8192, input: ['text'], miss: 0, hit: 0, out: 0, free: true },
  { id: 'ernie-lite', name: 'ERNIE-Lite（免费）', contextWindow: 128000, maxTokens: 8192, input: ['text'], miss: 0, hit: 0, out: 0, free: true },
]

/** GLM 各模型的默认容量（别名首次添加时用，之后保留旧配置）。 */
const GLM_MODEL_DEFAULTS = { contextWindow: 1000000, maxTokens: 131072, input: ['text'] }

const API_BASES = {
  deepseek: { api: 'api.deepseek.com', apiFull: 'https://api.deepseek.com（OpenAI 兼容）' },
  zhipu: { api: 'open.bigmodel.cn/api/paas/v4', apiFull: 'https://open.bigmodel.cn/api/paas/v4（按量 API）' },
  'zhipu-plan': {
    api: 'open.bigmodel.cn/api/coding/paas/v4',
    apiFull: 'https://open.bigmodel.cn/api/coding/paas/v4（Coding Plan 专用）',
  },
  volc: { api: 'ark.cn-beijing.volces.com/api/v3', apiFull: 'https://ark.cn-beijing.volces.com/api/v3（OpenAI 兼容）' },
  siliconflow: { api: 'api.siliconflow.cn/v1', apiFull: 'https://api.siliconflow.cn/v1（OpenAI 兼容）' },
  modelscope: { api: 'api-inference.modelscope.cn/v1', apiFull: 'https://api-inference.modelscope.cn/v1（OpenAI 兼容，免费·限速）' },
  openrouter: { api: 'openrouter.ai/api/v1', apiFull: 'https://openrouter.ai/api/v1（全球聚合，OpenAI 兼容）' },
  modelsdev: { api: 'models.dev', apiFull: 'https://models.dev（324 家供应商目录，端点各异见官网）' },
}

/** 定价数据源（与 little DJ 完全一致）。GLM 按量已撤（主人有 Token Plan），不再抓。
 *  2026-11-18 加 OpenRouter：全世界 300+ 模型聚合，官方公开 /api/v1/models JSON，
 *  价格 USD/token → 按 7.25 快照汇率折元/百万。 */
const SOURCES = [
  { id: 'deepseek', url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing', parse: parseDeepSeek },
  { id: 'zhipu-plan', url: 'https://docs.bigmodel.cn/cn/coding-plan/overview.md', parse: parseZhipuPlan },
  // 2026-11-19 起 output_modalities=text,image：把图像生成模型（含 NSFW 绘图系）一并拉进比价
  { id: 'openrouter', url: 'https://openrouter.ai/api/v1/models?output_modalities=text,image', parse: parseOpenRouter },
  { id: 'modelsdev', url: 'https://models.dev/api.json', parse: parseModelsDev, maxBytes: 16 * 1024 * 1024 },
]

/** OpenRouter 汇率快照（USD→CNY），调价改这里。 */
const USDCNY = 7.25

// ────────────────────────────── 文件读写 ──────────────────────────────

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

// ─────────────────────────── 角色模型 ───────────────────────────
// 主人 2026-11-18：「后台设置的模型里面没有项目经理的那个内容」。
// 三个角色的模型在这里统一看/改（设置 → 模型 → 角色模型）：
//   项目经理 = 宿主 agentDefaultModel（新会话默认，点「新会话」就是它）
//   大管家   = E:\DJH\home\butler-rotate.json（换脑新建会话时按它选模型）
//   星闪球   = E:\DJH\home\role-models.json 的 orb（语音陪聊/播报浓缩，桥热读）
const ROLE_MODELS_FILE = path.join(HOME, 'role-models.json')
const BUTLER_ROTATE_FILE = path.join(HOME, 'butler-rotate.json')
const ROLE_DEFS = [
  { id: 'pm', label: '项目经理', hint: '点「新会话」建出来的会话用它；直接向主人汇报、权限全开' },
  { id: 'butler', label: '大管家', hint: '换脑后的新大管家会话用它；主人唯一的对话总入口' },
  { id: 'orb', label: '星闪球', hint: '语音陪聊 + 播报浓缩用它；只动嘴的私人秘书' },
]
const ROLE_DEFAULTS = {
  pm: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  butler: { provider: 'deepseek-official', model: 'deepseek-flash' },
  orb: { provider: 'deepseek-official', model: 'deepseek-flash' },
}

function readKeyIndex() {
  const j = readJson(KEYS_FILE, null)
  const index = j && typeof j === 'object' && j.providers && typeof j.providers === 'object' ? j : { providers: {} }
  for (const p of PROVIDERS) {
    const slot = index.providers[p.id]
    if (!slot || typeof slot !== 'object') index.providers[p.id] = { active: '', items: [] }
    else {
      if (!Array.isArray(slot.items)) slot.items = []
      if (typeof slot.active !== 'string') slot.active = ''
    }
  }
  return index
}

function writeKeyIndex(index) {
  writeJson(KEYS_FILE, index)
  try {
    fs.chmodSync(KEYS_FILE, 0o600)
  } catch {
    /* 非 POSIX 文件系统忽略 */
  }
}

// ────────────────────────────── 定价解析（移植自 little DJ） ──────────────────────────────

function stripTags(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function parseTableRows(tableHtml) {
  const rows = String(tableHtml || '').match(/<tr[\s\S]*?<\/tr>/gi) || []
  return rows.map((r) => {
    const cells = r.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []
    return cells.map(stripTags)
  })
}

function cleanModelName(s) {
  return String(s || '')
    .replace(/\(\d+\)$/, '')
    .trim()
}

/** DeepSeek 定价页：Docusaurus 静态表格，「键 | 各模型列」。 */
function parseDeepSeek(html, sourceUrl) {
  const tables = String(html || '').match(/<table[\s\S]*?<\/table>/gi) || []
  if (!tables.length) throw new Error('页面里没找到表格（结构可能已改版）')
  const rows = parseTableRows(tables[0])
  if (rows.length < 5) throw new Error('定价表行数异常（结构可能已改版）')

  const headRow = rows.filter((r) => r[0] && /模型/.test(r[0]) && r.length >= 2)[0]
  if (!headRow) throw new Error('找不到「模型」表头行')
  const models = headRow
    .slice(1)
    .map(cleanModelName)
    .filter(Boolean)
    .map((n) => ({
      name: n,
      category: 'text',
      contextText: '',
      maxOutputText: '',
      price: { inputHit: {}, inputMiss: {}, output: {} },
      limits: {},
      free: false,
    }))
  if (!models.length) throw new Error('模型列表为空')

  const spread = (vals, fn) => {
    if (!vals || !vals.length) return
    if (vals.length === 1) {
      models.forEach((m) => fn(m, vals[0]))
      return
    }
    models.forEach((m, i) => {
      if (vals[i]) fn(m, vals[i])
    })
  }
  rows.forEach((r) => {
    const label = String(r[0] || '')
      .replace(/\(\d+\)$/, '')
      .trim()
    const vals = r.slice(1)
    if (label === '上下文长度') spread(vals, (m, v) => (m.contextText = v))
    if (label === '输出长度') spread(vals, (m, v) => (m.maxOutputText = v))
    if (label === '并发限制') spread(vals, (m, v) => (m.limits.concurrency = v))
  })

  let tier = ''
  rows.forEach((r) => {
    const txt = r.join('|')
    if (/缓存未命中/.test(txt)) tier = 'inputMiss'
    else if (/缓存命中/.test(txt)) tier = 'inputHit'
    else if (/百万tokens输出/.test(txt)) tier = 'output'
    const period = /高峰/.test(txt) ? 'peak' : /空闲/.test(txt) ? 'offpeak' : ''
    if (!tier || !period) return
    const nums = r
      .map((c) => {
        const m = /^(\d+(?:\.\d+)?)\s*元$/.exec(String(c || '').trim())
        return m ? Number(m[1]) : null
      })
      .filter((x) => x !== null)
    if (nums.length === models.length) {
      models.forEach((m, i) => {
        m.price[tier][period] = nums[i]
      })
    }
  })

  const extras = []
  if (tables[1]) {
    parseTableRows(tables[1]).forEach((r) => {
      if (r.length >= 3 && r[0] && !/^API$/.test(r[0])) extras.push({ api: r[0], unit: r[1], price: r[2] })
    })
  }

  return {
    provider: 'DeepSeek 官方',
    providerKey: 'deepseek',
    source: sourceUrl,
    fetchedAt: new Date().toISOString(),
    models,
    extras,
  }
}

/** GLM 官方（智谱）定价页：Mintlify SSR 静态表，每行一个模型。 */
function parseZhipu(html, sourceUrl) {
  const tables = String(html || '').match(/<table[\s\S]*?<\/table>/gi) || []
  if (!tables.length) throw new Error('页面里没找到表格（结构可能已改版）')
  const models = []
  const extras = []
  const num = (v) => {
    const s = String(v || '').trim()
    if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s)
    const m = /^(\d+(?:\.\d+)?)\s*元/.exec(s)
    return m ? Number(m[1]) : null
  }
  tables.forEach((tb) => {
    const rows = parseTableRows(tb)
    if (!rows.length) return
    const head = rows[0].map((h) => String(h || ''))
    const isMain =
      head.some((h) => /输入单价/.test(h)) && head.some((h) => /输出单价/.test(h)) && head.some((h) => /缓存命中/.test(h))
    if (!isMain) {
      rows.slice(1).forEach((r) => {
        if (r.length >= 3 && r[0]) {
          extras.push({
            api: r[0],
            unit: r.slice(1, -1).join(' · ').slice(0, 80),
            price: String(r[r.length - 1] || '').slice(0, 40),
          })
        }
      })
      return
    }
    const idx = {
      name: head.findIndex((h) => /模型名称/.test(h)),
      ctx: head.findIndex((h) => /上下文/.test(h)),
      inP: head.findIndex((h) => /输入单价/.test(h)),
      outP: head.findIndex((h) => /输出单价/.test(h)),
      hit: head.findIndex((h) => /缓存命中/.test(h)),
    }
    rows.slice(1).forEach((r) => {
      if (idx.name < 0) return
      const modelName = cleanModelName(r[idx.name])
      if (!modelName || /模型名称/.test(modelName)) return
      const miss = idx.inP >= 0 ? num(r[idx.inP]) : null
      const out = idx.outP >= 0 ? num(r[idx.outP]) : null
      const hit = idx.hit >= 0 ? num(r[idx.hit]) : null
      const free = /免费/.test(
        String((idx.inP >= 0 && r[idx.inP]) || '') + String((idx.outP >= 0 && r[idx.outP]) || ''),
      )
      models.push({
        name: modelName,
        category: 'text',
        contextText: idx.ctx >= 0 ? String(r[idx.ctx] || '') : '',
        maxOutputText: '',
        price: {
          inputHit: hit != null ? { offpeak: hit } : {},
          inputMiss: miss != null ? { offpeak: miss } : {},
          output: out != null ? { offpeak: out } : {},
        },
        limits: {},
        free,
      })
    })
  })
  if (!models.length) throw new Error('没解析出任何模型（结构可能已改版）')
  return {
    provider: 'GLM 按量',
    providerKey: 'zhipu',
    source: sourceUrl,
    fetchedAt: new Date().toISOString(),
    models,
    extras,
  }
}

/** GLM Token Plan：markdown 里的抵扣系数表（含 rowSpan 合并格）。 */
function parseZhipuPlan(md, sourceUrl) {
  const text = String(md || '')
  const tables = text.match(/<table[\s\S]*?<\/table>/gi) || []
  if (!tables.length) throw new Error('页面里没找到抵扣系数表（结构可能已改版）')
  let rows = null
  tables.forEach((tb) => {
    if (rows) return
    const rs = parseTableRows(tb)
    if (rs.length && rs[0].some((h) => /Input\s*抵扣系数/.test(String(h || '')))) rows = rs
  })
  if (!rows) throw new Error('没找到含「Input 抵扣系数」的表（结构可能已改版）')
  const num = (v) => {
    const m = /^-?\d+(?:\.\d+)?$/.exec(String(v || '').trim())
    return m ? Number(m[0]) : null
  }
  const half = (v) => Math.round(v * 50) / 100
  const models = []
  rows.forEach((r) => {
    if (!r || !r.length) return
    let ni = -1
    for (let i = 0; i < r.length; i++) {
      if (/^GLM-/i.test(String(r[i] || ''))) {
        ni = i
        break
      }
    }
    if (ni < 0) return
    const nums = r
      .slice(ni + 1)
      .map(num)
      .filter((v) => v != null)
    if (nums.length < 3) return
    const inp = nums[0]
    const hit = nums[1]
    const out = nums[2]
    models.push({
      name: cleanModelName(r[ni]),
      category: 'text',
      contextText: '1M（[1m] 后缀）',
      maxOutputText: '',
      price: {
        unit: '积分',
        inputMiss: { offpeak: half(inp), peak: inp },
        inputHit: { offpeak: half(hit), peak: hit },
        output: { offpeak: half(out), peak: out },
      },
      limits: {},
      free: false,
    })
  })
  if (!models.length) throw new Error('没解析出任何模型（结构可能已改版）')
  return {
    provider: 'GLM Token Plan',
    providerKey: 'zhipuai-coding-plan',
    source: sourceUrl,
    fetchedAt: new Date().toISOString(),
    note:
      '订阅积分制：系数单位=积分（每万 tokens 量级），非高峰 5 折；' +
      '额度 Lite 2,000/5h·10,000/周｜Pro 12,000·60,000｜Max 28,000·140,000；月费见官网购买页',
    models,
    extras: [],
  }
}

// ── NSFW 分类（2026-11-19 主人拍板「必须做，还要分种类」）──
// OpenRouter 官方 API 已下掉 nsfw 分类，三层信号（2026-11-19 实测校准：
// is_moderated=false 在 OR 已是常态——GPT/Gemini/Qwen 全是 false，它只表示 OR 不额外加审，
// ≠ NSFW，所以只当弱标记「unmoderated」；真 NSFW 靠 ①官方描述关键词 ②社区公认 NSFW 血统名单）：
// 标签：unmoderated=低审查(弱) / adult=成人内容 / roleplay=角色扮演 / nsfw-image=NSFW绘图
const NSFW_ADULT_RE = /nsfw|explicit|porn|erotic|hentai|lewd|smut|18\+|adult[- ]only|sexual/i
const NSFW_UNMOD_RE = /uncensored|unfiltered|no filter|abstention|unrestricted/i
const NSFW_RP_RE = /roleplay|role-play|\berp\b|companion|girlfriend|waifu/i
// 社区公认 NSFW/ERP 血统（作者·系列名，命中即算成人向；图像侧 Pony/Illustrious/NoobXL 同理）
const NSFW_KNOWN_RE = /thedrummer|undi95|neversleep|noromaid|mythomax|beaver|rocinante|tungsteno|cydonia|unslopnemo|magnum|euryale|anubis|fimbulvetr|marshmallow|rocris|lumimaid|midnight-rose|samantha|ficton|lemonaderp|dolphin|wizardlm-uncensored|venice-uncensored/i
const NSFW_IMG_RE = /pony|illustrious|noobxl|animagine|pom-girl|autopen/i
function classifyNsfw(name, desc, unmoderated, isImageGen) {
  const t = (String(name || '') + ' ' + String(desc || '')).slice(0, 2000)
  const tags = []
  if (unmoderated || NSFW_UNMOD_RE.test(t)) tags.push('unmoderated')
  if (NSFW_ADULT_RE.test(t) || NSFW_KNOWN_RE.test(t)) tags.push('adult')
  if (tags.includes('adult') && (NSFW_RP_RE.test(t) || NSFW_KNOWN_RE.test(t))) tags.push('roleplay')
  if (isImageGen && (NSFW_ADULT_RE.test(t) || NSFW_IMG_RE.test(t))) tags.push('nsfw-image')
  return tags
}

/** OpenRouter /api/v1/models（JSON）：全世界模型聚合，pricing 是 USD/token。 */
function parseOpenRouter(text, sourceUrl) {
  const j = JSON.parse(text)
  const list = j && Array.isArray(j.data) ? j.data : []
  if (!list.length) throw new Error('OpenRouter 返回空模型列表（结构可能已改版）')
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }
  const models = []
  for (const m of list) {
    const pr = m.pricing || {}
    const inUsd = num(pr.prompt) * 1e6
    const outUsd = num(pr.completion) * 1e6
    const hitUsd = num(pr.prompt_cache_read) * 1e6
    const outMods = m.architecture && Array.isArray(m.architecture.output_modalities) ? m.architecture.output_modalities : []
    const isImageGen = outMods.includes('image')
    const imgUsd = num(pr.image)
    const free = inUsd === 0 && outUsd === 0 && (!isImageGen || imgUsd === 0)
    const ctx = m.context_length || m.top_provider && m.top_provider.context_length || 0
    const unmoderated = !!(m.top_provider && m.top_provider.is_moderated === false)
    const nsfw = classifyNsfw(m.id + ' ' + (m.name || ''), m.description, unmoderated, isImageGen)
    const price = isImageGen && imgUsd > 0
      ? { unit: '元/张', output: { offpeak: +(imgUsd * USDCNY).toFixed(3) } }
      : {
          // USD/token → 元/百万 tokens（汇率快照 USDCNY）
          inputHit: { offpeak: +(hitUsd * USDCNY).toFixed(2) },
          inputMiss: { offpeak: +(inUsd * USDCNY).toFixed(2) },
          output: { offpeak: +(outUsd * USDCNY).toFixed(2) },
          unit: '元',
        }
    models.push({
      name: m.name || m.id,
      category: isImageGen ? 'image' : 'text',
      contextText: ctx ? String(Math.round(ctx / 1000)) + 'K' : '',
      maxOutputText: m.top_provider && m.top_provider.max_completion_tokens ? String(Math.round(m.top_provider.max_completion_tokens / 1000)) + 'K' : '',
      price,
      limits: {},
      free,
      ...(nsfw.length ? { nsfw } : {}),
    })
  }
  // 排序：免费在前，再按输入价升序（便宜的先看到）
  models.sort((a, b) => {
    if (!!a.free !== !!b.free) return a.free ? -1 : 1
    // 图像生成模型（元/张）没有 inputMiss，排序兜底 0（2026-11-19 v0.173.1 修 offpeak undefined 崩）
    const key = (m) => (m.price && m.price.inputMiss && m.price.inputMiss.offpeak != null ? m.price.inputMiss.offpeak : 0)
    return key(a) - key(b)
  })
  return {
    provider: 'OpenRouter（全球聚合）',
    providerKey: 'openrouter',
    source: sourceUrl,
    fetchedAt: new Date().toISOString(),
    note: '美元价按 ' + USDCNY + ' 汇率快照折元；免费模型排最前；含 OpenAI/Anthropic/Google/Meta/国产全系',
    models,
    extras: [],
  }
}

/** models.dev api.json（社区维护的全网模型库，324 家供应商，免认证）：能力标签/介绍/缓存价/上下文都全。 */
function parseModelsDev(text, sourceUrl) {
  const j = JSON.parse(text)
  const provs = j && typeof j === 'object' ? Object.values(j).filter((p) => p && p.models) : []
  const models = []
  let providerCount = 0
  for (const p of provs) {
    providerCount++
    for (const [mid, m] of Object.entries(p.models)) {
      const cost = m.cost || {}
      const inUsd = Number(cost.input) || 0
      const outUsd = Number(cost.output) || 0
      const cacheUsd = Number(cost.cache_read) || Number(cost.input_cache_read) || 0
      const free = inUsd === 0 && outUsd === 0
      const mod = m.modalities || {}
      const inMods = Array.isArray(mod.input) ? mod.input : []
      const caps = []
      if (inMods.includes('image')) caps.push('vision')
      if (inMods.includes('video')) caps.push('video')
      if (inMods.includes('audio')) caps.push('audio')
      if (m.tool_call) caps.push('tools')
      if (m.reasoning) caps.push('reasoning')
      const outModsMd = Array.isArray(mod.output) ? mod.output : []
      const isImgMd = outModsMd.includes('image')
      const nsfw = classifyNsfw(mid + ' ' + (m.name || ''), m.description, false, isImgMd)
      models.push({
        name: (m.name || mid) + ' · ' + (p.name || p.id),
        category: 'text',
        contextText: m.limit && m.limit.context ? String(Math.round(m.limit.context / 1000)) + 'K' : '',
        maxOutputText: m.limit && m.limit.output ? String(Math.round(m.limit.output / 1000)) + 'K' : '',
        price: {
          inputHit: { offpeak: +(cacheUsd * USDCNY).toFixed(2) },
          inputMiss: { offpeak: +(inUsd * USDCNY).toFixed(2) },
          output: { offpeak: +(outUsd * USDCNY).toFixed(2) },
          unit: '元',
        },
        limits: {},
        free,
        // ── 学来的新栏目（2026-11-18 主人拍板，参考 models.dev）──
        caps,
        description: m.description || '',
        releaseDate: m.release_date || '',
        // 便于按供应商过滤
        providerName: p.name || p.id || '',
        ...(nsfw.length ? { nsfw } : {}),
      })
    }
  }
  if (!models.length) throw new Error('models.dev 返回空（结构可能已改版）')
  models.sort((a, b) => {
    if (!!a.free !== !!b.free) return a.free ? -1 : 1
    return a.price.inputMiss.offpeak - b.price.inputMiss.offpeak
  })
  // 裁剪：表格没分页，全量 9981 行会卡死——每家供应商最多留 10 个（输入价升序）+ 免费视觉模型全留
  const byProv = new Map()
  for (const m of models) {
    const k = m.providerName || '未知'
    if (!byProv.has(k)) byProv.set(k, [])
    byProv.get(k).push(m)
  }
  const kept = []
  const keptSet = new Set()
  for (const [, arr] of byProv) {
    arr.sort((a, b) => (a.price.inputMiss.offpeak - b.price.inputMiss.offpeak) || (b.caps.length - a.caps.length))
    for (const m of arr.slice(0, 10)) {
      kept.push(m)
      keptSet.add(m)
    }
  }
  for (const m of models) if (m.free && m.caps.includes('vision') && !keptSet.has(m)) kept.push(m)
  // NSFW 模型不裁（2026-11-19 主人拍板：这是专门栏目，宁可多留不可漏）
  for (const m of models) if (m.nsfw && m.nsfw.length && !keptSet.has(m)) kept.push(m)
  models.length = 0
  models.push(...kept)
  return {
    provider: 'models.dev（全网库 ' + providerCount + ' 家）',
    providerKey: 'modelsdev',
    source: sourceUrl,
    fetchedAt: new Date().toISOString(),
    note: '社区开源库 models.dev，含能力标签(视觉/视频/工具/推理)+模型介绍+缓存价；USD×' + USDCNY + ' 折元；三天一拉',
    models,
    extras: [],
  }
}

// ────────────────────────────── 网络 ──────────────────────────────

async function fetchText(url, timeoutMs = 25000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'dsh-model-hub/1.0 (+personal use; low frequency)',
        Accept: 'text/html,application/xhtml+xml,text/markdown;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: ac.signal,
      redirect: 'follow',
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const text = await res.text()
    if (text.length > 12 * 1024 * 1024) throw new Error('页面过大（>12MB）') // models.dev api.json 已超 3MB（2026-11-19 v0.173.1 放宽到 12MB）
    return text
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(url, key, timeoutMs = 12000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', authorization: 'Bearer ' + key },
      signal: ac.signal,
    })
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      /* 非 JSON 交给调用方看 status */
    }
    return { status: res.status, ok: res.ok, body }
  } finally {
    clearTimeout(timer)
  }
}

async function postJson(url, key, payload, timeoutMs = 20000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(payload),
      signal: ac.signal,
    })
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      /* 非 JSON 交给调用方看 status */
    }
    return { status: res.status, ok: res.ok, body }
  } finally {
    clearTimeout(timer)
  }
}

// ────────────────────────────── 业务 ──────────────────────────────

function maskKey(k) {
  const s = typeof k === 'string' ? k : ''
  if (!s) return ''
  return s.length > 12 ? s.slice(0, 6) + '****' + s.slice(-4) : '****'
}

function secretRef(providerId, itemId) {
  const norm = (s) =>
    String(s)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
  return 'MODELHUB_' + norm(providerId) + '_' + norm(itemId)
}

function makeItemId() {
  return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function providerById(id) {
  return PROVIDERS.filter((p) => p.id === id)[0] || null
}

function readPrices() {
  const j = readJson(PRICES_FILE, null)
  if (!j || typeof j !== 'object' || !Array.isArray(j.providers)) return null
  // 2026-11-17 撤「GLM 按量」：旧缓存里的按量组一并滤掉（下次重抓后自然没有）
  j.providers = j.providers.filter((p) => p && p.providerKey !== 'zhipu')
  // 内置静态家（火山 + 阿里云/腾讯/月之暗面/百度）随代码走：缓存里缺哪家就补哪家，
  // 改完插件不用等 3 天重抓也能立刻出现在比价表里
  const staticAll = [volcPricing(), dsToolsPricing(), ...staticPricings()]
  const seen = new Set(j.providers.map((p) => p && p.providerKey))
  for (const s of staticAll) {
    if (!seen.has(s.providerKey)) {
      j.providers.push(s)
      j.staticMerged = true
    }
  }
  return j
}

let scanning = false
let lastError = ''

/** DeepSeek 工具 API（2026-11-13 官宣）：ASR/TTS/OCR 独立接口，按用量计费（非按 token）。 */
function dsToolsPricing() {
  const tool = (name, unit, price) => ({
    name,
    category: 'text',
    contextText: '—',
    maxOutputText: '',
    price: { unit, output: { offpeak: price } },
    limits: {},
    free: false,
  })
  return {
    provider: 'DeepSeek 官方（工具 API：ASR/TTS/OCR）',
    providerKey: 'deepseek-tools',
    source: '内置静态表（2026-11 快照）',
    fetchedAt: new Date().toISOString(),
    note: '2026-11-13 官宣独立工具接口，按用量计费、Token 费另计；TTS 为限时 5 折价（刊例 ¥3/万字符）',
    api: 'api.deepseek.com/v1/tools',
    apiFull: 'https://api.deepseek.com/v1/tools/（asr / tts / ocr，用现有 DeepSeek Key）',
    models: [
      tool('deepseek-asr 语音识别', '元/小时', 0.39),
      tool('deepseek-tts 语音合成（5折）', '元/万字符', 1.5),
      tool('deepseek-ocr 文字识别', '元/千页', 1.5),
    ],
    extras: [],
  }
}

/** 火山方舟静态价目 → 比价数据同构。 */
function volcPricing() {
  return staticPricing('火山方舟（豆包）', 'volc', VOLC_MODELS)
}

/** 静态内置价目 → 比价数据同构（通用；价格快照随代码更新）。 */
function staticPricing(provider, providerKey, models) {
  return {
    provider,
    providerKey,
    source: '内置静态表（2026-11 快照）',
    fetchedAt: new Date().toISOString(),
    note: '价目内置快照，非实时抓取；以官方定价页/控制台为准',
    models: models.map((m) => ({
      name: m.name,
      category: 'text',
      contextText: String(Math.round(m.contextWindow / 1000)) + 'K',
      maxOutputText: m.maxTokens ? String(Math.round(m.maxTokens / 1000)) + 'K' : '',
      price: {
        inputHit: { offpeak: m.hit },
        inputMiss: { offpeak: m.miss },
        output: { offpeak: m.out },
      },
      limits: {},
      free: !!m.free,
    })),
    extras: [],
  }
}

/** 其余静态家：阿里云百炼 / 腾讯云混元 / 月之暗面 / 百度千帆。 */
function staticPricings() {
  return [
    {
      provider: '阿里云百炼（通义千问）',
      providerKey: 'aliyun',
      api: 'dashscope.aliyuncs.com/compatible-mode/v1',
      models: ALIYUN_MODELS,
    },
    {
      provider: '腾讯云混元',
      providerKey: 'tencent',
      api: 'api.hunyuan.cloud.tencent.com/v1',
      models: TENCENT_MODELS,
    },
    {
      provider: '月之暗面（Kimi）',
      providerKey: 'moonshot',
      api: 'api.moonshot.cn/v1',
      models: MOONSHOT_MODELS,
    },
    {
      provider: '百度千帆（ERNIE）',
      providerKey: 'baidu',
      api: 'qianfan.baidubce.com/v2',
      models: BAIDU_MODELS,
    },
    {
      provider: '硅基流动',
      providerKey: 'siliconflow',
      api: 'api.siliconflow.cn/v1',
      models: SILICONFLOW_MODELS,
    },
    {
      provider: '魔搭 ModelScope（免费）',
      providerKey: 'modelscope',
      api: 'api-inference.modelscope.cn/v1',
      models: MODELSCOPE_MODELS,
    },
  ].map((s) => {
    const p = staticPricing(s.provider, s.providerKey, s.models)
    p.api = s.api
    p.apiFull = s.api + '（OpenAI 兼容）'
    return p
  })
}

function shouldScan(prices) {
  const updated = prices && prices.updatedAt ? Date.parse(prices.updatedAt) : 0
  if (!updated) return true
  if (Date.now() - updated < SCAN_EVERY_MS) return false
  return new Date().getHours() >= SCAN_HOUR
}

async function runScan() {
  if (scanning) return { ok: false, message: '正在刷新中' }
  scanning = true
  const providers = []
  const errors = []
  try {
    for (const src of SOURCES) {
      try {
        const text = await fetchText(src.url, 25000, src.maxBytes)
        const data = src.parse(text, src.url)
        const ab = API_BASES[src.id] || {}
        data.api = ab.api || ''
        data.apiFull = ab.apiFull || ''
        providers.push(data)
      } catch (e) {
        errors.push(String(src.id) + '：' + String((e && e.message) || e).slice(0, 200))
      }
    }
    // 火山方舟：静态价目表（官方定价页 JS 渲染抓不到，价目内置、随代码更新）
    providers.push(volcPricing())
    providers.push(dsToolsPricing())
    // 阿里云百炼 / 腾讯云混元 / 月之暗面 / 百度千帆：同为内置静态快照
    for (const p of staticPricings()) providers.push(p)
    // 云账号实拉模型列表（apps/cloud-balance/fetch-models.mjs 产出；只有非空列表才进，占位说明不占位）
    try {
      const live = readJson(LIVE_MODELS_FILE)
      for (const p of live.providers || []) {
        if (!p.models || !p.models.length) continue
        const ab = API_BASES[p.id] || {}
        p.api = ab.api || ''
        p.apiFull = ab.apiFull || ''
        providers.push(p)
      }
    } catch {
      /* live-models.json 不存在或损坏：静默跳过 */
    }
    if (providers.length) {
      writeJson(PRICES_FILE, { updatedAt: new Date().toISOString(), providers, errors })
      lastError = ''
      return { ok: true, count: providers.reduce((n, p) => n + p.models.length, 0), errors }
    }
    lastError = errors.join('；') || '没有启用的数据源'
    return { ok: false, message: lastError, errors }
  } finally {
    scanning = false
  }
}

// ────────────────────────────── 插件本体 ──────────────────────────────

export function apply(ctx) {
  const credentials = ctx.credentials

  // 测试连通用 /models：它对无效 Key 会明确返回 401。
  // （不要用额度接口 —— open.bigmodel.cn 的 quota/limit 对假 Key 也返回 200，会误报正常）
  const probeUrl = (provider) =>
    provider.probe === 'deepseek'
      ? 'https://api.deepseek.com/models'
      : provider.probe === 'volc'
        ? 'https://ark.cn-beijing.volces.com/api/v3/models'
        : provider.probe === 'siliconflow'
          ? 'https://api.siliconflow.cn/v1/models'
          : provider.probe === 'modelscope'
          ? 'https://api-inference.modelscope.cn/v1/models'
          : provider.probe === 'aliyun'
          ? 'https://dashscope.aliyuncs.com/compatible-mode/v1/models'
          : provider.id === 'zhipu-plan'
          ? 'https://open.bigmodel.cn/api/coding/paas/v4/models'
          : 'https://open.bigmodel.cn/api/paas/v4/models'

  async function resolveSecret(ref) {
    try {
      const resolved = await credentials.resolve(ref)
      return resolved && resolved.value ? resolved.value : ''
    } catch {
      return ''
    }
  }

  async function activeSecret(provider) {
    const index = readKeyIndex()
    const slot = index.providers[provider.id]
    const item = slot.active ? slot.items.filter((k) => k.id === slot.active)[0] : null
    return resolveSecret(item ? item.ref : provider.envRef)
  }

  async function providerView(provider, routedIds) {
    const index = readKeyIndex()
    const slot = index.providers[provider.id]
    const items = []
    for (const item of slot.items) {
      const value = await resolveSecret(item.ref)
      items.push({
        id: item.id,
        alias: item.alias || '未命名',
        masked: maskKey(value),
        configured: !!value,
        active: slot.active === item.id,
      })
    }
    let routedConfigured = false
    try {
      const info = await credentials.describe(provider.envRef)
      routedConfigured = !!(info && info.configured)
    } catch {
      /* ignore */
    }
    return {
      id: provider.id,
      title: provider.title,
      api: provider.api,
      apiFull: provider.apiFull,
      envRef: provider.envRef,
      routeId: provider.routeIds[0],
      keyHint: provider.keyHint,
      linked: routedConfigured,
      routed: provider.routeIds.some((id) => routedIds.indexOf(id) >= 0),
      active: slot.active || '',
      items,
    }
  }

  /** 当前真正挂在模型路由上的 provider id（没挂上时模型选择器里看不到）。 */
  function routedProviderIds() {
    try {
      const llm = ctx.get('llm')
      if (!llm) return []
      return llm.listProviders().map((p) => p.id)
    } catch {
      return []
    }
  }

  // 端点 /models 探测缓存：10 分钟
  const endpointModelsCache = new Map()
  async function probeEndpointModels(provider) {
    const hit = endpointModelsCache.get(provider.id)
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.ids
    const key = await activeSecret(provider)
    if (!key) return null
    try {
      const r = await getJson(probeUrl(provider), key)
      if (!r.ok || !r.body) return null
      const list = r.body.data || r.body.models
      if (!Array.isArray(list)) return null
      const ids = list
        .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name)))
        .filter((v) => typeof v === 'string' && v)
      endpointModelsCache.set(provider.id, { at: Date.now(), ids })
      return ids
    } catch {
      return null
    }
  }

  // 读 llm-pi-ai entry 当前配置里某条路由已写的 models（保住 contextWindow 等字段）
  function readRouteModels(entry, routeId) {
    try {
      const cfg = entry && entry.options && entry.options.config
      const slot = cfg && cfg.providers && cfg.providers[routeId]
      if (slot && Array.isArray(slot.models)) return slot.models
    } catch {
      /* ignore */
    }
    return null
  }

  /** 火山路由自动挂载（2026-11-18）：保存/激活火山 Key 时若 volc-ark-cn 还没挂，
   *  自动按内置默认模型把整条路由写进 llm-pi-ai——否则主人的 Key 配了却一直黄灯
   *  「有 Key 但路由没挂上」（路由只在别名单非空时才创建，之前没人告诉主人要先进模型单加模型）。 */
  /** 硅基流动默认挂载模型（2026-11-19）：两款免费模型先上车，模型单里可再加。 */
  const SILICONFLOW_DEFAULT_MODELS = SILICONFLOW_MODELS

  async function ensureVolcRouteMounted(provider) {
    if (!provider || (provider.id !== 'volc' && provider.id !== 'siliconflow' && provider.id !== 'aliyun' && provider.id !== 'modelscope')) return false
    const routeId = provider.routeIds[0]
    if (routedProviderIds().indexOf(routeId) >= 0) return false
    const configEditor = ctx.get('configEditor')
    if (!configEditor) return false
    let entry = null
    for (const e of configEditor.entries()) {
      if (e && e.options && (e.options.id === 'llm-pi-ai' || e.options.name === '@deepseek-ai/dsh-llm-pi-ai')) entry = e
    }
    if (!entry) return false
    const defaults =
      provider.id === 'volc'
        ? ['doubao-seed-1.6', 'doubao-seed-1.6-flash']
        : provider.id === 'aliyun'
          ? ['qwen-flash', 'qwen-plus']
          : provider.id === 'modelscope'
            ? MODELSCOPE_MODELS.map((m) => m.id)
            : SILICONFLOW_DEFAULT_MODELS.map((m) => m.id)
    const table =
      provider.id === 'volc'
        ? VOLC_MODELS
        : provider.id === 'aliyun'
          ? ALIYUN_MODELS
          : provider.id === 'modelscope'
            ? MODELSCOPE_MODELS
            : SILICONFLOW_DEFAULT_MODELS
    const built = defaults.map((id) => {
      const def = table.filter((v) => v.id === id)[0] || {}
      return {
        id,
        name: def.name || id,
        contextWindow: Number(def.contextWindow) || 131072,
        maxTokens: Number(def.maxTokens) || 8192,
        input: Array.isArray(def.input) && def.input.length ? def.input : ['text'],
      }
    })
    try {
      await configEditor.edit(entry, (current) => {
        const next = { ...(current || {}) }
        const providers = { ...(next.providers || {}) }
        if (!providers[routeId]) {
          providers[routeId] = {
            displayName:
              provider.id === 'volc'
                ? '火山方舟'
                : provider.id === 'aliyun'
                  ? '阿里百炼'
                  : provider.id === 'modelscope'
                    ? '免费模型（魔搭 ModelScope）'
                    : '硅基流动',
            api: 'openai-completions',
            baseURL:
              provider.id === 'volc'
                ? 'https://ark.cn-beijing.volces.com/api/v3'
                : provider.id === 'aliyun'
                  ? 'https://dashscope.aliyuncs.com/compatible-mode/v1'
                  : provider.id === 'modelscope'
                    ? 'https://api-inference.modelscope.cn/v1'
                    : 'https://api.siliconflow.cn/v1',
            apiKeyEnv: provider.envRef,
            models: built,
          }
          next.providers = providers
        }
        return next
      })
      return true
    } catch {
      return false
    }
  }

  async function statePayload() {
    const routedIds = routedProviderIds()
    const providers = []
    for (const p of PROVIDERS) providers.push(await providerView(p, routedIds))
    const prices = readPrices()
    // 别名账本：每家路由白名单(llm.listModels)里的 id→name(别名)。
    // 比价表靠它标「这个模型你有没有起别名(=想不想用)」。
    const aliases = {}
    try {
      const llm = ctx.get('llm')
      if (llm) {
        for (const p of PROVIDERS) {
          for (const routeId of p.routeIds) {
            if (routedIds.indexOf(routeId) < 0) continue
            let models = []
            try {
              models = await llm.listModels(routeId)
            } catch {
              continue
            }
            for (const m of models) {
              aliases[routeId + ':' + String(m.id).toLowerCase()] = String(m.name || m.id)
            }
          }
        }
        // DeepSeek 官方路由（不是 pi-ai 家，但比价表也要标别名）
        if (routedIds.indexOf('deepseek-official') >= 0) {
          try {
            for (const m of await llm.listModels('deepseek-official')) {
              aliases['deepseek-official:' + String(m.id).toLowerCase()] = String(m.name || m.id)
            }
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    return {
      providers,
      aliases,
      pricing: {
        updatedAt: prices ? prices.updatedAt : null,
        errors: prices ? prices.errors || [] : [],
        running: scanning,
        lastError,
      },
      prices: prices ? prices.providers : [],
    }
  }

  const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } })
  const done = (value) => ({ ok: true, value })

  // ── 角色模型（设置 → 模型 → 角色模型）：读三份真实来源 + 可切换的模型清单 ──
  function roleOverride(role) {
    if (role === 'orb') {
      const parsed = readJson(ROLE_MODELS_FILE, {})
      const sel = parsed && parsed.orb
      if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
        return { provider: sel.provider, model: sel.model }
      }
      return null
    }
    if (role === 'butler') {
      const parsed = readJson(BUTLER_ROTATE_FILE, {})
      if (parsed && typeof parsed.provider === 'string' && typeof parsed.model === 'string') {
        return { provider: parsed.provider, model: parsed.model }
      }
      return null
    }
    return null
  }
  async function roleStatePayload() {
    let defaultModel = null
    try {
      const service = ctx.get('agentDefaultModel')
      const sel = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null
      if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
        defaultModel = { provider: sel.provider, model: sel.model }
      }
    } catch {
      /* 服务缺失时回落内置默认 */
    }
    const roles = ROLE_DEFS.map((def) => {
      let sel = null
      let source = ''
      if (def.id === 'pm') {
        sel = defaultModel
        source = '宿主默认模型（点「新会话」用它）'
      } else if (def.id === 'butler') {
        sel = roleOverride('butler')
        source = 'butler-rotate.json（换脑时用它）'
      } else {
        sel = roleOverride('orb')
        source = 'role-models.json（语音/播报用它）'
      }
      const fallback = ROLE_DEFAULTS[def.id]
      return {
        id: def.id,
        label: def.label,
        hint: def.hint,
        source,
        provider: (sel && sel.provider) || fallback.provider,
        model: (sel && sel.model) || fallback.model,
        overridden: !!sel,
      }
    })
    // 可切换的模型清单：每家已挂路由的 llm.listModels()（provider=route id）
    const out = []
    const seen = new Set()
    try {
      const llm = ctx.get('llm')
      const routed = routedProviderIds()
      for (const p of PROVIDERS) {
        for (const routeId of p.routeIds) {
          if (routed.indexOf(routeId) < 0) continue
          let models = []
          try {
            models = await llm.listModels(routeId)
          } catch {
            continue
          }
          for (const m of models) {
            const key = routeId + ':' + String(m.id)
            if (seen.has(key)) continue
            seen.add(key)
            out.push({ provider: routeId, model: String(m.id), label: String(m.name || m.id) })
          }
        }
      }
    } catch {
      /* 模型清单拿不到也不影响看/改当前值 */
    }
    return { roles, models: out }
  }
  async function setRoleModel(role, provider, model) {
    if (!ROLE_DEFS.some((def) => def.id === role)) return fail('bad-role', '未知角色')
    if (typeof provider !== 'string' || provider.trim() === '' || typeof model !== 'string' || model.trim() === '') {
      return fail('bad-model', 'provider / model 不能为空')
    }
    provider = provider.trim()
    model = model.trim()
    if (role === 'pm') {
      try {
        const service = ctx.get('agentDefaultModel')
        if (!service || typeof service.saveSelection !== 'function') return fail('unavailable', '宿主默认模型服务不可用')
        await service.saveSelection({ provider, model })
        return done({ role, provider, model, note: '下次点「新会话」即用' })
      } catch (error) {
        return fail('save-failed', String((error && error.message) || error))
      }
    }
    if (role === 'butler') {
      const current = readJson(BUTLER_ROTATE_FILE, {})
      writeJson(BUTLER_ROTATE_FILE, { ...(current && typeof current === 'object' ? current : {}), provider, model })
      return done({ role, provider, model, note: '下次换脑生效' })
    }
    const current = readJson(ROLE_MODELS_FILE, {})
    writeJson(ROLE_MODELS_FILE, { ...(current && typeof current === 'object' ? current : {}), orb: { provider, model } })
    return done({ role, provider, model, note: '球桥热读，下一句播报即用' })
  }

  // ── 模型榜单（2026-11-19 主人要「设置页顶部胶囊 → 三张榜」）──
  // 数据来源 = 比价缓存 prices.json（定时任务/手动刷新都会更新）× 已配 Key 的供应商，
  // 所以模型库一刷新、Key 一变，榜单自动跟着变，不用手动维护。
  function mhNum(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  const TOPS_PROVIDER_KEYS = {
    deepseek: ['deepseek', 'deepseek-tools'],
    'zhipu-plan': ['zhipuai-coding-plan', 'zhipu'],
    siliconflow: ['siliconflow'],
    volc: ['volc', 'volc-ark-live'],
    aliyun: ['aliyun', 'aliyun-live'],
  }
  async function topsPayload() {
    const prices = readPrices()
    const usable = []
    for (const prov of PROVIDERS) {
      let linked = false
      try {
        const info = await credentials.describe(prov.envRef)
        linked = !!(info && info.configured)
      } catch {
        /* ignore */
      }
      if (linked) usable.push(prov)
    }
    const pool = []
    if (prices) {
      for (const pp of prices.providers || []) {
        const owner = usable.filter((u) => (TOPS_PROVIDER_KEYS[u.id] || []).indexOf(pp.providerKey) >= 0)[0]
        if (!owner) continue
        for (const m of pp.models || []) {
          if ((m.category || 'text') !== 'text') continue
          const p = m.price || {}
          const miss = mhNum(p.inputMiss && p.inputMiss.offpeak)
          const out = mhNum(p.output && p.output.offpeak)
          const peakOut = mhNum(p.output && p.output.peak)
          if (miss == null && out == null) continue
          // 同名模型只收第一份（正式价目家在前，实拉/目录家不覆盖——教训 66）
          if (pool.some((x) => x.name === m.name)) continue
          const caps = m.caps || []
          const capsScore = (caps.indexOf('tools') >= 0 ? 2 : 0) + (caps.indexOf('reasoning') >= 0 ? 2 : 0) + (caps.indexOf('vision') >= 0 ? 1 : 0)
          const free = !!(m.free || ((miss || 0) === 0 && (out || 0) === 0))
          const priceText =
            free
              ? '免费'
              : [miss != null ? '输入 ¥' + miss : null, out != null ? '输出 ¥' + out : null].filter(Boolean).join(' / ') + ' 每百万'
          pool.push({
            name: m.name,
            provider: owner.title,
            caps,
            capsScore,
            free,
            miss,
            out,
            peakOut: peakOut == null ? out || 0 : peakOut,
            ctx: m.contextText || '',
            desc: String(m.description || '').slice(0, 140),
            priceText,
          })
        }
      }
    }
    const pick = (list) =>
      list.slice(0, 5).map((m) => ({ name: m.name, provider: m.provider, price: m.priceText, caps: m.caps, ctx: m.ctx, desc: m.desc }))
    // ① 最强：已配 Key 里挑旗舰——输出价高≈官方定位旗舰，能力标签做平手判定
    const strong = pool
      .filter((m) => !m.free)
      .slice()
      .sort((a, b) => b.peakOut - a.peakOut || b.capsScore - a.capsScore)
    // ② 性价比：非免费里按「输入+3×输出」综合花费最低（静态价目家大多没带 caps，
    //    不做能力过滤，免费档留给第三张榜）
    const value = pool
      .filter((m) => !m.free)
      .slice()
      .sort((a, b) => (a.miss || 0) + (a.out || 0) * 3 - ((b.miss || 0) + (b.out || 0) * 3))
    // ③ 免费最强：全 0 价里按能力标签+峰值价（≈官方定位）排
    const free = pool.filter((m) => m.free).sort((a, b) => b.capsScore - a.capsScore || b.peakOut - a.peakOut)
    // ④ NSFW 专区（2026-11-19 主人要的）：全网比价库直读（不受已配 Key 限制——
    //    这类模型都在第三方聚合渠道，主人家里没配它们的 Key 也要看得到），只认
    //    nsfw 字段里的 adult/roleplay/nsfw-image 真标记（unmoderated 低审查不算），
    //    按「输入 + 3×输出」综合花费从低到高。
    const NSFW_TAGS = { adult: '成人', roleplay: '角色扮演', 'nsfw-image': 'NSFW 绘图' }
    const nsfwPool = []
    if (prices) {
      for (const pp of prices.providers || []) {
        for (const m of pp.models || []) {
          const tags = (m.nsfw || []).filter((t) => NSFW_TAGS[t])
          if (!tags.length) continue
          const p = m.price || {}
          const miss = mhNum(p.inputMiss && p.inputMiss.offpeak)
          const out = mhNum(p.output && p.output.offpeak)
          if (miss == null && out == null) continue
          // 同名只收第一份（正式价目家在前）
          if (nsfwPool.some((x) => x.name === m.name)) continue
          nsfwPool.push({
            name: m.name,
            provider: m.providerName || pp.title || '',
            tags: tags.map((t) => NSFW_TAGS[t]),
            ctx: m.contextText || '',
            desc: String(m.description || '').slice(0, 140),
            priceText: [miss != null ? '输入 ¥' + miss : null, out != null ? '输出 ¥' + out : null].filter(Boolean).join(' / ') + ' 每百万',
            cost: (miss || 0) + (out || 0) * 3,
          })
        }
      }
    }
    // 家族归一：去掉「 · 渠道」后缀和版本号，让 MythoMax 四个渠道合并成一条（2026-11-19 主人骂「别让老古董刷屏」后加）
    const nsfwFamily = (name) => String(name).split(' · ')[0].toLowerCase().replace(/\bl2\b|\bv\d+(\.\d+)*\b|\b13b\b|\b24b\b|\b70b\b|\b72b\b|\b12b\b|\b8b\b/g, '').replace(/\s+/g, ' ').trim()
    // 血统质量档：3=当代旗舰级 RP 微调 / 2=公认无审查系 / 1=老古董兜底（ MythoMax 这类 2023 年 13B）
    const NSFW_QUALITY = [
      [3, /cydonia|euryale|magnum|behemoth|midnight-rose|anubis/i],
      [2, /unslopnemo|dolphin|venice|lunaris|rocinante|noromaid|lumimaid|wizardlm|fimbulvetr|stheno|weaver/i],
    ]
    const nsfwTier = (name) => { const s = String(name).toLowerCase(); for (const [t, re] of NSFW_QUALITY) if (re.test(s)) return t; return 1 }
    // 同族只留综合花费最低那份（渠道不同价不同，别重复占榜）
    const byFamily = new Map()
    for (const m of nsfwPool) {
      const fam = nsfwFamily(m.name)
      const prev = byFamily.get(fam)
      if (!prev || m.cost < prev.cost) byFamily.set(fam, m)
    }
    // 先按血统档位（高在前），同档再按综合花费（低在前）——便宜不再是唯一标准
    const nsfwRanked = [...byFamily.values()].sort((a, b) => nsfwTier(b.name) - nsfwTier(a.name) || a.cost - b.cost)
    const nsfw = nsfwRanked.slice(0, 5).map((m) => ({
      name: m.name,
      provider: m.provider,
      price: m.priceText,
      nsfwTags: m.tags,
      ctx: m.ctx,
      desc: m.desc,
    }))
    return {
      updatedAt: prices ? prices.updatedAt : null,
      usableProviders: usable.map((u) => u.title),
      strong: pick(strong),
      value: pick(value),
      free: pick(free),
      nsfw,
      nsfwCount: nsfwPool.length,
    }
  }

  // ── DeepTutor（2026-11-19 主人拍板加角色卡）：读 E:\deeptutor 的模型目录，可切主模型 ──
  const DEEPTUTOR_CATALOG = 'E:\\deeptutor\\home\\data\\user\\settings\\model_catalog.json'
  function deeptutorStatePayload() {
    const cat = readJson(DEEPTUTOR_CATALOG, null)
    if (!cat || !cat.services || !cat.services.llm) return { current: '', models: [], error: '未安装 DeepTutor（缺 model_catalog.json）' }
    const svc = cat.services.llm
    const models = []
    for (const prof of Array.isArray(svc.profiles) ? svc.profiles : []) {
      for (const m of Array.isArray(prof.models) ? prof.models : []) {
        models.push({ model: String(m.model || ''), label: String(m.name || m.model || ''), profileId: String(prof.id || ''), provider: String(prof.binding || '') })
      }
    }
    const active = models.find((m) => m.profileId === svc.active_profile_id && m.model && svc.active_model_id)
    const activeModel = cat.services.llm.profiles
      ?.flatMap((pr) => Array.isArray(pr.models) ? pr.models : [])
      ?.find((m) => m.id === svc.active_model_id)
    return { current: String((activeModel && activeModel.model) || (active && active.model) || ''), models }
  }
  function deeptutorSetModel(model) {
    if (typeof model !== 'string' || model.trim() === '') return fail('bad-model', 'model 不能为空')
    model = model.trim()
    const cat = readJson(DEEPTUTOR_CATALOG, null)
    if (!cat || !cat.services || !cat.services.llm) return fail('unavailable', 'DeepTutor 未安装或目录不可读')
    const svc = cat.services.llm
    const hit = (Array.isArray(svc.profiles) ? svc.profiles : []).find((pr) =>
      Array.isArray(pr.models) && pr.models.some((m) => String(m.model || '') === model),
    )
    if (!hit) return fail('bad-model', 'DeepTutor 目录里没有模型：' + model)
    const m = hit.models.find((x) => String(x.model || '') === model)
    svc.active_profile_id = hit.id
    svc.active_model_id = m.id
    writeJson(DEEPTUTOR_CATALOG, cat)
    return done({ model, note: 'DeepTutor 下一次调用即用新模型' })
  }

  async function handle(endpoint, payload) {
    const p = payload && typeof payload === 'object' ? payload : {}
    switch (endpoint) {
      case 'state':
        return done(await statePayload())

      case 'tops':
        return done(await topsPayload())

      case 'deeptutor.state':
        return done(deeptutorStatePayload())

      case 'deeptutor.set':
        return deeptutorSetModel(String(p.model || ''))



      case 'roles.state':
        return done(await roleStatePayload())

      case 'roles.set':
        return await setRoleModel(String(p.role || ''), p.provider, p.model)

      case 'pricing.refresh':
        if (scanning) return done({ started: false, message: '正在刷新中' })
        void runScan()
        return done({ started: true })

      case 'pricing.latest': {
        const prices = readPrices()
        return done({
          updatedAt: prices ? prices.updatedAt : null,
          errors: prices ? prices.errors || [] : [],
          running: scanning,
          lastError,
          providers: prices ? prices.providers : [],
        })
      }

      case 'keys.add': {
        const provider = providerById(p.provider)
        if (!provider) return fail('bad-provider', '未知供应商')
        const key = String(p.key || '').trim()
        const alias = String(p.alias || '').trim().slice(0, 40)
        if (!key) return fail('empty-key', '请填写 API Key')
        if (!/^[\x21-\x7E]+$/.test(key)) return fail('bad-key', 'Key 只能是可打印 ASCII（不要带空格或中文）')
        const index = readKeyIndex()
        const slot = index.providers[provider.id]
        const id = makeItemId()
        const item = {
          id,
          alias: alias || 'Key ' + (slot.items.length + 1),
          ref: secretRef(provider.id, id),
          createdAt: new Date().toISOString(),
        }
        await credentials.set(item.ref, key)
        slot.items.push(item)
        let wroteEnvRef = false
        if (!slot.active) {
          slot.active = id
          await credentials.set(provider.envRef, key)
          wroteEnvRef = true
        }
        // 火山：Key 落位后路由还没挂就自动挂上默认模型（治「有 Key 但黄灯」）
        await ensureVolcRouteMounted(provider)
        try {
          writeKeyIndex(index)
        } catch (e) {
          // 落盘失败：把刚写进凭据库的密文回滚，避免留下「能解析但列不出来」的孤儿 Key。
          // 首个 Key 还会顺手写 provider.envRef，同样要一起回滚，否则 UI 里没 Key 但模型仍在用。
          await credentials.unset(item.ref).catch(() => {})
          if (wroteEnvRef) await credentials.unset(provider.envRef).catch(() => {})
          return fail('write-index', '密钥索引写入失败：' + String((e && e.message) || e))
        }
        return done({ id, activated: slot.active === id })
      }

      case 'keys.activate': {
        const provider = providerById(p.provider)
        if (!provider) return fail('bad-provider', '未知供应商')
        const index = readKeyIndex()
        const slot = index.providers[provider.id]
        const item = slot.items.filter((k) => k.id === p.id)[0]
        if (!item) return fail('not-found', '这把 Key 不在了')
        const value = await resolveSecret(item.ref)
        if (!value) return fail('missing-secret', '这把 Key 的密文已经不在了，请删掉重新添加')
        slot.active = item.id
        writeKeyIndex(index)
        await credentials.set(provider.envRef, value)
        await ensureVolcRouteMounted(provider)
        return done({ active: item.id })
      }

      case 'keys.remove': {
        const provider = providerById(p.provider)
        if (!provider) return fail('bad-provider', '未知供应商')
        const index = readKeyIndex()
        const slot = index.providers[provider.id]
        const item = slot.items.filter((k) => k.id === p.id)[0]
        if (!item) return fail('not-found', '这把 Key 不在了')
        slot.items = slot.items.filter((k) => k.id !== p.id)
        try {
          await credentials.unset(item.ref)
        } catch {
          /* 已不存在也算删掉 */
        }
        if (slot.active === item.id) {
          slot.active = slot.items.length ? slot.items[0].id : ''
          if (slot.active) {
            const next = slot.items.filter((k) => k.id === slot.active)[0]
            const value = await resolveSecret(next.ref)
            if (value) await credentials.set(provider.envRef, value)
            else await credentials.unset(provider.envRef).catch(() => {})
          } else {
            await credentials.unset(provider.envRef).catch(() => {})
          }
        }
        writeKeyIndex(index)
        return done({ active: slot.active })
      }

      case 'keys.test': {
        const provider = providerById(p.provider)
        if (!provider) return fail('bad-provider', '未知供应商')
        let key = ''
        if (p.id) {
          const index = readKeyIndex()
          const slot = index.providers[provider.id]
          const item = slot.items.filter((k) => k.id === p.id)[0]
          if (item) key = await resolveSecret(item.ref)
        } else {
          key = await activeSecret(provider)
        }
        if (!key) return done({ ok: false, message: '还没有可用的 Key' })
        try {
          const r = await getJson(probeUrl(provider), key)
          if (r.status === 401 || r.status === 403) return done({ ok: false, message: 'Key 无效或已过期（HTTP ' + r.status + '）' })
          if (!r.ok) return done({ ok: false, message: '接口返回 HTTP ' + r.status })
          const list = (r.body && (r.body.data || r.body.models)) || null
          const count = Array.isArray(list) ? list.length : 0
          return done({ ok: true, message: count ? '连通正常（接口报出 ' + count + ' 个模型）' : '连通正常' })
        } catch (e) {
          return done({ ok: false, message: '连不上：' + String((e && e.message) || e).slice(0, 120) })
        }
      }

      case 'keys.balance': {
        const provider = providerById(p.provider)
        if (!provider) return fail('bad-provider', '未知供应商')
        const key = await activeSecret(provider)
        if (!key) return done({ ok: false, message: '还没有可用的 Key' })
        if (provider.probe === 'volc') {
          // 方舟 API Key 查不了余额，但火山云账户余额可以走积分板同一条链：
          // apps/cloud-balance/balance.mjs（AK/SK DPAPI 加密，Billing QueryBalanceAcct）
          try {
            const CLOUD_DIR = 'E:/DJH/workspaces/default-workspace/apps/cloud-balance'
            const { stdout } = await execFileP(process.execPath, [CLOUD_DIR + '/balance.mjs', '--json'], {
              windowsHide: true,
              timeout: 90 * 1000,
              cwd: CLOUD_DIR,
            })
            const j = JSON.parse(String(stdout).trim().split('\n').pop())
            const v = j.accounts && j.accounts.volc
            if (!v || !v.ok) return done({ ok: false, message: '火山云账户查询失败：' + ((v && v.error) || '无返回') })
            return done({ ok: true, message: '火山云账户可用余额 ￥' + Number(v.balance).toFixed(2) + '（与积分板同源，方舟 API Key 本身查不了余额）' })
          } catch (e) {
            return done({ ok: false, message: '查询失败：' + String((e && e.message) || e).slice(0, 120) })
          }
        }
        if (provider.probe === 'aliyun') {
          // 百炼 API Key 查不了余额；阿里云账户余额走积分板同一条链（cloud-balance AK/SK）
          try {
            const CLOUD_DIR = 'E:/DJH/workspaces/default-workspace/apps/cloud-balance'
            const { stdout } = await execFileP(process.execPath, [CLOUD_DIR + '/balance.mjs', '--json'], {
              windowsHide: true,
              timeout: 90 * 1000,
              cwd: CLOUD_DIR,
            })
            const j = JSON.parse(String(stdout).trim().split('\n').pop())
            const v = j.accounts && j.accounts.aliyun
            if (!v || !v.ok) return done({ ok: false, message: '阿里云账户查询失败：' + ((v && v.error) || '无返回') })
            return done({ ok: true, message: '阿里云账户可用余额 ￥' + Number(v.balance).toFixed(2) + '（百炼调用从这里扣）' })
          } catch (e) {
            return done({ ok: false, message: '查询失败：' + String((e && e.message) || e).slice(0, 120) })
          }
        }
        if (provider.probe === 'siliconflow') {
          // 硅基流动 2026-11 已下线 /v1/user/info 余额接口（410 code 20092）——余额只能去控制台看
          try {
            const r = await getJson('https://api.siliconflow.cn/v1/user/info', key)
            if (r.ok && r.body && r.body.data) {
              const d = r.body.data
              const bal = d.chargeBalance != null ? '￥' + Number(d.chargeBalance).toFixed(2) : ''
              const tot = d.totalBalance != null ? '（总计 ￥' + Number(d.totalBalance).toFixed(2) + '）' : ''
              return done({ ok: true, message: (bal || '接口没返回余额') + tot })
            }
            return done({ ok: false, message: '硅基流动已下线 API 余额接口，请到 cloud.siliconflow.cn 费用中心查看（Key 有效，模型可正常调用）' })
          } catch (e) {
            return done({ ok: false, message: '查询失败：' + String((e && e.message) || e).slice(0, 120) })
          }
        }
        if (provider.probe === 'deepseek') {
          try {
            const r = await getJson('https://api.deepseek.com/user/balance', key)
            if (r.status === 401 || r.status === 403) return done({ ok: false, message: 'Key 无效（HTTP ' + r.status + '）' })
            const infos = (r.body && r.body.balance_infos) || []
            if (!infos.length) return done({ ok: false, message: '接口没返回余额（HTTP ' + r.status + '）' })
            const text = infos
              .map((i) => {
                const cur = String(i.currency || '').toUpperCase()
                const symbol = cur === 'CNY' ? '￥' : cur === 'USD' ? '$' : cur + ' '
                return symbol + String(i.total_balance || '0')
              })
              .join(' · ')
            return done({ ok: true, message: text })
          } catch (e) {
            return done({ ok: false, message: '查询失败：' + String((e && e.message) || e).slice(0, 120) })
          }
        }
        try {
          const r = await getJson('https://open.bigmodel.cn/api/monitor/usage/quota/limit', key)
          if (r.status === 401 || r.status === 403) return done({ ok: false, message: 'Key 无效（HTTP ' + r.status + '）' })
          const root = (r.body && (r.body.data || r.body)) || {}
          const limits = Array.isArray(root.limits) ? root.limits : []
          const items = limits
            .filter((l) => l && l.percentage != null)
            .map((l) => ({ unit: Number(l.unit), number: Number(l.number), percentage: Number(l.percentage) }))
          const durMs = (it) =>
            it.unit === 3
              ? it.number * 3600000
              : it.unit === 4
                ? it.number * 604800000
                : it.unit === 6
                  ? it.number * 86400000
                  : 0
          const known = items.filter((it) => durMs(it) > 0).sort((a, b) => durMs(a) - durMs(b))
          const label = (it) => {
            const ms = durMs(it)
            if (!ms) return '额度'
            if (ms <= 6 * 3600000) return '5 小时'
            if (ms <= 2 * 86400000) return '额度'
            return '一周'
          }
          if (!items.length) return done({ ok: false, message: '接口没返回额度（HTTP ' + r.status + '）' })
          const parts = (known.length ? known : items).map((it) => label(it) + ' 已用 ' + it.percentage + '%')
          return done({ ok: true, message: parts.join(' · ') })
        } catch (e) {
          return done({ ok: false, message: '查询失败：' + String((e && e.message) || e).slice(0, 120) })
        }
      }

      case 'models.list': {
        const provider = providerById(p.provider)
        if (!provider) return fail('bad-provider', '未知供应商')
        const routeId = provider.routeIds[0]
        let active = []
        try {
          const llm = ctx.get('llm')
          if (llm) active = (await llm.listModels(routeId)).map((m) => ({ id: m.id, name: m.name || m.id }))
        } catch {
          /* 路由还没挂上（比如火山第一次配置前）——active 就是空 */
        }
        // 候选池：火山用内置表；GLM 两家 = 端点 /models 实际返回 ∩ pi-ai 内置 catalog
        // （coding 端点会把全家族都报出来，主人只订阅 Token Plan 里那两个 →
        //   用 llm.discoverModels 读 pi-ai catalog 做交集，杂音全滤掉）；
        // DeepSeek 官方 = 端点 /models 直接返回（deepseek-flash / v4-pro…）。
        let catalog = []
        let note = ''
        if (provider.id === 'volc') {
          catalog = VOLC_MODELS.map((m) => ({ id: m.id, name: m.name }))
        } else if (provider.id === 'siliconflow') {
          // 模型 id 带 'Qwen/…' 命名空间斜杠，pi-ai catalog 交集会滤没 → 直接用端点 /models 实拉
          const probed = await probeEndpointModels(provider)
          catalog = (probed || []).map((id) => ({ id, name: id }))
          catalog.sort((a, b) => a.id.localeCompare(b.id))
          if (!probed) note = '没能从硅基流动端点拉到模型列表——可以手动补：下面输入框里直接填模型 id'
        } else if (provider.id === 'aliyun') {
          // 百炼端点会报全家族（音频/嵌入/图像/realtime…），只留文本对话系
          const probed = await probeEndpointModels(provider)
          catalog = (probed || [])
            .filter((id) => /^qwen/i.test(id) && !/realtime|audio|omni|embedding|rerank|image|ocr|mt|livetranslate|deep-research|deep-search|character|tts|coder/i.test(id))
            .map((id) => ({ id, name: id.toUpperCase() }))
            .sort((a, b) => a.id.localeCompare(b.id))
          if (!probed) note = '没能从百炼端点拉到模型列表——可以手动补：下面输入框里直接填模型 id'
        } else if (provider.id === 'deepseek') {
          const probed = await probeEndpointModels(provider)
          catalog = (probed || [])
            .filter((id) => /deepseek|deep-seek/.test(String(id).toLowerCase()))
            .map((id) => ({ id, name: id }))
            .sort((a, b) => a.id.localeCompare(b.id))
          if (!probed) note = '没能从 DeepSeek 端点拉到模型列表——可以手动补：下面输入框里直接填模型 id'
        } else {
          let allowed = null
          try {
            const llm = ctx.get('llm')
            allowed = new Set((await llm.discoverModels('llm-pi-ai', { provider: routeId })).map((m) => String(m.id).toLowerCase()))
          } catch {
            allowed = null
          }
          const probed = await probeEndpointModels(provider)
          const pool = (probed || []).map((id) => ({ id, name: id.toUpperCase() }))
          if (allowed) {
            catalog = pool.filter((m) => allowed.has(m.id.toLowerCase()))
            if (!probed) note = '没能从端点拉到模型列表，先按官方 catalog 展示；也可以在下面手填模型 id'
          } else {
            catalog = pool
            note = probed ? '' : '没能从端点拉到模型列表（Key 没配或网络不通）——可以手动补：下面输入框里直接填模型 id'
          }
          catalog.sort((a, b) => a.id.localeCompare(b.id))
        }
        const activeIds = new Set(active.map((m) => m.id))
        return done({
          routeId,
          rule: '别名是可选的：填了 = 模型选择器里显示别名；不填 = 直接显示模型 id。清空保存 = 移出选择器。',
          note,
          active,
          catalog: catalog.filter((m) => !activeIds.has(m.id)),
        })
      }

      case 'models.set': {
        const provider = providerById(p.provider)
        if (!provider) return fail('bad-provider', '未知供应商')
        const routeId = provider.routeIds[0]
        const list = Array.isArray(p.models) ? p.models : []
        const clean = []
        const seen = new Set()
        for (const raw of list) {
          const id = String((raw && raw.id) || '').trim()
          const alias = String((raw && raw.alias) || '').trim().slice(0, 60)
          if (!id) return fail('bad-model', '模型 id 不能为空')
          // 主人 2026-11-18 取消「必须有别名」：别名可空，空则直接用模型 id 当显示名
          if (seen.has(id)) return fail('dup-model', '模型 ' + id + ' 出现了两次')
          seen.add(id)
          clean.push({ id, alias: alias || id })
        }
        if (!clean.length && provider.id !== 'volc') {
          return fail('empty-models', provider.title + ' 至少保留一个模型（这是模型路由，全删会瘫；火山例外——清空=整条下线）')
        }
        const configEditor = ctx.get('configEditor')
        if (!configEditor) return fail('no-config-editor', '这台 DSH 没有配置编辑服务，没法热改模型清单')

        // DeepSeek 官方：走 llm-deepseek 自己的配置（models[].name 当别名，其余字段保留）
        if (provider.configEntryId) {
          let entry = null
          for (const e of configEditor.entries()) {
            if (e && e.options && e.options.id === provider.configEntryId) entry = e
          }
          if (!entry) return fail('no-entry', '找不到 ' + provider.configEntryId + ' 的配置入口')
          const curModels = (entry.options && entry.options.config && entry.options.config.models) || []
          const built = clean.map((m) => {
            const old = curModels.filter((o) => o && o.id === m.id)[0]
            if (old) return { ...old, name: m.alias }
            // 新增条目：catalogModel 的必填字段给齐
            return {
              id: m.id,
              name: m.alias,
              description: '',
              contextWindow: 1000000,
              // 2026-11-18 修正：原来写 8192，长回答会被 DSH 截断（「已达到输出 token 上限」）。
              // 官方 /models 实测 max_output_tokens=393216，这里给 65536（64K）足够。
              maxTokens: 65536,
              inputModalities: ['text'],
            }
          })
          try {
            await configEditor.edit(entry, (current) => ({ ...(current || {}), models: built }))
          } catch (e) {
            return fail('write-failed', '写入模型配置失败：' + String((e && e.message) || e))
          }
          return done({ count: clean.length, routeId })
        }

        let entry = null
        for (const e of configEditor.entries()) {
          // loader entry 的标识在 e.options（不是 e.id/e.name）
          if (e && e.options && (e.options.id === 'llm-pi-ai' || e.options.name === '@deepseek-ai/dsh-llm-pi-ai')) entry = e
        }
        if (!entry) return fail('no-entry', '找不到 llm-pi-ai 的配置入口')
        const oldModels = await readRouteModels(entry, routeId)
        const built = clean.map((m) => {
          const old = (oldModels || []).filter((o) => o && o.id === m.id)[0]
          const def = provider.id === 'volc' ? VOLC_MODELS.filter((v) => v.id === m.id)[0] : null
          const base = old || def || {}
          return {
            id: m.id,
            name: m.alias,
            contextWindow: Number(base.contextWindow) || GLM_MODEL_DEFAULTS.contextWindow,
            maxTokens: Number(base.maxTokens) || GLM_MODEL_DEFAULTS.maxTokens,
            input: Array.isArray(base.input) && base.input.length ? base.input : GLM_MODEL_DEFAULTS.input,
          }
        })
        try {
          await configEditor.edit(entry, (current) => {
            const next = { ...(current || {}) }
            const providers = { ...(next.providers || {}) }
            if (!clean.length) {
              // 火山全清 = 整条路由下线
              delete providers[routeId]
            } else if (providers[routeId]) {
              providers[routeId] = { ...providers[routeId], models: built }
            } else {
              // 第一次给火山起别名：整条路由挂上
              providers[routeId] = {
                displayName: '火山方舟',
                api: 'openai-completions',
                baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
                apiKeyEnv: provider.envRef,
                models: built,
              }
            }
            next.providers = providers
            return next
          })
        } catch (e) {
          return fail('write-failed', '写入模型配置失败：' + String((e && e.message) || e))
        }
        return done({ count: clean.length, routeId })
      }

      case 'models.test': {
        const provider = providerById(p.provider)
        if (!provider) return fail('bad-provider', '未知供应商')
        const modelId = String(p.model || '').trim()
        if (!modelId) return fail('bad-model', '模型 id 不能为空')
        const key = await activeSecret(provider)
        if (!key) return done({ ok: false, message: '还没有可用的 Key' })
        const chatBase = {
          volc: 'https://ark.cn-beijing.volces.com/api/v3',
          deepseek: 'https://api.deepseek.com',
          'zhipu-plan': 'https://open.bigmodel.cn/api/coding/paas/v4',
        }[provider.id]
        if (!chatBase) return done({ ok: false, message: '这家供应商暂不支持在线测试' })
        const t0 = Date.now()
        try {
          const r = await postJson(chatBase + '/chat/completions', key, {
            model: modelId,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
            stream: false,
          })
          const ms = Date.now() - t0
          if (r.status === 401 || r.status === 403) return done({ ok: false, message: 'Key 无效或已过期（HTTP ' + r.status + '）' })
          if (r.status === 404) return done({ ok: false, message: '模型不存在或无权访问（404）：' + modelId })
          if (!r.ok) {
            const em = r.body && r.body.error && (r.body.error.message || r.body.error.code)
            return done({ ok: false, message: 'HTTP ' + r.status + (em ? '：' + String(em).slice(0, 120) : '') })
          }
          return done({ ok: true, message: '测试通过（' + ms + 'ms）——模型能正常响应' })
        } catch (e) {
          return done({ ok: false, message: '连不上：' + String((e && e.message) || e).slice(0, 120) })
        }
      }

      default:
        return fail('unknown-endpoint', '未知接口：' + String(endpoint))
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
        let payload = {}
        try {
          const chunks = []
          let size = 0
          for await (const chunk of req) {
            size += chunk.length
            if (size > 1024 * 1024) throw new Error('请求体过大')
            chunks.push(chunk)
          }
          const raw = Buffer.concat(chunks).toString('utf8')
          if (raw) payload = JSON.parse(raw)
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: { code: 'bad-body', message: '请求体不是合法 JSON' } }))
          return
        }
        let result
        try {
          result = await handle(endpoint, payload)
        } catch (e) {
          result = { ok: false, error: { code: 'internal', message: String((e && e.message) || e), details: {} } }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(result))
      },
    }),
  )

  // 定时扫描：启动 20 秒后检查一次，之后每 30 分钟检查（条件：距上次 >= 3 天且已过 08:00）
  ctx.effect(() => {
    const tick = () => {
      if (shouldScan(readPrices())) void runScan()
    }
    const first = ctx.timer.timeout(tick, 20 * 1000)
    const repeat = ctx.timer.interval(tick, 30 * 60 * 1000)
    return () => {
      first()
      repeat()
    }
  })

  // 启动自检：把「哪几家真的挂在模型路由上」落到 diag.json，
  // 出问题时看这一个文件就知道是 Key 没配还是路由没挂。
  ctx.effect(() => {
    const probe = ctx.timer.timeout(() => {
      try {
        const routed = routedProviderIds()
        writeJson(path.join(DATA_DIR, 'diag.json'), {
          at: new Date().toISOString(),
          routed,
          providers: PROVIDERS.map((p) => ({
            id: p.id,
            envRef: p.envRef,
            routeId: p.routeIds[0],
            routed: p.routeIds.some((id) => routed.indexOf(id) >= 0),
          })),
        })
      } catch {
        /* 诊断失败不影响主流程 */
      }
    }, 6000)
    return () => probe()
  })
}
