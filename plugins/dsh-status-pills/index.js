/**
 * 状态胶囊（Host 半）—— 移植自 little DJ 右上角常驻胶囊：
 *
 *   1. 内存已用/总量（本机 os 模块，实时）
 *   2. DeepSeek 余额（GET api.deepseek.com/user/balance）
 *   3. GLM 周额度（GET open.bigmodel.cn/api/monitor/usage/quota/limit，coding plan Key）
 *   4. 进程列表 + 结束进程（面板里按内存排序、两步确认再关）
 *
 * 余额/额度宿主侧 120s 缓存，失败保旧值；进程列表 5s 缓存。
 */
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

export const name = '@local/dsh-status-pills'
export const inject = ['connection', 'credentials', 'webServer']

const ROUTE = '/status-pills-api'
const CACHE_MS = 120 * 1000
const PROCS_CACHE_MS = 5 * 1000
const PROCS_MAX = 60
const execFileP = promisify(execFile)

/** 不许点「关闭」的进程：系统和 DSH 自身全家（含跑命令的 shell）。 */
const PROTECTED_NAMES = new Set(
  [
    'system',
    'idle',
    'registry',
    'memory compression',
    'smss.exe',
    'csrss.exe',
    'wininit.exe',
    'winlogon.exe',
    'services.exe',
    'lsass.exe',
    'lsaiso.exe',
    'fontdrvhost.exe',
    'dwm.exe',
    'svchost.exe',
    'spoolsv.exe',
    'audiodg.exe',
    'node.exe',
    'pwsh.exe',
    'powershell.exe',
    'cmd.exe',
    'conhost.exe',
    'openconsole.exe',
    'windows terminal.exe',
  ],
)

function parseTasklistCsv(text) {
  const rows = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^"([^"]*)","(\d+)","[^"]*","(\d+)","([\d,]+) K"$/)
    if (!m) continue
    rows.push({
      name: m[1],
      pid: Number(m[2]),
      rssMB: Math.round(Number(m[4].replace(/,/g, '')) / 1024),
    })
  }
  return rows
}

async function listProcs(limit) {
  const { stdout } = await execFileP('tasklist', ['/fo', 'csv', '/nh'], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  const all = parseTasklistCsv(stdout)
  all.sort((a, b) => b.rssMB - a.rssMB)
  const top = all.slice(0, limit)
  const selfPid = process.pid
  let sumMB = 0
  for (const p of all) sumMB += p.rssMB
  return {
    procs: top.map((p) => ({
      pid: p.pid,
      name: p.name,
      rssMB: p.rssMB,
      protected: PROTECTED_NAMES.has(p.name.toLowerCase()) || p.pid === selfPid,
    })),
    total: all.length,
    sumMB,
  }
}

function memNow() {
  const total = os.totalmem()
  const avail = os.freemem()
  const mb = (n) => Math.round(n / 1048576)
  return {
    availMB: mb(avail),
    totalMB: mb(total),
    usedMB: mb(total - avail),
  }
}

// ────────────────── RunningHub 每日积分（国内站 runninghub.cn + 海外站 runninghub.ai） ──────────────────
// 读各自 checkin app 的 DPAPI 加密 token，实时查：剩余积分 + 今日是否已领。
// token 由每日任务滚动续期；这里只读不写（绝不 refresh，避免把每日任务手里的
// refresh token 顶掉——那会让定时任务失效）。
const RH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
const RH_SITES = {
  cn: {
    key: 'cn',
    label: '中国站',
    flag: '🇨🇳',
    base: 'https://www.runninghub.cn',
    site: 'https://www.runninghub.cn/',
    token: 'E:/DJH/workspaces/default-workspace/apps/runninghub-checkin/secrets/token.dpapi',
    dpapi: 'E:/DJH/workspaces/default-workspace/apps/runninghub-checkin/lib/dpapi.ps1',
    status: 'E:/DJH/workspaces/default-workspace/apps/runninghub-checkin/status.json',
    claimHint: '登录态失效，需要重新登录一次（打开 runninghub.cn 扫码）',
  },
  intl: {
    key: 'intl',
    label: '海外站',
    flag: '🌍',
    base: 'https://www.runninghub.ai',
    site: 'https://www.runninghub.ai/',
    token: 'E:/DJH/workspaces/default-workspace/apps/runninghub-checkin-intl/secrets/token.dpapi',
    dpapi: 'E:/DJH/workspaces/default-workspace/apps/runninghub-checkin-intl/lib/dpapi.ps1',
    status: 'E:/DJH/workspaces/default-workspace/apps/runninghub-checkin-intl/status.json',
    claimHint: '登录态失效，需要重新用 Google 登录 runninghub.ai 一次',
  },
}

function rhToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

const rhTokenCaches = { cn: { value: null, mtime: 0 }, intl: { value: null, mtime: 0 } }
const rhCaches = { cn: { at: 0, value: null }, intl: { at: 0, value: null } }
const rhClaimAt = { cn: 0, intl: 0 }

async function readSiteToken(cfg, force) {
  const cache = rhTokenCaches[cfg.key]
  const st = statSync(cfg.token)
  if (!force && cache.value && cache.mtime === st.mtimeMs) return cache.value
  const out = join(os.tmpdir(), `rh-ui-${cfg.key}-${process.pid}-${Date.now()}.json`)
  try {
    await execFileP(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cfg.dpapi, '-Mode', 'unprotect', '-In', cfg.token, '-Out', out],
      { windowsHide: true, timeout: 60000 },
    )
    const token = JSON.parse(readFileSync(out, 'utf8'))
    if (!token || !token.access_token) throw new Error('登录态文件里没有 access_token')
    cache.value = token
    cache.mtime = st.mtimeMs
    return token
  } finally {
    try {
      unlinkSync(out)
    } catch {}
  }
}

