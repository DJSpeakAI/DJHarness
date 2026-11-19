/**
 * 截图标注（Host 半）—— 三个动作：
 *   capture : 调 PowerShell 抓整屏（DPI 感知=物理分辨率，所有显示器）→ 返回 dataURL + 尺寸
 *   save    : 把标注后的 PNG 写进 E:\DJH\Pictures\DJH截图\ → 返回完整路径
 *   copy    : 把 PNG 放进 Windows 剪贴板（host 侧，Ctrl+V 直接可粘）
 */
import { execFile } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = '@local/dsh-screenshot'
export const inject = ['connection', 'webServer']

const ROUTE = '/djh-screenshot-api'
const SAVE_DIR = 'E:/DJH/Pictures/DJH截图'
const HERE = dirname(fileURLToPath(import.meta.url))

function runCapture() {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'capture.ps1')],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => {
        if (err) return reject(err)
        const line = String(stdout || '').trim().split(/\r?\n/).pop() || ''
        const [png, size] = line.split('|')
        if (!png || !png.endsWith('.png')) return reject(new Error('capture failed'))
        try {
          const buf = readFileSync(png)
          try { unlinkSync(png) } catch {}
          resolve({ dataUrl: 'data:image/png;base64,' + buf.toString('base64'), size: size || '' })
        } catch (e) {
          reject(e)
        }
      },
    )
  })
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function stamp() {
  const now = new Date()
  return (
    now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
    '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
  )
}

function writePng(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''))
  if (!m) throw new Error('只接受 PNG dataURL')
  mkdirSync(SAVE_DIR, { recursive: true })
  const path = join(SAVE_DIR, '截图' + stamp() + '.png')
  writeFileSync(path, Buffer.from(m[1], 'base64'))
  return path
}

function copyToClipboard(path) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', join(HERE, 'clipboard.ps1'), '-Path', path],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        if (err) return reject(new Error('剪贴板写入失败: ' + String((err && err.message) || err)))
        resolve(String(stdout || '').trim() === 'ok')
      },
    )
  })
}

export function apply(ctx) {
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
        const chunks = []
        for await (const c of req) chunks.push(c)
        let body = {}
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch {}
        try {
          if (body.action === 'capture') {
            const value = await runCapture()
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, value }))
          } else if (body.action === 'save') {
            const path = writePng(body.dataUrl)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, value: { path } }))
          } else if (body.action === 'copy') {
            /* 直接复制：写临时 PNG → 塞剪贴板 → 删临时文件 */
            const tmp = join(tmpdir(), 'djh-shot-copy-' + Date.now() + '.png')
            const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''))
            if (!m) throw new Error('只接受 PNG dataURL')
            writeFileSync(tmp, Buffer.from(m[1], 'base64'))
            try {
              await copyToClipboard(tmp)
            } finally {
              try { unlinkSync(tmp) } catch {}
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, value: { copied: true } }))
          } else {
            throw new Error('unknown action')
          }
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
        }
      },
    }),
  )
}
