/**
 * dsh-msg-speak（Host 半）—— DeepSeek TTS 语音播报代理。
 *
 * POST /dsh-tts-api  body { text, voice }
 *   voice: 'stella'(女,默认) | 'tide'(男)；text ≤ 10000 字（官方上限，这里截 9500）。
 * 成功：200 audio/wav（官方 /v1/tools/tts 全文模式，filter_markdown=true）。
 * 失败：JSON { ok:false, error }。
 *
 * Key 链：E:/DJH/home/.credentials.yaml 的 DEEPSEEK_API_KEY（每次请求现读，改 key 即生效；
 * Key 永不出宿主，浏览器只拿到音频）。协议抄小 DJ task308/347（server/proxy.js dsTts）。
 */
import { readFileSync } from 'node:fs'

export const name = '@local/dsh-msg-speak'
export const inject = ['connection', 'webServer']

const ROUTE = '/dsh-tts-api'
const CREDS_PATH = 'E:/DJH/home/.credentials.yaml'
const DS_TTS_ENDPOINT = 'https://api.deepseek.com/v1/tools/tts'
const TEXT_MAX = 9500
const VOICES = new Set(['stella', 'tide'])

function readDeepSeekKey() {
  try {
    const txt = readFileSync(CREDS_PATH, 'utf8')
    const m = txt.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

async function dsTts(key, text, voice) {
  const body = JSON.stringify({ text, voice_id: voice, format: 'wav', filter_markdown: true })
  const res = await fetch(DS_TTS_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(30000),
  })
  const buf = Buffer.from(await res.arrayBuffer())
  if (!res.ok) {
    let msg = ''
    try {
      const j = JSON.parse(buf.toString('utf8'))
      msg = String((j && (j.error?.message || j.error || j.message)) || '')
    } catch {
      msg = buf.toString('utf8').slice(0, 120)
    }
    throw new Error('DeepSeek TTS HTTP ' + res.status + (msg ? '：' + msg : ''))
  }
  return buf
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        const admission = ctx.connection.admit({ headers: req.headers })
        if ('rejection' in admission) {
          sendJson(res, admission.rejection, { ok: false, error: 'unauthorized' })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'POST only' })
          return
        }
        let payload = null
        try {
          const chunks = []
          for await (const c of req) chunks.push(c)
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        let text = String((payload && payload.text) || '').trim()
        const voice = String((payload && payload.voice) || 'stella')
        if (!text) {
          sendJson(res, 400, { ok: false, error: 'text 不能为空' })
          return
        }
        if (!VOICES.has(voice)) {
          sendJson(res, 400, { ok: false, error: 'voice 只支持 stella / tide' })
          return
        }
        if (text.length > TEXT_MAX) text = text.slice(0, TEXT_MAX)
        const key = readDeepSeekKey()
        if (!key) {
          sendJson(res, 500, { ok: false, error: '未配置 DEEPSEEK_API_KEY（E:/DJH/home/.credentials.yaml）' })
          return
        }
        try {
          const wav = await dsTts(key, text, voice)
          res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store', 'content-length': wav.length })
          res.end(wav)
        } catch (e) {
          sendJson(res, 502, { ok: false, error: (e && e.message) || String(e) })
        }
      },
    }),
  )
}
