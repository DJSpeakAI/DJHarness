/**
 * dsh-tts-voice（Host 半）—— 四家 TTS 统一网关 + 音色/别名/入口配置 API + 余额/花费统计。
 *
 * Web 路由 POST /tts-voice-api（走 connection.admit 鉴权）：
 *   {op:'state'}                      → { providers, entries, aliases, custom, keysOk, usage, prices }
 *   {op:'voices', provider, refresh?}  → { voices:[{id,name,group,custom}], remote:{ok,count,error,note} }
 *   {op:'balances', provider?}         → { providers:{ deepseek|volc|aliyun|breeze: {ok,text|error,at} } }
 *   {op:'speak', provider, voice, text} → 200 audio/mpeg|wav（试听&对话播报；顺带记账）
 *   {op:'save', entries?, aliases?, custom?} → 写 E:/DJH/home/tts-voice.json
 *   {op:'setBreezeKey', key}          → 写 .credentials.yaml BREEZE_API_KEY（不回显）
 *   {op:'selection', entry}           → { provider, voice }（msg-speak 兼容入口）
 *
 * 本机网关：http://127.0.0.1:9791/tts（只绑回环，星闪球宿主 djh-cat 转发用，免鉴权同 orb-bridge）
 *   POST {text, ...}（DeepSeek 老格式兼容）→ 按入口 orb 的选择合成，返回音频。
 *
 * 四家：
 *   deepseek  /v1/tools/tts（stella/tide）                key: DEEPSEEK_API_KEY
 *   volc      openspeech v3 unidirectional SSE（seed-tts-2.0；S_ 前缀→seed-icl-2.0）key: VOLC_AUDIO_API_KEY
 *   aliyun    dashscope SpeechSynthesizer（cosyvoice-v2）  key: cloud-balance keys.dpapi 的 aliyun.dashscope
 *   breeze    api.breeze.blue /v1/text-to-speech/{voice}   key: BREEZE_API_KEY（网页端生成 brz_ 开头）
 * 密钥永不出宿主；浏览器只拿音频。
 *
 * 2026-11-19（v0.171）：①余额接口（DeepSeek /user/balance、火山云+阿里云走 apps/cloud-balance，
 *   Breeze 走 credits/summary + DPAPI 登录态）②每次播报记账（字数 + 花费估算，Breeze 按官方权重精确算积分）
 *   ③我的音色「从官网刷新」（Breeze 真拉 /v1/voices；火山/阿里官方只给控制台，接口拿不到时回明确提示）。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs'
import { spawnSync, execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

export const name = '@local/dsh-tts-voice'
export const inject = ['connection', 'webServer']

const ROUTE = '/tts-voice-api'
const STATE_PATH = 'E:/DJH/home/tts-voice.json'
const USAGE_PATH = 'E:/DJH/home/tts-voice-usage.json'
const CREDS_PATH = 'E:/DJH/home/.credentials.yaml'
const CB_DIR = 'E:/DJH/workspaces/default-workspace/apps/cloud-balance'
const CB_KEYS_DPAPI = CB_DIR + '/secrets/keys.dpapi'
const BZ_DIR = 'E:/DJH/workspaces/default-workspace/apps/breeze-claim'
const BZ_TOKEN = BZ_DIR + '/secrets/token.dpapi'
const BZ_DPAPI = BZ_DIR + '/lib/dpapi.ps1'
const LOCAL_PORT = 9791
const TEXT_MAX = 9500

/* 单价（官网刊例价，2026-11 实测核对；tts-voice.json 的 prices 可覆盖）。
   计费口径各家不同，统一按「每千计费单位」存：
   - deepseek / breeze：**计费字符**（汉字=2、其他=1）
   - aliyun / volc：**普通字符**（一个汉字算 1） */
const DEFAULT_PRICES = {
  deepseek: { per1kUnits: 0.15, unit: 'billing', note: '官方 ￥3/万计费字符（限时 5 折 ￥1.5/万）；汉字算 2' },
  volc: { per1kUnits: 0.28, unit: 'char', note: '豆包语音合成 2.0 资源包 10 万字 ￥28（￥2.8/万字符）' },
  aliyun: { per1kUnits: 0.20, unit: 'char', note: 'cosyvoice-v2 ￥2/万字符（v3.5-flash 只要 ￥0.8/万）' },
  breeze: { per1kUnits: 0, unit: 'billing', note: '官方权重计费：中日韩字符 2、其他 1，10 权重 = 1 积分' },
}
/* Breeze：10,000 积分 = $3 → 1 积分 ≈ ￥0.00216（按 7.2 汇率） */
const BZ_CREDIT_CNY = 0.00216
/* 阿里 CosyVoice 可选模型（每万字符刊例价；v3.5 系官网音色实测未放开，音色需手填） */
const ALI_MODELS = [
  { id: 'cosyvoice-v3.5-flash', label: 'v3.5-flash（￥0.8/万字符·最新，官方音色未放开需手填）' },
  { id: 'cosyvoice-v3-flash', label: 'v3-flash（￥1/万字符·推荐，官方音色实测可用）' },
  { id: 'cosyvoice-v3.5-plus', label: 'v3.5-plus（￥1.5/万字符，官方音色未放开）' },
]