async function rhPost(cfg, pathname, body, token) {
  const res = await fetch(cfg.base + pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: cfg.base,
      referer: cfg.base + '/',
      'user-agent': RH_UA,
      authorization: 'Bearer ' + token,
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(12000),
  })
  return res.json().catch(() => null)
}

function siteFromStatusFile(cfg, reason) {
  try {
    const s = JSON.parse(readFileSync(cfg.status, 'utf8'))
    const today = rhToday()
    return {
      ok: true,
      siteKey: cfg.key,
      source: 'file',
      stale: s.date !== today,
      date: s.date,
      granted: s.status === 'claimed' || s.status === 'already',
      amount: Number(s.amount) || null,
      balance: s.balance == null ? null : Number(s.balance),
      coin: null,
      updatedAt: s.checkedAt || null,
      note: reason ? '接口取不到：' + reason : '来自上次任务记录',
      site: cfg.site,
    }
  } catch {
    return { ok: false, siteKey: cfg.key, error: reason || '没有可用的 RunningHub 数据', site: cfg.site }
  }
}

async function siteSnapshot(cfg, force) {
  const cache = rhCaches[cfg.key]
  if (!force && cache.at && Date.now() - cache.at < 60 * 1000) return cache.value
  let value
  try {
    let token = await readSiteToken(cfg, false)
    let sum = await rhPost(cfg, '/api/welfare/summary', { issue: false }, token.access_token)
    if (sum && (sum.code === 403 || sum.msg === 'TOKEN_MISSION')) {
      token = await readSiteToken(cfg, true) // 每日任务刚换过 token：重读一次
      sum = await rhPost(cfg, '/api/welfare/summary', { issue: false }, token.access_token)
    }
    if (!sum || sum.code !== 0) throw new Error((sum && sum.msg) || 'summary 失败')
    const gift = (sum.data && sum.data.dailyGift) || {}
    let balance = null
    let coin = null // RH币（新计费里的「过渡币」，站点上还显示着）
    try {
      const p = await rhPost(cfg, '/uc/point/summary', {}, token.access_token)
      const d = (p && p.data) || {}
      const raw = d.balancePoint != null ? d.balancePoint : d.activityPoint
      if (raw != null) balance = Number(raw)
      if (d.transitionCoinRemained != null) coin = Number(d.transitionCoinRemained)
    } catch {}
    value = {
      ok: true,
      siteKey: cfg.key,
      source: 'api',
      granted: !!gift.granted,
      amount: Number(gift.amount) || null,
      balance,
      coin,
      expireTime: gift.expireTime || null,
      date: rhToday(),
      updatedAt: new Date().toISOString(),
      site: cfg.site,
    }
  } catch (e) {
    value = siteFromStatusFile(cfg, String((e && e.message) || e).slice(0, 120))
  }
  cache.at = Date.now()
  cache.value = value
  return value
}

async function siteClaim(cfg) {
  if (Date.now() - rhClaimAt[cfg.key] < 10000) throw new Error('刚点过，请等 10 秒再试')
  rhClaimAt[cfg.key] = Date.now()
  const token = await readSiteToken(cfg, false)
  const r = await rhPost(cfg, '/api/welfare/daily-gift/claim', {}, token.access_token)
  if (r && (r.code === 403 || r.msg === 'TOKEN_MISSION')) {
    throw new Error(cfg.claimHint)
  }
  rhCaches[cfg.key].at = 0
  const snap = await siteSnapshot(cfg, true)
  return { ...snap, claim: r || null }
}

