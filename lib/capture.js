import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

const DEFAULT_TTL_MS = 3_600_000
const DEFAULT_CAPTURE_TIMEOUT_MS = 120000

function isInside(dir, filePath) {
  const rel = relative(dir, filePath)
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

function removeFile(filePath) {
  try {
    unlinkSync(filePath)
  } catch {
    // Missing or locked files are already as good as removed.
  }
}

export function createCaptureStore({ dir, ttlMs = DEFAULT_TTL_MS, now = Date.now }) {
  const tokens = new Map()

  function register(filePath, meta = {}) {
    if (!isInside(dir, filePath)) {
      throw new Error('capture path is outside capture directory')
    }
    const token = randomBytes(16).toString('hex')
    tokens.set(token, {
      path: filePath,
      width: meta.width,
      height: meta.height,
      createdAt: now(),
    })
    return { token, path: filePath }
  }

  function resolve(token) {
    const entry = tokens.get(token)
    if (!entry) return null
    const expired = now() - entry.createdAt > ttlMs
    if (expired || !existsSync(entry.path)) {
      tokens.delete(token)
      removeFile(entry.path)
      return null
    }
    return {
      path: entry.path,
      width: entry.width,
      height: entry.height,
      createdAt: entry.createdAt,
    }
  }

  function discard(token) {
    const entry = tokens.get(token)
    if (!entry) return false
    tokens.delete(token)
    removeFile(entry.path)
    return true
  }

  function sweep() {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return 0
    }
    const cutoff = now() - ttlMs
    let removed = 0
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.png')) continue
      const filePath = join(dir, name)
      try {
        const stats = statSync(filePath)
        if (!stats.isFile() || stats.mtimeMs >= cutoff) continue
        removeFile(filePath)
        removed += 1
      } catch {
        // Deleted between readdir and stat, or unreadable: skip it.
      }
    }
    return removed
  }

  return { register, resolve, discard, sweep }
}

export function parseCaptureResult(stdout) {
  const lines = String(stdout == null ? '' : stdout).split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line.startsWith('{')) return JSON.parse(line)
  }
  throw new Error('capture produced no JSON result')
}

function toCaptureResult(parsed, outPath) {
  const action = parsed && typeof parsed.action === 'string' ? parsed.action : 'error'
  // outPath is always the exact temp PNG passed to PowerShell. It stays
  // internal: the HTTP layer uses it for token registration and cleanup but
  // never forwards it to the browser.
  const result = { action, outPath }
  if (action === 'ask') {
    if (parsed.width != null) result.width = parsed.width
    if (parsed.height != null) result.height = parsed.height
  } else if (action === 'save') {
    if (typeof parsed.path === 'string') result.path = parsed.path
  } else if (action === 'error') {
    result.message = typeof parsed.message === 'string' ? parsed.message : 'capture failed'
  }
  return result
}

export async function runCapture({
  context,
  powershellPath,
  scriptPath,
  tempDir,
  timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
  spawnImpl = spawn,
  onStderr = () => {},
}) {
  mkdirSync(tempDir, { recursive: true })
  const outPath = join(tempDir, `capture-${randomBytes(8).toString('hex')}.png`)
  const contextPath = join(tempDir, `context-${randomBytes(8).toString('hex')}.json`)
  writeFileSync(contextPath, JSON.stringify(context ?? {}), 'utf8')

  try {
    return await new Promise((resolve) => {
      let child
      try {
        child = spawnImpl(powershellPath, [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          '-OutPath',
          outPath,
          '-ContextPath',
          contextPath,
        ])
      } catch (error) {
        resolve({ action: 'error', message: error.message, outPath })
        return
      }

      let stdout = ''
      let settled = false
      let timer

      const settle = (value) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(value)
      }

      child.stdout?.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr?.on('data', (chunk) => {
        // stderr is diagnostic only: it goes to the optional logger callback,
        // never into the result or an HTTP response.
        try {
          onStderr(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
        } catch {
          // A broken logger must not break capture.
        }
      })
      child.on?.('error', (error) => {
        settle({ action: 'error', message: error.message, outPath })
      })
      child.on?.('close', () => {
        try {
          settle(toCaptureResult(parseCaptureResult(stdout), outPath))
        } catch (error) {
          settle({ action: 'error', message: error.message, outPath })
        }
      })

      timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // The child may already have exited.
        }
        settle({ action: 'error', message: 'capture timed out', outPath })
      }, timeoutMs)
    })
  } finally {
    removeFile(contextPath)
  }
}