/* ───────────────────────── 配置状态 ───────────────────────── */

const DEFAULT_STATE = {
  entries: {
    chat: { provider: 'deepseek', voice: 'stella' },
    orb: { provider: 'deepseek', voice: 'stella' },
  },
  aliases: { deepseek: {}, volc: {}, aliyun: {}, breeze: {} },
  custom: { volc: [], aliyun: [], breeze: [], deepseek: [] },
  models: { aliyun: 'cosyvoice-v3-flash' },
  prices: DEFAULT_PRICES,
}

let state = loadState()
function loadState() {
  try {
    const j = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    return {
      entries: { ...DEFAULT_STATE.entries, ...(j.entries || {}) },
      aliases: { ...DEFAULT_STATE.aliases, ...(j.aliases || {}) },
      custom: { ...DEFAULT_STATE.custom, ...(j.custom || {}) },
      models: { ...DEFAULT_STATE.models, ...(j.models || {}) },
      prices: { ...DEFAULT_PRICES, ...(j.prices || {}) },
    }
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STATE))
  }
}
function saveState() {
  const bak = STATE_PATH + '.bak'
  if (existsSync(STATE_PATH)) { try { copyFileSync(STATE_PATH, bak) } catch {} }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8')
}

/* ───────────────────────── 播报记账 ───────────────────────── */

let usage = { last: null, lastByProvider: {}, byProvider: {} }
function loadUsage() {
  try {
    const j = JSON.parse(readFileSync(USAGE_PATH, 'utf8'))
    return {
      last: j.last || null,
      lastByProvider: j.lastByProvider || {},
      byProvider: j.byProvider || {},
    }
  } catch { return { last: null, lastByProvider: {}, byProvider: {} } }
}
usage = loadUsage()
function saveUsage() {
  try { writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2), 'utf8') } catch {}
}

/* 中日韩字符按 2 权重（Breeze 官方口径），用于算积分 */
function billableUnits(text) {
  let units = 0
  for (const ch of text) {
    units += /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(ch) ? 2 : 1
  }
  return units
}
const money = (n) => (n >= 0.01 ? '￥' + n.toFixed(2) : '￥' + n.toFixed(4))
const credits = (n) => (Math.round(n * 10) / 10).toString()

function costOf(provider, text) {
  const chars = [...text].length
  const p = (state.prices && state.prices[provider]) || DEFAULT_PRICES[provider] || { per1kUnits: 0, unit: 'char' }
  const unitMode = p.unit || (provider === 'deepseek' || provider === 'breeze' ? 'billing' : 'char')
  const units = unitMode === 'billing' ? billableUnits(text) : chars
  if (provider === 'breeze') {
    const cr = units / 10
    const cny = cr * BZ_CREDIT_CNY
    return { chars, units, credits: cr, amount: cny, costText: '≈' + credits(cr) + ' 积分（' + money(cny) + '）' }
  }
  const amount = (units / 1000) * (p.per1kUnits || 0)
  return { chars, units, amount, costText: '≈' + money(amount) }
}

function recordUsage(entry, provider, voice, text) {
  const c = costOf(provider, text)
  const rec = {
    entry: entry || '',
    provider,
    voice,
    at: Date.now(),
    chars: c.chars,
    units: c.units || null,
    credits: c.credits == null ? null : Math.round(c.credits * 100) / 100,
    amount: c.amount == null ? null : Math.round(c.amount * 10000) / 10000,
    costText: c.costText,
  }
  usage.last = rec
  usage.lastByProvider = { ...(usage.lastByProvider || {}), [provider]: rec }
  const agg = usage.byProvider[provider] || { count: 0, chars: 0, amount: 0, credits: 0 }
  agg.count += 1
  agg.chars += rec.chars
  if (rec.amount) agg.amount = Math.round((agg.amount + rec.amount) * 10000) / 10000
  if (rec.credits) agg.credits = Math.round((agg.credits + rec.credits) * 100) / 100
  usage.byProvider = { ...(usage.byProvider || {}), [provider]: agg }
  saveUsage()
  balCache[provider] = null // 花完钱让余额下次现查
}

/* ───────────────────────── 密钥（不外传） ───────────────────────── */

function readCred(keyName) {
  try {
    const txt = readFileSync(CREDS_PATH, 'utf8')
    const m = txt.match(new RegExp('^\\s*' + keyName + ':\\s*(\\S+)\\s*$', 'm'))
    return m ? m[1].trim() : ''
  } catch { return '' }
}
function writeCred(keyName, value) {
  const txt = readFileSync(CREDS_PATH, 'utf8')
  const re = new RegExp('^(\\s*)' + keyName + ':\\s*\\S+\\s*$', 'm')
  const line = '  ' + keyName + ': ' + value
  let next
  if (re.test(txt)) next = txt.replace(re, line)
  else {
    const i = txt.lastIndexOf('refs:')
    next = i >= 0 ? txt.slice(0, i) + 'refs:\n' + line + txt.slice(i + 5) : txt + '\nrefs:\n' + line + '\n'
  }
  const bak = CREDS_PATH + '.bak-ttsvoice-' + new Date().toISOString().slice(0, 10)
  try { copyFileSync(CREDS_PATH, bak) } catch {}
  writeFileSync(CREDS_PATH, next, 'utf8')
}