// ────────────────── BreezeBlue（breezeblue.ai）每日 400 免费积分 · 双账号 ──────────────────
// Gmail/Discord 主号 + QQ 邮箱小号，各一份会话 cookie（DPAPI 存 apps/breeze-claim）。
// GET /api/credits/summary + POST /api/credits/daily-claim，cookie 无刷新接口——
// 过期只能人工重登（专用 Chrome profile + grab-cookie.mjs 重导入）。
const BZ_SITES = {
  gmail: {
    key: 'gmail',
    label: 'Gmail',
    base: 'https://breezeblue.ai',
    site: 'https://breezeblue.ai/app/home',
    token: 'E:/DJH/workspaces/default-workspace/apps/breeze-claim/secrets/token.dpapi',
    dpapi: 'E:/DJH/workspaces/default-workspace/apps/breeze-claim/lib/dpapi.ps1',
  },
  qq: {
    key: 'qq',
    label: 'QQ',
    base: 'https://breezeblue.ai',
    site: 'https://breezeblue.ai/app/home',
    token: 'E:/DJH/workspaces/default-workspace/apps/breeze-claim/secrets/token2.dpapi',
    dpapi: 'E:/DJH/workspaces/default-workspace/apps/breeze-claim/lib/dpapi.ps1',
  },
}
const BZ_STATUS = 'E:/DJH/workspaces/default-workspace/apps/breeze-claim/status.json'
const bzTokenCaches = { gmail: { value: null, mtime: 0 }, qq: { value: null, mtime: 0 } }
const bzCaches = { gmail: { at: 0, value: null }, qq: { at: 0, value: null } }
const bzClaimAt = { gmail: 0, qq: 0 }

async function bzCookie(cfg, force) {
  const cache = bzTokenCaches[cfg.key]
  const st = statSync(cfg.token)
  if (!force && cache.value && cache.mtime === st.mtimeMs) return cache.value
  const out = join(os.tmpdir(), `bz-ui-${cfg.key}-${process.pid}-${Date.now()}.json`)
  try {
    await execFileP(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cfg.dpapi, '-Mode', 'unprotect', '-In', cfg.token, '-Out', out],
      { windowsHide: true, timeout: 60000 },
    )
    const token = JSON.parse(readFileSync(out, 'utf8'))
    if (!token || !token.cookie) throw new Error('登录态文件里没有 cookie')
    cache.value = token
    cache.mtime = st.mtimeMs
    return token
  } finally {
    try {
      unlinkSync(out)
    } catch {}
  }
}

async function bzCall(cfg, pathname, method, cookie) {
  const res = await fetch(cfg.base + pathname, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: cfg.base,
      referer: cfg.base + '/app/home',
      'user-agent': RH_UA,
      cookie,
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
    signal: AbortSignal.timeout(12000),
  })
  return { http: res.status, json: await res.json().catch(() => null) }
}

function bzFromStatusFile(cfg, reason) {
  try {
    const s = JSON.parse(readFileSync(BZ_STATUS, 'utf8'))
    const a = (s.accounts && s.accounts[cfg.key]) || null
    if (!a) throw new Error('no data')
    return {
      ok: true,
      source: 'file',
      stale: a.date !== rhToday(),
      date: a.date,
      granted: a.status === 'claimed' || a.status === 'already',
      amount: Number(a.amount) || null,
      balance: a.balance == null ? null : Number(a.balance),
      updatedAt: s.checkedAt || null,
      note: reason ? '接口取不到：' + reason : '来自上次任务记录',
      site: cfg.site,
    }
  } catch {
    return { ok: false, error: reason || `没有可用的 BreezeBlue(${cfg.label}) 数据（还没登录过？）`, site: cfg.site }
  }
}

async function bzSnapshot(cfg, force) {
  const cache = bzCaches[cfg.key]
  if (!force && cache.at && Date.now() - cache.at < 60 * 1000) return cache.value
  let value
  try {
    const token = await bzCookie(cfg, false)
    const r = await bzCall(cfg, '/api/credits/summary', 'GET', token.cookie)
    const d = r.json && (r.json.data || r.json)
    if (r.http === 401 || r.http === 403 || !d) throw new Error('登录态失效（HTTP ' + r.http + '），需要重新登录 breezeblue.ai')
    value = {
      ok: true,
      source: 'api',
      granted: !!(d.daily_claim_claimed_today ?? d.claimed_today ?? d.claimed),
      amount: Number(d.daily_claim_available ?? d.daily_available ?? 400) || null,
      balance: d.balance != null ? Number(d.balance) : null,
      nextReset: d.daily_claim_next_reset_at || null,
      date: rhToday(),
      updatedAt: new Date().toISOString(),
      site: cfg.site,
    }
  } catch (e) {
    value = bzFromStatusFile(cfg, String((e && e.message) || e).slice(0, 120))
  }
  cache.at = Date.now()
  cache.value = value
  return value
}

