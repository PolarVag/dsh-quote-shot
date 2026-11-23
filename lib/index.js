import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCaptureStore, runCapture, runOcr } from './capture.js'

export const inject = []

const MAX_BODY_BYTES = 64 * 1024
const IMAGE_PREFIX = '/quote-shot/api/image/'
const CAPTURE_PATH = '/quote-shot/api/capture'
const DISCARD_PATH = '/quote-shot/api/discard'
const HEALTH_PATH = '/quote-shot/api/health'
const OCR_TIMEOUT_MS = 800
const MAX_OCR_CANDIDATES = 5

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isValidRect(value) {
  if (!isPlainObject(value)) return false
  return ['x', 'y', 'width', 'height'].every((key) => isFiniteNumber(value[key]))
}

// DSH reports its window rect in CSS/DIP pixels; the capture script reports
// physical screen pixels, so scale before comparing (including at negative
// virtual-screen origins).
function toPhysicalRect(rect, scaleFactor) {
  const scale = isFiniteNumber(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1
  return {
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  }
}

function rectsIntersect(left, right) {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  )
}

function sanitizeOcrCandidates(value) {
  if (!Array.isArray(value)) return []
  const candidates = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const candidate = item.trim()
    if (!candidate || candidates.includes(candidate)) continue
    candidates.push(candidate)
    if (candidates.length >= MAX_OCR_CANDIDATES) break
  }
  return candidates
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(undefined)
    }, timeoutMs)
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    Promise.resolve(promise).then(finish, () => finish(undefined))
  })
}

function removeFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) return
  try {
    unlinkSync(filePath)
  } catch {
    // Missing files are already as good as removed.
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function sendNoContent(res) {
  res.writeHead(204)
  res.end()
}

function sendNotFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not found')
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.length
      if (size > limit) {
        req.resume?.()
        return { ok: false, tooLarge: true }
      }
      chunks.push(buffer)
    }
  } catch {
    return { ok: false, tooLarge: false }
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
}

async function readJson(req) {
  const raw = await readBody(req)
  if (!raw.ok) return { ok: false, tooLarge: raw.tooLarge }
  try {
    return { ok: true, value: JSON.parse(raw.text) }
  } catch {
    return { ok: false, tooLarge: false }
  }
}

function validateContext(body) {
  if (!isPlainObject(body) || !isPlainObject(body.dsh)) return false
  const { dsh } = body
  const rect = dsh.windowRect
  if (!isPlainObject(rect)) return false
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!isFiniteNumber(rect[key])) return false
  }
  if (!isFiniteNumber(dsh.scaleFactor) || dsh.scaleFactor <= 0) return false
  if (dsh.activeFile !== undefined && !isPlainObject(dsh.activeFile)) return false
  if (dsh.chat !== undefined && !isPlainObject(dsh.chat)) return false
  return true
}