let aliKeyCache = { at: 0, key: '' }
function aliyunKey() {
  if (aliKeyCache.key && Date.now() - aliKeyCache.at < 10 * 60 * 1000) return aliKeyCache.key
  try {
    const ps = `Add-Type -AssemblyName System.Security;$b=[IO.File]::ReadAllBytes('${CB_KEYS_DPAPI}');[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))`
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
    if (r.status !== 0) return ''
    const j = JSON.parse(r.stdout.trim())
    const k = String(j?.aliyun?.dashscope || '')
    aliKeyCache = { at: Date.now(), key: k }
    return k
  } catch { return '' }
}

function providerKey(p) {
  if (p === 'deepseek') return readCred('DEEPSEEK_API_KEY')
  if (p === 'volc') return readCred('VOLC_AUDIO_API_KEY')
  if (p === 'aliyun') return aliyunKey()
  if (p === 'breeze') return readCred('BREEZE_API_KEY')
  return ''
}

/* ───────────────────────── 余额查询（带缓存） ───────────────────────── */

const balCache = { deepseek: null, volc: null, aliyun: null, breeze: null }
const BAL_TTL = 5 * 60 * 1000
const CB_TTL = 10 * 60 * 1000
let cbCache = { at: 0, value: null }

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 90000, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); return }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

/* 火山云 / 阿里云账户余额：复用积分板同一条链 apps/cloud-balance/balance.mjs（AK/SK DPAPI） */
async function cloudBalances() {
  if (cbCache.value && Date.now() - cbCache.at < CB_TTL) return cbCache.value
  try {
    const { stdout } = await execFileP(process.execPath, [CB_DIR + '/balance.mjs', '--json'], { cwd: CB_DIR })
    const line = String(stdout).trim().split('\n').pop()
    cbCache = { at: Date.now(), value: JSON.parse(line) }
  } catch (e) {
    cbCache = { at: Date.now(), value: { accounts: { volc: { ok: false, error: 'cloud-balance 调用失败' }, aliyun: { ok: false, error: 'cloud-balance 调用失败' } } } }
  }
  return cbCache.value
}
function fmtCny(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  return '￥' + v.toFixed(2)
}

async function breezeBalance() {
  const out = join(tmpdir(), 'tts-bz-' + process.pid + '-' + Date.now() + '.json')
  try {
    await execFileP('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BZ_DPAPI, '-Mode', 'unprotect', '-In', BZ_TOKEN, '-Out', out])
    const token = JSON.parse(readFileSync(out, 'utf8'))
    if (!token || !token.cookie) throw new Error('Breeze 登录态文件里没有 cookie')
    const r = await fetch('https://breezeblue.ai/api/credits/summary', {
      headers: {
        cookie: token.cookie,
        origin: 'https://breezeblue.ai',
        referer: 'https://breezeblue.ai/app/home',
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(12000),
    })
    const j = await r.json().catch(() => null)
    const d = (j && (j.data || j)) || {}
    if (r.status === 401 || r.status === 403) throw new Error('Breeze 登录态失效（要在 breezeblue.ai 重新登录）')
    if (d.balance == null) throw new Error('Breeze 接口没返回积分')
    return { ok: true, text: credits(Number(d.balance)) + ' 积分' + (d.settlement_pending ? '（结算中 ' + d.settlement_pending + '）' : ''), at: Date.now() }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 120), at: Date.now() }
  } finally {
    try { unlinkSync(out) } catch {}
  }
}

async function deepseekBalance() {
  const key = providerKey('deepseek')
  if (!key) return { ok: false, error: '未配 Key', at: Date.now() }
  try {
    const r = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(12000) })
    const j = await r.json().catch(() => null)
    const infos = (j && j.balance_infos) || []
    if (!infos.length) return { ok: false, error: '接口没返回余额（HTTP ' + r.status + '）', at: Date.now() }
    const text = infos.map((i) => {
      const cur = String(i.currency || '').toUpperCase()
      const sym = cur === 'CNY' ? '￥' : cur === 'USD' ? '$' : cur + ' '
      return sym + String(i.total_balance || '0')
    }).join(' · ')
    return { ok: true, text, at: Date.now() }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 120), at: Date.now() }
  }
}

async function balanceOf(provider, force) {
  const c = balCache[provider]
  if (!force && c && Date.now() - c.at < BAL_TTL) return c
  let v
  if (provider === 'deepseek') v = await deepseekBalance()
  else if (provider === 'breeze') v = await breezeBalance()
  else {
    if (!providerKey(provider)) v = { ok: false, error: '未配 Key', at: Date.now() }
    else {
      const cb = await cloudBalances()
      const a = (cb.accounts || {})[provider]
      v = a && a.ok ? { ok: true, text: fmtCny(a.balance), at: Date.now() } : { ok: false, error: (a && a.error) ? String(a.error).slice(0, 90) : '查不到', at: Date.now() }
    }
  }
  balCache[provider] = v
  return v
}