async function bzClaim(cfg) {
  if (Date.now() - bzClaimAt[cfg.key] < 10000) throw new Error('刚点过，请等 10 秒再试')
  bzClaimAt[cfg.key] = Date.now()
  const token = await bzCookie(cfg, false)
  const r = await bzCall(cfg, '/api/credits/daily-claim', 'POST', token.cookie)
  if (r.http === 401 || r.http === 403) throw new Error('登录态失效，需要重新登录 breezeblue.ai')
  bzCaches[cfg.key].at = 0
  const snap = await bzSnapshot(cfg, true)
  return { ...snap, claim: r.json || null }
}

// ────────────────── 魔搭 ModelScope 每日登录（魔粒） ──────────────────
// 魔搭的每日 200（登录）+50（绑定阿里云）是「登录网页自动发放」，没有领取接口；
// 由 apps/modelscope-daily/claim.mjs（headless 打开魔粒页读数）负责，这里只读它的 status.json。
const MS_DIR = 'E:/DJH/workspaces/default-workspace/apps/modelscope-daily'
const MS_STATUS = MS_DIR + '/status.json'
const MS_CLAIM = MS_DIR + '/claim.mjs'
let msCache = { at: 0, value: null }
let msClaimAt = 0

function msSnapshot(force) {
  if (!force && msCache.at && Date.now() - msCache.at < 60 * 1000) return msCache.value
  let value
  try {
    const s = JSON.parse(readFileSync(MS_STATUS, 'utf8'))
    const today = Array.isArray(s.today) ? s.today : []
    const loginDone = today.some((t) => t.item === '注册并登录' && t.state === '今日已完成')
    const earned = today.reduce((sum, t) => sum + (t.state === '今日已完成' && Number(t.amount) ? Number(t.amount) : 0), 0)
    value = {
      ok: s.ok !== false,
      date: s.date || null,
      stale: s.date !== rhToday(),
      granted: !!loginDone,
      magicube: s.magicube == null ? null : Number(s.magicube),
      earned,
      today,
      updatedAt: s.at || null,
      site: 'https://modelscope.cn/magicube/usage',
      error: s.ok === false ? s.note || '上次登录失败' : null,
    }
  } catch {
    value = { ok: false, error: '还没有魔搭每日登录记录（08:00 任务跑过后才有）', site: 'https://modelscope.cn/magicube/usage' }
  }
  msCache = { at: Date.now(), value }
  return value
}

async function msClaim() {
  if (Date.now() - msClaimAt < 60 * 1000) return msSnapshot(true)
  msClaimAt = Date.now()
  await new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    try {
      const child = spawn('node', [MS_CLAIM, '--json'], { cwd: MS_DIR, windowsHide: true, stdio: 'ignore' })
      child.on('exit', finish)
      child.on('error', finish)
      setTimeout(() => { try { child.kill() } catch {} finish() }, 180000)
    } catch {
      finish()
    }
  })
  return msSnapshot(true)
}

// ────────────────── WorkBuddy（腾讯）签到 ──────────────────
// 复用社区 signin.py（E:\apps\workbuddy-auto-signin）：它负责凭据解密（拉 WorkBuddy
// 自带运行时）+ 幂等签到。这里只 exec 它，10 分钟缓存（解密要起子进程，别频繁）。
const WB_DIR = 'E:/apps/workbuddy-auto-signin'
const WB_SIGNIN = WB_DIR + '/signin.py'
const WB_LOG = WB_DIR + '/signin.log'
// 一次 python 进程同时拿签到状态 + 账户积分余额（凭据解密仍在 signin.py 里）
const WB_STATUS = 'E:/DJH/workspaces/default-workspace/apps/workbuddy-credits/wb-status.py'
let wbCache = { at: 0, value: null }
let wbClaimAt = 0