export function createApi({ store, capture, logger = console, ocr = runOcr } = {}) {
  if (!store) throw new TypeError('createApi requires a capture store')
  if (typeof capture !== 'function') throw new TypeError('createApi requires a capture function')
  const ocrImpl = typeof ocr === 'function' ? ocr : runOcr

  let busy = false
  const warn = (...args) => {
    try {
      logger?.warn?.(...args)
    } catch {
      // Logging must never break a capture request.
    }
  }

  async function captureHandler(req, res) {
    if (busy) {
      sendJson(res, 409, { action: 'error', message: 'capture already in progress' })
      return
    }
    busy = true
    try {
      const body = await readJson(req)
      if (!body.ok) {
        sendJson(res, 400, {
          action: 'error',
          message: body.tooLarge ? 'request body exceeds 64 KB' : 'invalid JSON body',
        })
        return
      }
      if (!validateContext(body.value)) {
        sendJson(res, 400, { action: 'error', message: 'invalid capture context' })
        return
      }

      let result
      try {
        // Keep the documented { dsh: { ... } } context shape end to end.
        result = await capture(body.value)
      } catch (error) {
        warn('quote-shot: capture failed', error)
        result = { action: 'error', message: 'capture failed' }
      }
      if (!isPlainObject(result)) result = { action: 'error', message: 'capture failed' }
      if (result.action === 'error') {
        warn('quote-shot: capture error', result.message ?? 'capture failed')
      }

      if (result.action === 'ask') {
        if (typeof result.outPath !== 'string' || !result.outPath) {
          sendJson(res, 500, { action: 'error', message: 'capture produced no image' })
          return
        }
        let registered
        try {
          registered = store.register(result.outPath, {
            width: result.width,
            height: result.height,
          })
        } catch (error) {
          warn('quote-shot: could not register capture', error)
          // No token owns the PNG yet, so clean it up before failing.
          removeFile(result.outPath)
          sendJson(res, 500, { action: 'error', message: 'capture produced no image' })
          return
        }
        const payload = { action: 'ask', token: registered.token }
        if (isFiniteNumber(result.width)) payload.width = result.width
        if (isFiniteNumber(result.height)) payload.height = result.height

        // OCR is only useful when the screenshot came from outside DSH. The
        // rect is internal, so a missing/invalid one means "not provably
        // external" and OCR is skipped.
        if (isValidRect(result.rect)) {
          const dshRect = toPhysicalRect(body.value.dsh.windowRect, body.value.dsh.scaleFactor)
          if (!rectsIntersect(result.rect, dshRect)) {
            let candidates = []
            try {
              const textCandidates = await withTimeout(
                ocrImpl({ imagePath: result.outPath }),
                OCR_TIMEOUT_MS,
              )
              candidates = sanitizeOcrCandidates(textCandidates)
            } catch {
              // OCR is best-effort: never fail or delay the capture for it.
            }
            if (candidates.length) payload.ocrCandidates = candidates
          }
        }

        sendJson(res, 200, payload)
        return
      }

      // save/cancel/error own no token, so their temp PNG is always removed.
      removeFile(result.outPath)

      if (result.action === 'save') {
        const payload = { action: 'save' }
        if (typeof result.path === 'string') payload.path = result.path
        sendJson(res, 200, payload)
        return
      }
      if (result.action === 'cancel') {
        sendJson(res, 200, { action: 'cancel' })
        return
      }
      sendJson(res, 200, {
        action: 'error',
        message: typeof result.message === 'string' ? result.message : 'capture failed',
      })
    } finally {
      busy = false
    }
  }

  function imageHandler(req, res, token) {
    const entry = typeof token === 'string' && token ? store.resolve(token) : null
    if (!entry) {
      sendNotFound(res)
      return
    }
    let bytes
    try {
      bytes = readFileSync(entry.path)
    } catch {
      sendNotFound(res)
      return
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'Content-Length': bytes.length,
    })
    res.end(bytes)
  }

  async function discardHandler(req, res) {
    try {
      const body = await readJson(req)
      if (body.ok && isPlainObject(body.value) && typeof body.value.token === 'string') {
        store.discard(body.value.token)
      }
    } catch {
      // discard is best-effort and always answers 204.
    }
    sendNoContent(res)
  }

  function healthHandler(req, res) {
    sendJson(res, 200, { ok: true, platform: 'win32', capture: 'powershell' })
  }

  return {
    capture: captureHandler,
    image: imageHandler,
    discard: discardHandler,
    health: healthHandler,
  }
}

function resolvePowershellPath() {
  const root = process.env.SystemRoot || process.env.windir
  if (root) {
    const candidate = path.join(
      root,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    if (existsSync(candidate)) return candidate
  }
  return 'pwsh.exe'
}

export function apply(ctx) {
  ctx.inject(['webServer'], (scope) => {
    const logger = ctx.logger ?? console
    const warn = (...args) => {
      try {
        logger?.warn?.(...args)
      } catch {
        // Logging is diagnostic only.
      }
    }

    const tempDir = path.join(os.tmpdir(), 'dsh-quote-shot')
    try {
      mkdirSync(tempDir, { recursive: true })
    } catch (error) {
      warn('quote-shot: could not create temp directory', error)
    }

    const store = createCaptureStore({ dir: tempDir })
    try {
      store.sweep()
    } catch (error) {
      warn('quote-shot: temp cleanup failed', error)
    }

    const powershellPath = resolvePowershellPath()
    const scriptPath = fileURLToPath(new URL('../scripts/capture.ps1', import.meta.url))
    const ocrScriptPath = fileURLToPath(new URL('../scripts/ocr.ps1', import.meta.url))
    const api = createApi({
      store,
      logger,
      capture: (context) =>
        runCapture({
          context,
          powershellPath,
          scriptPath,
          tempDir,
          onStderr: (text) => warn('quote-shot: powershell stderr', text),
        }),
      ocr: (args) => runOcr({ ...args, scriptPath: ocrScriptPath, powershellPath }),
    })

    const register = (kind, routePath, handler) => {
      scope.effect(() => scope.webServer.register({ kind, path: routePath, handler }))
    }

    register('exact', CAPTURE_PATH, api.capture)
    register('prefix', IMAGE_PREFIX, (req, res) => {
      const pathOnly = String(req?.url ?? '').split('?')[0]
      let token = ''
      if (pathOnly.startsWith(IMAGE_PREFIX)) {
        try {
          token = decodeURIComponent(pathOnly.slice(IMAGE_PREFIX.length))
        } catch {
          token = ''
        }
      }
      return api.image(req, res, token)
    })
    register('exact', DISCARD_PATH, api.discard)
    register('exact', HEALTH_PATH, api.health)
  })
}
