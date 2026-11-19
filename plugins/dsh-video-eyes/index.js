/**
 * dsh-video-eyes（Host 半）—— AI 的眼睛耳朵：录屏视频 → 关键帧 + 语音稿
 *
 *   POST /video-eyes-api/process   原始视频二进制（mp4/webm…，≤400MB）
 *     ① ffmpeg 抽音频 → 16k 单声道 WAV → 按 ≤110s 分段 → DeepSeek ASR 转写
 *     ② ffmpeg 每 0.5s 抽帧 → 16x9 灰度签名做变化去重 → 保留关键帧 JPG（宽 1440）
 *   返回 { ok, durationSec, transcript, frames:[{t, url}] }
 *   GET  /video-eyes-api/frame/<job>/<文件名>  取关键帧图片
 *
 * 工作目录 E:\DJH\home\storage\video-eyes\<job>\，处理完 10 分钟后自动清理。
 * ffmpeg 在 E:\DJH\bin\ffmpeg\ffmpeg-*-gpl\bin\ffmpeg.exe。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

export const name = '@local/dsh-video-eyes'
export const inject = ['connection', 'credentials', 'webServer', 'timer']

const ROUTE = '/video-eyes-api'
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(HOME, 'storage', 'video-eyes')
const MAX_UPLOAD = 400 * 1024 * 1024
const MAX_FRAMES = 40
const FRAME_INTERVAL = 0.5 // 秒/帧
const SIG_W = 16
const SIG_H = 9
const SIG_DIFF_KEEP = 18 // 相邻签名平均差 ≥ 此值视为画面变化（0-255）

function findFfmpeg() {
  const roots = [path.join('E:', 'DJH', 'bin', 'ffmpeg'), path.join(HOME, '..', 'bin', 'ffmpeg')]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const hit = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name))
        else if (e.name === 'ffmpeg.exe') hit.push(path.join(d, e.name))
      }
    }
    walk(root)
    if (hit.length) return hit[0]
  }
  return 'ffmpeg'
}

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true, ...opts })
    let err = ''
    p.stderr.on('data', (c) => {
      err += c
      if (err.length > 20000) err = err.slice(-20000)
    })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} 退出码 ${code}: ${err.slice(-800)}`))))
  })
}

function runOut(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true })
    const out = []
    let err = ''
    p.stdout.on('data', (c) => out.push(c))
    p.stderr.on('data', (c) => {
      err += c
      if (err.length > 20000) err = err.slice(-20000)
    })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${path.basename(bin)} 退出码 ${code}: ${err.slice(-800)}`))))
  })
}

async function probeDuration(ffprobeDir, file) {
  // ffprobe 与 ffmpeg 同目录；没有就用 ffmpeg 日志兜底（-t 由调用方钳制）
  try {
    const bin = path.join(ffprobeDir, 'ffprobe.exe')
    const out = await runOut(fs.existsSync(bin) ? bin : 'ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ])
    return parseFloat(out.toString().trim()) || 0
  } catch {
    return 0
  }
}

async function deepseekAsr(wavFile, apiKey) {
  const fd = new FormData()
  fd.append('file', new Blob([await fs.promises.readFile(wavFile)], { type: 'audio/wav' }), 'audio.wav')
  const res = await fetch('https://api.deepseek.com/v1/tools/asr', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: fd,
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`DeepSeek ASR ${res.status}: ${JSON.stringify(j).slice(0, 300)}`)
  return String(j.text || '')
}

/** 变化帧检测：返回要保留的时间点数组（秒）。 */
function pickFrames(sigBuf, frameCount, durationSec) {
  const sigLen = SIG_W * SIG_H
  const keep = [0]
  for (let i = 1; i < frameCount; i++) {
    const a = sigBuf.subarray((i - 1) * sigLen, i * sigLen)
    const b = sigBuf.subarray(i * sigLen, (i + 1) * sigLen)
    let diff = 0
    for (let k = 0; k < sigLen; k++) diff += Math.abs(a[k] - b[k])
    if (diff / sigLen >= SIG_DIFF_KEEP) keep.push(i * FRAME_INTERVAL)
  }
  if (keep.length > MAX_FRAMES) {
    // 变化太多（比如全程都在动）→ 均匀抽 MAX_FRAMES 个
    const step = (keep.length - 1) / (MAX_FRAMES - 1)
    return Array.from({ length: MAX_FRAMES }, (_, i) => keep[Math.round(i * step)])
  }
  // 最后一帧也带上（结尾状态往往是结论）
  if (durationSec > 0) {
    const last = Math.max(0, durationSec - 0.3)
    if (keep[keep.length - 1] < last - 1) keep.push(last)
  }
  return keep
}