/* ───────────────────────── 音色目录（静态枚举 + 自定义 + 官网真实音色） ───────────────────────── */

const CATALOG = {
  deepseek: [
    { id: 'stella', name: 'Stella · 女声', group: '官方音色' },
    { id: 'tide', name: 'Tide · 男声', group: '官方音色' },
  ],
  volc: [
    { id: 'zh_female_shuangkuaisisi_uranus_bigtts', name: '爽快思思 2.0', group: '通用·女' },
    { id: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿 2.0', group: '角色扮演' },
    { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', name: '甜美小媛 2.0', group: '通用·女' },
    { id: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0（方言）', group: '通用·女' },
    { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何 2.0', group: '通用·女' },
    { id: 'zh_male_m191_uranus_bigtts', name: '云洲 2.0', group: '通用·男' },
    { id: 'zh_male_taocheng_uranus_bigtts', name: '小田 2.0', group: '通用·男' },
    { id: 'zh_female_kefunvsheng_uranus_bigtts', name: '暖阳女声 2.0', group: '客服' },
    { id: 'zh_male_jieshuoxiaoming_uranus_bigtts', name: '解说小明 2.0', group: '解说' },
    { id: 'en_female_dacey_uranus_bigtts', name: 'Dacey（英语）', group: '多语种' },
    { id: 'en_male_tim_uranus_bigtts', name: 'Tim（英语）', group: '多语种' },
  ],
  /* cosyvoice-v2 专用音色（longxxx_v2）；v3 系要用 _v3/无后缀的新命名，见 ALI_V3_VOICES */
  aliyun: [
    { id: 'longxiaochun_v2', name: '龙小淳 · 知性积极女', group: '通用·女' },
    { id: 'longxiaoxia_v2', name: '龙小夏 · 沉稳权威女', group: '通用·女' },
    { id: 'longwan_v2', name: '小婉 · 女声', group: '通用·女' },
    { id: 'longcheng_v2', name: '小诚 · 男声', group: '通用·男' },
    { id: 'longhua_v2', name: '龙小华 · 元气甜美女', group: '通用·女' },
    { id: 'longshu_v2', name: '小书 · 女声', group: '朗读' },
    { id: 'loongbella_v2', name: 'Bella · 女声', group: '温柔' },
    { id: 'loongstella_v2', name: 'Stella · 女声', group: '温柔' },
    { id: 'longanrou_v2', name: '龙安柔 · 温柔闺蜜女', group: '通用·女' },
    { id: 'longanli', name: '龙安莉 · 利落从容女', group: '语音助手' },
    { id: 'longanlang', name: '龙安朗 · 清爽利落男', group: '语音助手' },
    { id: 'longanwen', name: '龙安温 · 优雅知性女', group: '语音助手' },
    { id: 'longanyun', name: '龙安昀 · 居家暖男', group: '语音助手' },
    { id: 'longdaiyu', name: '龙黛玉 · 娇率才女', group: '短视频配音' },
    { id: 'longbaizhi', name: '龙白芷 · 睿气旁白女', group: '有声书' },
    { id: 'longanqin', name: '龙安亲 · 亲和活泼女', group: '社交陪伴' },
    { id: 'longanshuo', name: '龙安朔 · 干净清爽男', group: '社交陪伴' },
    { id: 'longyingxiao', name: '龙应笑 · 清甜推销女', group: '电话销售' },
  ],
  /* cosyvoice-v3 系专用音色（v2 的 _v2 音色在 v3 上全部 418 报错，命名不同） */
  aliyun_v3: [
    { id: 'longanyang', name: '龙安洋 · 阳光大男孩', group: '社交陪伴' },
    { id: 'longanhuan_v3', name: '龙安欢 V3 · 欢脱元气女（支持多方言）', group: '社交陪伴' },
    { id: 'longanhuan', name: '龙安欢 · 欢脱元气女', group: '社交陪伴' },
    { id: 'longhuhu_v3', name: '龙呼呼 · 天真烂漫女童', group: '童声' },
    { id: 'longpaopao_v3', name: '龙泡泡 · 飞天泡泡音', group: '儿童故事机' },
    { id: 'longjielidou_v3', name: '龙杰力豆 · 阳光顽皮男孩', group: '儿童故事机' },
    { id: 'longxian_v3', name: '龙仙 · 豪放可爱女', group: '儿童故事机' },
    { id: 'longling_v3', name: '龙铃 · 稚气呆板女', group: '儿童故事机' },
    { id: 'longfei_v3', name: '龙飞 · 热血磁性男', group: '诗词朗诵' },
    { id: 'longyingxiao_v3', name: '龙应笑 · 清甜推销女', group: '电话销售' },
    { id: 'longyingxun_v3', name: '龙应询 · 年轻青涩男', group: '客服' },
    { id: 'longyingjing_v3', name: '龙应静 · 低调冷静女', group: '客服' },
    { id: 'longxiaochun_v3', name: '龙小淳 · 知性积极女', group: '语音助手' },
    { id: 'longxiaoxia_v3', name: '龙小夏 · 沉稳权威女', group: '语音助手' },
    { id: 'loongbella_v3', name: 'Bella 3.0 · 精准干练女', group: '新闻播报' },
    { id: 'longwanjun_v3', name: '龙婉君 · 细腻柔声女', group: '有声书' },
    { id: 'longyichen_v3', name: '龙逸尘 · 洒脱活力男', group: '有声书' },
    { id: 'longlaobo_v3', name: '龙老伯 · 沧桑岁月爷', group: '有声书' },
    { id: 'longlaoyi_v3', name: '龙老姨 · 烟火从容阿姨', group: '有声书' },
    { id: 'longshu_v3', name: '龙书 · 沉稳青年男', group: '新闻播报' },
    { id: 'longdaiyu_v3', name: '龙黛玉 · 娇率才女音', group: '短视频配音' },
    { id: 'longanran_v3', name: '龙安燃 · 活泼质感女', group: '直播带货' },
  ],
  breeze: [],
}

const remoteCache = {} // provider → { at, voices, remote }
const REMOTE_TTL = 10 * 60 * 1000

/* 从各家官网拉真实音色（Breeze 有 /v1/voices；火山/阿里官网列表没开放给 API，回提示让主人知道） */
async function fetchRemoteVoices(provider) {
  if (provider === 'breeze') {
    const key = providerKey('breeze')
    if (!key) return { voices: [], remote: { ok: false, error: '还没配 Breeze Key（下面粘贴一次 brz_ 开头的 Key）' } }
    try {
      const res = await fetch('https://api.breeze.blue/v1/voices', {
        headers: { 'xi-api-key': key },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const j = await res.json()
      const arr = j?.voices || j?.data || []
      const voices = arr.map((v) => ({
        id: String(v.voice_id || v.id),
        name: String(v.name || v.voice_id || v.id) + (v.origin === 'designed' ? ' ✨设计' : v.origin === 'cloned' ? ' 🎤复刻' : ''),
        group: '🌐 官网音色',
      })).filter((v) => v.id)
      return { voices, remote: { ok: true, count: voices.length } }
    } catch (e) {
      return { voices: [], remote: { ok: false, error: '拉取失败：' + String((e && e.message) || e).slice(0, 100) } }
    }
  }
  if (provider === 'volc') {
    return { voices: [], remote: { ok: false, error: '火山官网复刻音色只在语音控制台显示，API Key 查不了列表——把音色 ID（S_ 开头）填到下面「手动加音色 ID」即可' } }
  }
  if (provider === 'aliyun') {
    return { voices: [], remote: { ok: false, error: '阿里官网复刻音色只在百炼控制台显示，API 暂无列表接口——把音色 ID 填到下面手动加即可' } }
  }
  return { voices: [], remote: { ok: false, error: 'DeepSeek 只有 stella / tide 两个官方音色' } }
}

async function voicesOf(provider, refresh) {
  /* 阿里按模型给目录：v2 用 _v2 音色，v3/v3.5 用 _v3/新命名（互不通用） */
  const aliModel = (state.models && state.models.aliyun) || 'cosyvoice-v3-flash'
  const catalogKey = provider === 'aliyun' && aliModel !== 'cosyvoice-v2' ? 'aliyun_v3' : provider
  const staticList = CATALOG[catalogKey] || []
  const c = remoteCache[provider]
  if (!refresh && c && Date.now() - c.at < REMOTE_TTL) {
    return { voices: [...staticList, ...c.voices], remote: c.remote }
  }
  const r = await fetchRemoteVoices(provider)
  remoteCache[provider] = { at: Date.now(), voices: r.voices, remote: r.remote }
  return { voices: [...staticList, ...r.voices], remote: r.remote }
}

/* ───────────────────────── 四家合成 ───────────────────────── */

async function synth(provider, voice, text) {
  if (provider === 'deepseek') return synthDeepseek(providerKey('deepseek'), voice, text)
  if (provider === 'volc') return synthVolc(providerKey('volc'), voice, text)
  if (provider === 'aliyun') return synthAliyun(providerKey('aliyun'), voice, text)
  if (provider === 'breeze') return synthBreeze(providerKey('breeze'), voice, text)
  throw new Error('未知来源 ' + provider)
}

async function synthDeepseek(key, voice, text) {
  if (!key) throw new Error('未配置 DEEPSEEK_API_KEY')
  const res = await fetch('https://api.deepseek.com/v1/tools/tts', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice, format: 'wav', filter_markdown: true }),
    signal: AbortSignal.timeout(60000),
  })
  const buf = Buffer.from(await res.arrayBuffer())
  if (!res.ok) throw new Error('DeepSeek HTTP ' + res.status + '：' + buf.toString('utf8').slice(0, 120))
  return { buf, type: 'audio/wav' }
}

async function synthVolc(key, voice, text) {
  if (!key) throw new Error('未配置 VOLC_AUDIO_API_KEY')
  const resourceId = /^S_/.test(voice) ? 'seed-icl-2.0' : 'seed-tts-2.0'
  const res = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse', {
    method: 'POST',
    headers: { 'X-Api-Key': key, 'Content-Type': 'application/json', 'X-Api-Resource-Id': resourceId },
    body: JSON.stringify({
      user: { uid: 'djh-tts-voice' },
      event: 1,
      namespace: 'TTS',
      req_params: {
        text: [...text].slice(0, 3000).join(''),
        speaker: voice,
        audio_params: { format: 'mp3', rate: 24000, bits: 16, channel: 1 },
      },
    }),
    signal: AbortSignal.timeout(60000),
  })
  const raw = Buffer.from(await res.arrayBuffer()).toString('utf8')
  const parts = []
  let err = ''
  for (const line of raw.split('\n')) {
    const m = line.match(/^data:(.*)$/)
    if (!m) continue
    const s = m[1].trim()
    if (!s || s === '[DONE]') continue
    try {
      const j = JSON.parse(s)
      /* 2026-11-19 修：火山 v3 SSE 的音频是 **data 本身就是 base64 字符串**
         （{"code":0,"data":"SUQzBAAAAA..."}），不是 data.audio；而流尾帧是
         {"code":20000000,"message":"OK"} —— 20000000 是「正常结束」不是错误，
         原来把它当 err 打出来，就成了主人看到的「火山无音频：20000000 OK」。 */
      const code = Number(j && j.code)
      if (code && code !== 0 && code < 20000000) err = code + ' ' + String(j.message || '')
      const d = j && j.data
      const b64 = typeof d === 'string' ? d : (d && (d.audio || d.audio_data)) || (j && j.audio) || ''
      if (b64) parts.push(Buffer.from(String(b64), 'base64'))
    } catch {}
  }
  if (!parts.length) throw new Error('火山没返回音频' + (err ? '：' + err : '（多半是这个音色不支持这段文字——比如英文音色念中文；换成「通用·女/男」的中文音色再试）'))
  return { buf: Buffer.concat(parts), type: 'audio/mpeg' }
}

async function synthAliyun(key, voice, text) {
  if (!key) throw new Error('未配置阿里云 DashScope Key（cloud-balance keys.dpapi）')
  const model = voice.includes('#')
    ? 'cosyvoice-clone-v2'
    : ((state.models && state.models.aliyun) || 'cosyvoice-v3-flash')
  const res = await fetch('https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: { text: [...text].slice(0, 2000).join(''), voice, format: 'mp3' } }),
    signal: AbortSignal.timeout(60000),
  })
  const j = await res.json().catch(() => null)
  const url = j?.output?.audio?.url
  if (!res.ok || !url) throw new Error('阿里 HTTP ' + res.status + '：' + JSON.stringify(j).slice(0, 160))
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
  return { buf, type: 'audio/mpeg' }
}