function wbFromLog(reason) {
  try {
    const lines = readFileSync(WB_LOG, 'utf8').trim().split(/\r?\n/).slice(-30).reverse()
    for (const line of lines) {
      const m = line.match(/\{.*\}\s*$/)
      if (!m) continue
      try {
        const j = JSON.parse(m[0])
        if (j && (j.today_credit != null || j.result)) {
          return {
            ok: true,
            source: 'file',
            stale: j.result === undefined,
            checkedIn: j.result === 'CLAIMED' || j.result === 'ALREADY',
            streak: j.streak_days ?? null,
            totalCredits: j.total_credits ?? null,
            dailyCredit: j.today_credit ?? null,
            active: true,
            updatedAt: null,
            note: reason ? '接口取不到：' + reason : '来自签到日志',
          }
        }
      } catch {}
    }
  } catch {}
  return { ok: false, error: reason || '没有可用的 WorkBuddy 数据' }
}

async function wbRun(mode, timeoutMs) {
  const { stdout } = await execFileP('python', [WB_SIGNIN, mode], {
    cwd: WB_DIR,
    windowsHide: true,
    timeout: timeoutMs || 120000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i]
    if (s.startsWith('{')) {
      try { return JSON.parse(s) } catch {}
    }
  }
  throw new Error('signin.py 没有输出 JSON')
}