async function processVideo(file, apiKey, ffmpegBin) {
  const ffmpegDir = path.dirname(ffmpegBin)
  const durationSec = await probeDuration(ffmpegDir, file)
  const capDur = durationSec > 0 ? Math.min(durationSec, 1800) : 1800

  // ── ① 音频 → WAV → ASR（无音轨时 ffmpeg 会失败，捕获后跳过）
  let transcript = ''
  let wavFull = file.replace(/\.mp4$/i, '') + '.full.wav'
  let hasAudio = true
  try {
    await run(ffmpegBin, ['-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-t', String(capDur), wavFull])
  } catch {
    hasAudio = false
  }
  // ── 响度归一（学 ffmpeg-skill）：音量忽大忽小先拉平再喂 ASR，提转写准确率
  if (hasAudio) {
    const wavNorm = file.replace(/\.mp4$/i, '') + '.norm.wav'
    try {
      await run(ffmpegBin, ['-y', '-i', wavFull, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '16000', '-c:a', 'pcm_s16le', wavNorm])
      fs.unlinkSync(wavFull)
      wavFull = wavNorm
    } catch { /* 归一失败就用原音 */ }
  }
  if (hasAudio) {
    const chunks = []
    const SEG = 110
    for (let t = 0; t < capDur; t += SEG) {
      const seg = `${wavFull}.${Math.floor(t / SEG)}.wav`
      const rest = capDur - t
      try {
        await run(ffmpegBin, ['-y', '-ss', String(t), '-i', wavFull, '-t', String(Math.min(SEG, rest)), '-c', 'copy', seg])
        const text = await deepseekAsr(seg, apiKey)
        if (text) chunks.push(text.trim())
      } catch (e) {
        chunks.push(`[第 ${Math.floor(t / 60)} 分钟段转写失败：${String(e.message || e).slice(0, 120)}]`)
      }
    }
    transcript = chunks.join('')
  }

  // ── ② 签名（16x9 灰度 @2fps）→ 变化去重 → 关键帧 JPG
  const sig = await runOut(ffmpegBin, [
    '-v', 'error', '-i', file, '-t', String(capDur),
    '-vf', `fps=2,scale=${SIG_W}:${SIG_H},format=gray`,
    '-f', 'rawvideo', '-',
  ])
  const frameCount = Math.floor(sig.length / (SIG_W * SIG_H))
  let keeps = frameCount > 0 ? pickFrames(sig, frameCount, durationSec) : [0]
  if (!keeps.length) keeps = [0]

  const frames = []
  for (let i = 0; i < keeps.length; i++) {
    const t = keeps[i]
    const name = `frame_${String(i + 1).padStart(2, '0')}_${t.toFixed(1)}s.jpg`
    const out = path.join(path.dirname(file), name)
    try {
      await run(ffmpegBin, ['-y', '-ss', String(Math.max(0, t - 0.25)), '-i', file, '-frames:v', '1',
        '-vf', "scale='min(1440,iw)':-2", '-q:v', '5', out])
      frames.push({ t, name })
    } catch {
      /* 单帧失败跳过 */
    }
  }
  try { fs.unlinkSync(wavFull) } catch {}
  for (let t = 0; t < capDur; t += 110) { try { fs.unlinkSync(`${wavFull}.${Math.floor(t / 110)}.wav`) } catch {} }
  return { durationSec, transcript, frames }
}

export function apply(ctx) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const jobs = new Map() // job -> {dir, expireTimer}

  const ffmpegBin = findFfmpeg()
  let ffmpegOk = null
  const ensureFfmpeg = async () => {
    if (ffmpegOk !== null) return ffmpegOk
    try {
      await run(ffmpegBin, ['-version'])
      ffmpegOk = true
    } catch {
      ffmpegOk = false
    }
    return ffmpegOk
  }

  const cleanJob = (job) => {
    const j = jobs.get(job)
    if (!j) return
    jobs.delete(job)
    try { fs.rmSync(j.dir, { recursive: true, force: true }) } catch {}
  }
  const scheduleCleanup = (job) => {
    const j = jobs.get(job)
    if (!j) return
    if (j.expireTimer) j.expireTimer()
    j.expireTimer = ctx.timer.timeout(() => cleanJob(job), 10 * 60 * 1000)
  }

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
      const url = new URL(req.url || '/', 'http://localhost')
      const sub = url.pathname.slice(ROUTE.length + 1)

      // GET 帧：/frame/<job>/<name>
      if (req.method === 'GET' && sub.startsWith('frame/')) {
        const [, job, name] = sub.split('/')
        const j = jobs.get(job)
        if (!j || !/^[\w.\-]+\.jpg$/.test(name || '')) {
          res.writeHead(404); res.end('not found'); return
        }
        const p = path.join(j.dir, name)
        if (!fs.existsSync(p)) { res.writeHead(404); res.end('not found'); return }
        scheduleCleanup(job)
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
        fs.createReadStream(p).pipe(res)
        return
      }

      // GET ping
      if (req.method === 'GET' && sub === 'ping') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, ffmpeg: await ensureFfmpeg(), bin: ffmpegBin }))
        return
      }

      if (req.method !== 'POST' || sub !== 'process') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }); res.end('method not allowed'); return
      }

      // POST 原始视频
      if (!(await ensureFfmpeg())) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: `找不到可用的 ffmpeg（找了 E:\\DJH\\bin\\ffmpeg，PATH 也试过）：${ffmpegBin}` }))
        return
      }
      let apiKey = ''
      try {
        const r = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
        apiKey = (r && r.value) || ''
      } catch {}
      if (!apiKey) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: '没有 DEEPSEEK_API_KEY（语音转写需要）；关键帧功能不受影响，但请先在模型中心配 Key' }))
        return
      }

      const job = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      const dir = path.join(DATA_DIR, job)
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'input.mp4')
      try {
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > MAX_UPLOAD) throw new Error('视频超过 400MB 上限')
          chunks.push(chunk)
        }
        fs.writeFileSync(file, Buffer.concat(chunks))
        const { durationSec, transcript, frames } = await processVideo(file, apiKey, ffmpegBin)
        fs.unlinkSync(file)
        jobs.set(job, { dir })
        scheduleCleanup(job)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({
          ok: true, job, durationSec,
          transcript,
          frames: frames.map((f) => ({ t: f.t, url: `${ROUTE}/frame/${job}/${f.name}` })),
        }))
      } catch (e) {
        cleanJob(job)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e).slice(0, 500) }))
      }
    },
  })
}