async function synthBreeze(key, voice, text) {
  if (!key) throw new Error('未配置 BREEZE_API_KEY（设置里粘贴一次即可）')
  const res = await fetch('https://api.breeze.blue/v1/text-to-speech/' + encodeURIComponent(voice) + '?output_format=mp3&delivery=sync', {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: [...text].slice(0, 990).join(''), model_id: 'breeze-tts-2', language_code: 'zh' }),
    signal: AbortSignal.timeout(60000),
  })
  const buf = Buffer.from(await res.arrayBuffer())
  if (!res.ok) throw new Error('Breeze HTTP ' + res.status + '：' + buf.toString('utf8').slice(0, 160))
  return { buf, type: 'audio/mpeg' }
}

/* ───────────────────────── 流式合成（2026-11-19 v0.185：主人嫌 TTS 慢） ─────────────────────────
 * 老路径「整段合成完才返回」：47 字一句 Breeze 实测 2.4s 才有声音。
 * 走各家自己的流式端点边合成边吐 mp3 → 实测首声 0.6s（breeze stream）。
 * 返回 true = 已经把音频写进 res（或正在写）；false = 这家没有流式，调用方落回缓冲路径。 */
async function synthStream(provider, voice, text, res) {
  if (provider === 'breeze') {
    const key = providerKey('breeze')
    if (!key) return false
    const r = await fetch(
      'https://api.breeze.blue/v1/text-to-speech/' + encodeURIComponent(voice) + '/stream?output_format=mp3',
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: [...text].slice(0, 990).join(''), model_id: 'breeze-tts-2', language_code: 'zh' }),
        signal: AbortSignal.timeout(90000),
      },
    )
    if (!r.ok || !r.body) {
      try { if (r.body) await r.body.cancel() } catch {}
      return false
    }
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-djh-stream': '1' })
    let wrote = 0
    for await (const chunk of r.body) { res.write(chunk); wrote += chunk.length }
    res.end()
    return wrote > 0
  }
  if (provider === 'volc') {
    const key = providerKey('volc')
    if (!key) return false
    const resourceId = /^S_/.test(voice) ? 'seed-icl-2.0' : 'seed-tts-2.0'
    const r = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse', {
      method: 'POST',
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json', 'X-Api-Resource-Id': resourceId },
      body: JSON.stringify({
        user: { uid: 'djh-tts-voice' }, event: 1, namespace: 'TTS',
        req_params: { text: [...text].slice(0, 3000).join(''), speaker: voice, audio_params: { format: 'mp3', rate: 24000, bits: 16, channel: 1 } },
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!r.ok || !r.body) return false
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-djh-stream': '1' })
    let buf = '', wrote = 0
    for await (const chunk of r.body) {
      buf += chunk.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const m = line.match(/^data:(.*)$/)
        if (!m) continue
        const s = m[1].trim()
        if (!s || s === '[DONE]') continue
        try {
          const j = JSON.parse(s)
          const d = j && j.data
          const b64 = typeof d === 'string' ? d : (d && (d.audio || d.audio_data)) || (j && j.audio) || ''
          if (b64) { const b = Buffer.from(String(b64), 'base64'); res.write(b); wrote += b.length }
        } catch {}
      }
    }
    res.end()
    return wrote > 0
  }
  if (provider === 'aliyun') {
    const key = aliyunKey()
    if (!key) return false
    const model = voice.includes('#') ? 'cosyvoice-clone-v2' : ((state.models && state.models.aliyun) || 'cosyvoice-v3-flash')
    const r = await fetch('https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: { text: [...text].slice(0, 2000).join(''), voice, format: 'mp3' } }),
      signal: AbortSignal.timeout(60000),
    })
    const j = await r.json().catch(() => null)
    const url = j?.output?.audio?.url
    if (!r.ok || !url) return false
    const a = await fetch(url, { signal: AbortSignal.timeout(60000) })
    if (!a.ok || !a.body) return false
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-djh-stream': '1' })
    for await (const chunk of a.body) res.write(chunk)
    res.end()
    return true
  }
  return false
}