function wbNum(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// 账户积分总览：TotalCredits=剩余，CreditGroups 各项 CycleTotalCapacity 之和=累计获得
function wbCreditSummary(cr) {
  if (!cr) return { creditsLeft: null, creditsTotal: null, creditGroups: null }
  const groups = Array.isArray(cr.CreditGroups) ? cr.CreditGroups : []
  let total = null
  if (groups.length) total = groups.reduce((a, g) => a + (wbNum(g.CycleTotalCapacity) || 0), 0)
  else if (Array.isArray(cr.Packages)) total = cr.Packages.reduce((a, p) => a + (wbNum(p.CycleTotalCapacity) || 0), 0)
  return {
    creditsLeft: wbNum(cr.TotalCredits),
    creditsTotal: total,
    creditGroups: groups.map((g) => ({
      kind: g.Kind || '',
      name: g.Name || '',
      total: wbNum(g.CycleTotalCapacity) || 0,
      remain: wbNum(g.CycleRemainCapacity) || 0,
    })),
  }
}

function wbFromCheckin(d, extra) {
  return {
    ok: true,
    source: 'api',
    active: !!d.active,
    checkedIn: !!d.today_checked_in,
    streak: d.streak_days ?? null,
    totalCredits: d.total_credits ?? null,
    dailyCredit: d.daily_credit ?? null,
    streakDay: !!d.is_streak_day,
    season: d.season ?? null,
    endTime: d.end_time || null,
    ...extra,
    updatedAt: new Date().toISOString(),
  }
}

async function wbStatusRun(timeoutMs) {
  const { stdout } = await execFileP('python', [WB_STATUS], {
    cwd: WB_DIR,
    windowsHide: true,
    timeout: timeoutMs || 150000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i]
    if (s.startsWith('{')) {
      try { return JSON.parse(s) } catch {}
    }
  }
  throw new Error('wb-status.py 没有输出 JSON')
}

async function wbSnapshot(force) {
  if (!force && wbCache.at && Date.now() - wbCache.at < 10 * 60 * 1000) return wbCache.value
  let value
  try {
    const out = await wbStatusRun(150000)
    if (out && out.ok === false) throw new Error(out.error || 'wb-status 失败')
    const d = out && out.checkin && out.checkin.data
    if (!d) throw new Error('checkin 无 data')
    value = wbFromCheckin(d, wbCreditSummary(out && out.credits && out.credits.data))
  } catch (e) {
    // 聚合脚本挂了就退回社区 signin.py（只有签到数，没有余额）
    try {
      const out = await wbRun('status', 150000)
      const d = out && out.body && out.body.data
      if (!d) throw new Error((out && out.body && out.body.msg) || 'status 无 data')
      value = wbFromCheckin(d, { note: '余额取不到：' + String((e && e.message) || e).slice(0, 80) })
    } catch {
      value = wbFromLog(String((e && e.message) || e).slice(0, 120))
    }
  }
  wbCache = { at: Date.now(), value }
  return value
}

async function wbClaim() {
  if (Date.now() - wbClaimAt < 30000) throw new Error('刚点过，请等 30 秒再试')
  wbClaimAt = Date.now()
  const out = await wbRun('claim', 240000) // 幂等：已签返回 ALREADY/HTTP 200
  wbCache.at = 0
  const snap = await wbSnapshot(true)
  const credit = out && out.body && out.body.data && out.body.data.credit
  return { ...snap, claimedCredit: credit ?? null }
}



export function apply(ctx) {
  const cache = { at: 0, ds: null, glm: null }
  let inflight = null

  // ── CPU：两次 os.cpus() 采样求差值（本机总使用率） ──
  async function cpuNow() {
    const sample = () => {
      const cpus = os.cpus()
      let user = 0
      let nice = 0
      let sys = 0
      let idle = 0
      let irq = 0
      for (const c of cpus) {
        user += c.times.user
        nice += c.times.nice
        sys += c.times.sys
        idle += c.times.idle
        irq += c.times.irq
      }
      return { total: user + nice + sys + idle + irq, idle, count: cpus.length }
    }
    const a = sample()
    await new Promise((r) => setTimeout(r, 120))
    const b = sample()
    const dTotal = b.total - a.total
    const dIdle = b.idle - a.idle
    const pct = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0
    return { pct: Math.max(0, Math.min(100, pct)), cores: b.count }
  }

  // ── GPU：nvidia-smi（RTX 卡），失败返回 null；3s 缓存 ──
  const gpuCache = { at: 0, value: null }
  async function gpuNow() {
    if (Date.now() - gpuCache.at < 3000) return gpuCache.value
    let value = null
    try {
      const { stdout } = await execFileP(
        'nvidia-smi',
        ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
        { windowsHide: true, timeout: 5000 },
      )
      const line = String(stdout || '').trim().split(/\r?\n/)[0] || ''
      const parts = line.split(',').map((s) => s.trim())
      if (parts.length >= 4 && parts[0]) {
        value = {
          name: parts[0],
          utilPct: Math.max(0, Math.min(100, Number(parts[1]) || 0)),
          memUsedMB: Number(parts[2]) || 0,
          memTotalMB: Number(parts[3]) || 0,
        }
      }
    } catch {
      value = null
    }
    gpuCache.at = Date.now()
    gpuCache.value = value
    return value
  }

  async function resolveKey(ref) {
    try {
      const resolved = await ctx.credentials.resolve(ref)
      return resolved && resolved.value ? resolved.value : ''
    } catch {
      return ''
    }
  }

  async function fetchDs() {
    const key = await resolveKey('DEEPSEEK_API_KEY')
    if (!key) return { ok: false, error: '缺少 DEEPSEEK_API_KEY' }
    try {
      const res = await fetch('https://api.deepseek.com/user/balance', {
        headers: { authorization: 'Bearer ' + key },
      })
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'DeepSeek Key 无效（HTTP ' + res.status + '）' }
      }
      if (!res.ok) return { ok: false, error: 'DeepSeek 接口返回 HTTP ' + res.status }
      const body = await res.json()
      const infos = (body && body.balance_infos) || []
      if (!infos.length) return { ok: false, error: 'DeepSeek 接口没返回余额' }
      const info = infos[0]
      const cur = String(info.currency || '').toUpperCase()
      const symbol = cur === 'CNY' ? '￥' : cur === 'USD' ? '$' : cur + ' '
      return {
        ok: true,
        text: symbol + String(info.total_balance || '0'),
        currency: cur,
        amount: Number(info.total_balance) || 0,
      }
    } catch (e) {
      return { ok: false, error: 'DeepSeek 查询失败：' + String((e && e.message) || e).slice(0, 120) }
    }
  }

  async function fetchGlm() {
    const key = await resolveKey('ZAI_CODING_CN_API_KEY')
    if (!key) return { ok: false, error: '缺少 ZAI_CODING_CN_API_KEY' }
    try {
      const res = await fetch('https://open.bigmodel.cn/api/monitor/usage/quota/limit', {
        headers: { authorization: key },
      })
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'GLM Key 无效（HTTP ' + res.status + '）' }
      }
      if (!res.ok) return { ok: false, error: 'GLM 接口返回 HTTP ' + res.status }
      const body = await res.json()
      const root = (body && (body.data || body)) || {}
      const limits = Array.isArray(root.limits) ? root.limits : []
      // little DJ 同一口径：unit 3 = 5 小时档；unit 6 = 一周档（percentage 为「已用」）
      const five = limits.find((l) => l && Number(l.unit) === 3) || null
      const week = limits.find((l) => l && Number(l.unit) === 6) || null
      if (!five && !week) return { ok: false, error: 'GLM 接口没返回额度' }
      const pick = (l) =>
        l && l.percentage != null
          ? {
              percentage: Number(l.percentage),
              used: Number(l.currentValue) || 0,
              total: Number(l.usage) || 0,
              resetAt: l.nextResetTime ? Number(l.nextResetTime) : 0,
            }
          : null
      return { ok: true, fiveHour: pick(five), week: pick(week) }
    } catch (e) {
      return { ok: false, error: 'GLM 查询失败：' + String((e && e.message) || e).slice(0, 120) }
    }
  }

  // ────────────────── OpenRouter 余额查询 ──────────────────
  // GET https://openrouter.ai/api/v1/key → limit_remaining（USD 余额）
  async function fetchOpenRouter() {
    const key = await resolveKey('OPENROUTER_API_KEY')
    if (!key) return { ok: false, error: '缺少 OPENROUTER_API_KEY' }
    try {
      const res = await fetch('https://openrouter.ai/api/v1/key', {
        headers: { authorization: 'Bearer ' + key },
      })
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'OpenRouter Key 无效（HTTP ' + res.status + '）' }
      }
      if (!res.ok) return { ok: false, error: 'OpenRouter 接口返回 HTTP ' + res.status }
      const body = await res.json()
      const data = body && body.data
      if (!data) return { ok: false, error: 'OpenRouter 接口没返回数据' }
      const remaining = typeof data.limit_remaining === 'number' ? data.limit_remaining : null
      const usage = typeof data.usage === 'number' ? data.usage : null
      return {
        ok: true,
        text: '$' + (remaining != null ? remaining.toFixed(2) : '—'),
        currency: 'USD',
        amount: remaining,
        usage: usage,
      }
    } catch (e) {
      return { ok: false, error: 'OpenRouter 查询失败：' + String((e && e.message) || e).slice(0, 120) }
    }
  }

  // OpenRouter 余额缓存：60s TTL，失败保旧值（口径与 ds/glm 一致）
  const OR_CACHE_MS = 60 * 1000
  const orCache = { at: 0, value: null }
  let orInflight = null
  async function fetchOrRefresh(force) {
    if (!force && orCache.value && Date.now() - orCache.at < OR_CACHE_MS) return orCache.value
    if (orInflight) return orInflight
    orInflight = (async () => {
      const or = await fetchOpenRouter()
      orCache.at = Date.now()
      // 失败保旧值：有旧成功值就沿用，没有才把错误留给前端显示「—」
      orCache.value = or.ok ? or : orCache.value || or
      return orCache.value
    })().finally(() => {
      orInflight = null
    })
    return orInflight
  }

  async function refresh() {
    const [ds, glm] = await Promise.all([fetchDs(), fetchGlm()])
    // 失败保旧值：有旧成功值就沿用，没有才把错误留给前端显示「—」
    cache.at = Date.now()
    cache.ds = ds.ok ? ds : cache.ds || ds
    cache.glm = glm.ok ? glm : cache.glm || glm
  }

  async function snapshot() {
    // 云余额：首次（或过期）在后台拉，不阻塞 state（脚本要起 node 子进程+4 家 API，约 3-8s）
    if (!cloudCache.value) void cloudSnapshot(false).catch(() => {})
    // OpenRouter 余额：60s TTL 由 fetchOrRefresh 内部判断，失败保旧值
    void fetchOrRefresh()
    if (!cache.ds || !cache.glm || Date.now() - cache.at >= CACHE_MS) {
      if (!inflight) {
        inflight = refresh()
          .catch(() => {})
          .finally(() => {
            inflight = null
          })
      }
      await inflight
    }
    const [cpu, gpu] = await Promise.all([cpuNow(), gpuNow()])
    return {
      mem: memNow(),
      cpu,
      gpu,
      ds: cache.ds || { ok: false, error: '尚未取到余额' },
      glm: cache.glm || { ok: false, error: '尚未取到额度' },
      cloud: cloudCache.value || undefined,
      or: orCache.value || undefined,
    }
  }

  // ── 进程面板：5s 缓存，避免面板开着时重复起 tasklist ──
  const procsCache = { at: 0, value: null }
  async function procsSnapshot(force) {
    if (!force && procsCache.value && Date.now() - procsCache.at < PROCS_CACHE_MS) return procsCache.value
    const value = await listProcs(PROCS_MAX)
    procsCache.at = Date.now()
    procsCache.value = value
    return value
  }

  // ── 四家云余额（火山/腾讯/阿里/华为，2026-11-18 主人给了 AK/SK）：apps/cloud-balance，10min 缓存 ──
  // 密钥 DPAPI 加密在 apps/cloud-balance/secrets/keys.dpapi（不入 git），balance.mjs 内部解密后调各家 OpenAPI。
  const CLOUD_DIR = 'E:/DJH/workspaces/default-workspace/apps/cloud-balance'
  const cloudCache = { at: 0, value: null }
  async function cloudSnapshot(force) {
    if (!force && cloudCache.value && Date.now() - cloudCache.at < 10 * 60 * 1000) return cloudCache.value
    const { stdout } = await execFileP(process.execPath, [CLOUD_DIR + '/balance.mjs', '--json'], {
      windowsHide: true,
      timeout: 90 * 1000,
      cwd: CLOUD_DIR,
    })
    const value = JSON.parse(String(stdout).trim().split('\n').pop())
    cloudCache.at = Date.now()
    cloudCache.value = value
    return value
  }

  async function killProc(pid) {
    const id = Number(pid)
    if (!Number.isInteger(id) || id <= 0) throw new Error('无效的 PID')
    // 强制刷新全量列表再校验：防 PID 复用误杀，也防前端拿到过期数据
    const current = await listProcs(100000)
    const target = current.procs.find((p) => p.pid === id)
    if (!target) throw new Error('进程不在了（可能已经退出）')
    if (target.protected) throw new Error('该进程受保护，不允许关闭')
    await execFileP('taskkill', ['/PID', String(id), '/T', '/F'], { windowsHide: true })
    procsCache.at = 0
    return { pid: id, name: target.name }
  }

  // ── 积分板快照落盘（2026-11-19：给小 DJ 积分板供数）──
  // 每 5 分钟聚合一次四家签到 + 云/DS/GLM 余额，写 $DSH_HOME/score-snapshot.json；
  // Windows 任务 DJH-Score-Sync 把它推到小 DJ 设备，小 DJ UI 只读显示。
  const SCORE_FILE = join(process.env.DSH_HOME || join(os.homedir(), '.dsh'), 'score-snapshot.json')
  async function scoreSnapshot() {
    const safe = (p) => p.catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
    const [base, cn, intl, wb, bz] = await Promise.all([
      snapshot(),
      safe(siteSnapshot(RH_SITES.cn, false)),
      safe(siteSnapshot(RH_SITES.intl, false)),
      safe(wbSnapshot(false)),
      safe(bzSnapshot(BZ_SITES.gmail, false)),
    ])
    return { at: Date.now(), ds: base.ds, glm: base.glm, cloud: base.cloud || null, cn, intl, wb, bz }
  }
  async function writeScoreFile() {
    try {
      writeFileSync(SCORE_FILE, JSON.stringify(await scoreSnapshot()))
    } catch {}
  }
  ctx.effect(() => {
    const timer = setInterval(writeScoreFile, 5 * 60 * 1000)
    void writeScoreFile()
    return () => clearInterval(timer)
  })

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
            if (size > 64 * 1024) throw new Error('请求体过大')
            chunks.push(chunk)
          }
          const raw = Buffer.concat(chunks).toString('utf8')
          if (raw) payload = JSON.parse(raw)
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: { code: 'bad-body', message: '请求体不是合法 JSON' } }))
          return
        }
        let value
        try {
          if (endpoint === 'state') value = await snapshot()
          else if (endpoint === 'procs') value = await procsSnapshot(false)
          else if (endpoint === 'kill') value = await killProc(payload && payload.pid)
          else if (endpoint === 'rh') value = await siteSnapshot(RH_SITES.cn, !!(payload && payload.force))
          else if (endpoint === 'rh-intl') value = await siteSnapshot(RH_SITES.intl, !!(payload && payload.force))
          else if (endpoint === 'rh-claim') value = await siteClaim(RH_SITES.cn)
          else if (endpoint === 'rh-intl-claim') value = await siteClaim(RH_SITES.intl)
          else if (endpoint === 'wb') value = await wbSnapshot(!!(payload && payload.force))
          else if (endpoint === 'wb-claim') value = await wbClaim()
          else if (endpoint === 'breeze') value = await bzSnapshot(BZ_SITES[(payload && payload.account) === 'qq' ? 'qq' : 'gmail'], !!(payload && payload.force))
          else if (endpoint === 'breeze-claim') value = await bzClaim(BZ_SITES[(payload && payload.account) === 'qq' ? 'qq' : 'gmail'])
          else if (endpoint === 'cloud') value = await cloudSnapshot(!!(payload && payload.force))
          else if (endpoint === 'ms') value = await msSnapshot(!!(payload && payload.force))
          else if (endpoint === 'ms-claim') value = await msClaim()
          else throw new Error('未知接口：' + String(endpoint))
        } catch (e) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String((e && e.message) || e) } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, value }))
      },
    }),
  )
}