/* ───────────────────────── HTTP 公共 ───────────────────────── */

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/* ───────────────────────── 入口 ───────────────────────── */

export function apply(ctx) {
  /* ① Web 路由（网页设置页 + msg-speak 用） */
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        const admission = ctx.connection.admit({ headers: req.headers })
        if ('rejection' in admission) { sendJson(res, admission.rejection, { ok: false, error: 'unauthorized' }); return }
        let p
        try { p = await readBody(req) } catch { sendJson(res, 400, { ok: false, error: 'bad json' }); return }
        try {
          if (p.op === 'state') {
            sendJson(res, 200, {
              ok: true,
              entries: state.entries,
              aliases: state.aliases,
              custom: state.custom,
              models: state.models,
              aliModels: ALI_MODELS,
              prices: state.prices,
              usage,
              keysOk: {
                deepseek: !!providerKey('deepseek'),
                volc: !!providerKey('volc'),
                aliyun: !!providerKey('aliyun'),
                breeze: !!providerKey('breeze'),
              },
            })
          } else if (p.op === 'voices') {
            const provider = String(p.provider)
            if (provider === 'aliyun' && p.model && p.model !== (state.models && state.models.aliyun)) {
              /* 客户端带 model 查询：临时按该模型取目录（不落盘） */
              const bak = state.models.aliyun
              state.models.aliyun = String(p.model)
              const v2 = await voicesOf(provider, !!p.refresh)
              state.models.aliyun = bak
              sendJson(res, 200, { ok: true, voices: v2.voices, remote: v2.remote }); return
            }
            const v = await voicesOf(provider, !!p.refresh)
            sendJson(res, 200, { ok: true, voices: v.voices, remote: v.remote })
          } else if (p.op === 'balances') {
            const only = String(p.provider || '')
            const names = only ? [only] : ['deepseek', 'volc', 'aliyun', 'breeze']
            const out = {}
            await Promise.all(names.map(async (n) => { out[n] = await balanceOf(n) }))
            sendJson(res, 200, { ok: true, providers: out })
          } else if (p.op === 'selection') {
            const e = state.entries[p.entry === 'orb' ? 'orb' : 'chat']
            sendJson(res, 200, { ok: true, ...e, alias: (state.aliases[e.provider] || {})[e.voice] || '' })
          } else if (p.op === 'save') {
            if (p.entries) state.entries = { ...state.entries, ...p.entries }
            if (p.aliases) state.aliases = { ...state.aliases, ...p.aliases }
            if (p.custom) state.custom = { ...state.custom, ...p.custom }
            if (p.models) state.models = { ...state.models, ...p.models }
            saveState()
            sendJson(res, 200, { ok: true })
          } else if (p.op === 'setBreezeKey') {
            const k = String(p.key || '').trim()
            if (!/^brz_/.test(k)) { sendJson(res, 400, { ok: false, error: 'Breeze Key 应以 brz_ 开头' }); return }
            writeCred('BREEZE_API_KEY', k)
            remoteCache.breeze = null
            balCache.breeze = null
            sendJson(res, 200, { ok: true })
          } else if (p.op === 'speak') {
            const provider = String(p.provider || 'deepseek')
            const voice = String(p.voice || '')
            const text = String(p.text || '').trim()
            if (!voice || !text) { sendJson(res, 400, { ok: false, error: 'voice/text 不能为空' }); return }
            const cut = [...text].slice(0, TEXT_MAX).join('')
            const { buf, type } = await synth(provider, voice, cut)
            recordUsage(p.entry === 'orb' ? 'orb' : (p.entry === 'chat' ? 'chat' : ''), provider, voice, cut)
            res.writeHead(200, {
              'content-type': type, 'cache-control': 'no-store', 'content-length': buf.length,
              'x-djh-cost': encodeURIComponent((usage.last && usage.last.costText) || ''),
              'x-djh-chars': String((usage.last && usage.last.chars) || 0),
            })
            res.end(buf)
          } else {
            sendJson(res, 400, { ok: false, error: 'unknown op' })
          }
        } catch (e) {
          sendJson(res, 502, { ok: false, error: (e && e.message) || String(e) })
        }
      },
    }),
  )

  /* ② 本机回环网关（星闪球宿主 djh-cat 的 /tts 转发目标；老 DeepSeek body 兼容）
     v0.186：另加 OpenAI 兼容端点 POST /v1/audio/speech（酒馆 SillyTavern「OpenAI Compatible」TTS 用）
       body: { input, voice, model? } → voice 支持「名字（guagua）/ voc_ id / provider:voice」
       model 前缀选来源（默认 breeze）；返回 mp3 音频 */
  const nameIdCache = { at: 0, map: {} }
  async function resolveBreezeVoice(voice) {
    if (/^voc_/.test(voice)) return voice
    if (Date.now() - nameIdCache.at > 10 * 60 * 1000) {
      try {
        const r = await fetchRemoteVoices('breeze')
        const map = {}
        for (const v of r.voices || []) map[String(v.name).replace(/\s*[✨🎤].*$/, '').trim()] = v.id
        nameIdCache.map = map
        nameIdCache.at = Date.now()
      } catch {}
    }
    return nameIdCache.map[voice] || voice
  }
  /* v0.195：本机回环网关的 CORS 加固——酒馆/浏览器页面直调 9791 时：
     ① application/json 属于非简单请求 → 浏览器先发 OPTIONS 预检，以前没处理直接 404 → 请求被拦
     ② 错误分支（400/502）原来不带 access-control-allow-origin → 页面只看到 CORS 报错，看不到真错误
     所以统一走 sendLocalJson（一律带 CORS 头）+ 顶部处理 OPTIONS 预检。只作用于 9791，不碰 Web 路由。 */
  const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-djh-tts-key', // v0.206：酒馆分段点读带暗号头，缺了预检必挂
    'access-control-max-age': '86400',
  }
  function sendLocalJson (res, status, obj) {
    res.writeHead(status, Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }, CORS_HEADERS))
    res.end(JSON.stringify(obj))
  }
  const local = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/audio/speech')) {
      try {
        const p = await readBody(req)
        const text = String(p.input || '').trim()
        if (!text) { sendLocalJson(res, 400, { error: 'input 为空' }); return }
        let provider = String(p.model || 'breeze').split(':')[0].toLowerCase()
        let voice = String(p.voice || '')
        if (voice.includes(':')) { const [a, b] = voice.split(':'); if (['deepseek', 'volc', 'aliyun', 'breeze'].includes(a.toLowerCase())) { provider = a.toLowerCase(); voice = b } }
        if (!['deepseek', 'volc', 'aliyun', 'breeze'].includes(provider)) provider = 'breeze'
        if (provider === 'breeze') voice = await resolveBreezeVoice(voice)
        const cut = [...text].slice(0, TEXT_MAX).join('')
        const { buf, type } = await synth(provider, voice, cut)
        recordUsage('', provider, voice, cut)
        res.writeHead(200, Object.assign({ 'content-type': type, 'cache-control': 'no-store', 'content-length': buf.length }, CORS_HEADERS))
        res.end(buf)
      } catch (e) {
        sendLocalJson(res, 502, { error: (e && e.message) || String(e) })
      }
      return
    }
    if (req.method !== 'POST' || !req.url.startsWith('/tts')) {
      res.writeHead(404); res.end(); return
    }
    try {
      const p = await readBody(req)
      const text = String(p.text || '').trim()
      if (!text) { sendLocalJson(res, 400, { ok: false, error: 'text 为空' }); return }
      const sel = state.entries.orb
      const cut = [...text].slice(0, TEXT_MAX).join('')
      /* v0.185：body 带 stream:true → 边合成边吐（星闪球页面用 MediaSource 边收边播） */
      if (p.stream) {
        recordUsage('orb', sel.provider, sel.voice, cut)
        if (await synthStream(sel.provider, sel.voice, cut, res)) return
      }
      const { buf, type } = await synth(sel.provider, sel.voice, cut)
      recordUsage('orb', sel.provider, sel.voice, cut)
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': buf.length })
      res.end(buf)
    } catch (e) {
      sendLocalJson(res, 502, { ok: false, error: (e && e.message) || String(e) })
    }
  })
  local.on('error', () => {})
  local.listen(LOCAL_PORT, '0.0.0.0') // v0.203：绑全部网卡，手机局域网点读用（防火墙 9791 仅放行 LocalSubnet）
  ctx.effect(() => () => { try { local.close() } catch {} })
}
