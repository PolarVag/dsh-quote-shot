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
const DEFAULT_OCR_TIMEOUT_MS = 4000
const MAX_OCR_CANDIDATES = 5

const DRIVE_PATH_RE =
  /[A-Za-z]:\\[^\r\n"'<>|]*?\.\w+(?::\d+)?(?=$|[\s,;)\]}>'"，。；、！？】》”’`]|\.(?!\w))/g
const DRIVE_PATH_NO_SPACE_RE = /[A-Za-z]:\\[^\s"'<>|]+/g
const RELATIVE_PATH_RE = /(?:[\w.-]+[\\/])+[\w.-]+\.\w+(?::\d+)?/g
const BARE_FILENAME_RE =
  /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|md|json|yaml|yml|toml|sh|ps1|css|html|vue|svelte)(?::\d+)?\b/gi
const TRAILING_PUNCTUATION_RE = /[.,;:)\]}"'`]+$/

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

// OCR engines often emit fullwidth punctuation and inject spaces around the
// colon. Normalize those before pattern matching, but keep newlines so
// candidates from different lines never merge. Do not collapse spaces around
// path separators: `a / b.ts` is prose, not a path (`a/b.ts`).
function normalizeOcrText(text) {
  return text
    .replace(/：/g, ':')
    .replace(/＼/g, '\\')
    .replace(/／/g, '/')
    .replace(/．/g, '.')
    .replace(/[ \t]*:[ \t]*/g, ':')
}

function followsSpacedSeparator(text, start) {
  return /[\\/][ \t]+$/.test(text.slice(0, start))
}

function isContained(start, end, matches) {
  return matches.some((match) => start >= match.start && end <= match.end)
}

// OCR text is untrusted free-form output: keep only path-looking fragments,
// in the order they appeared, and never hand more than five to the client.
export function parseOcrCandidates(text) {
  if (typeof text !== 'string' || !text) return []

  const normalized = normalizeOcrText(text)
  const driveMatches = []
  let match
  DRIVE_PATH_RE.lastIndex = 0
  while ((match = DRIVE_PATH_RE.exec(normalized)) !== null) {
    const value = match[0]
    const start = match.index
    const end = start + value.length
    // A space-containing drive match that also contains a forward slash has
    // almost certainly run across prose (`C:\Users\me and src/foo.ts`).
    // Discard it and recover the bounded fragment before the first space.
    if (/\s/.test(value) && value.includes('/')) {
      const fragment = normalized.slice(start, end)
      DRIVE_PATH_NO_SPACE_RE.lastIndex = 0
      let fallback
      while ((fallback = DRIVE_PATH_NO_SPACE_RE.exec(fragment)) !== null) {
        driveMatches.push({
          start: start + fallback.index,
          end: start + fallback.index + fallback[0].length,
          value: fallback[0],
        })
      }
      continue
    }
    driveMatches.push({ start, end, value })
  }

  const relativeMatches = []
  RELATIVE_PATH_RE.lastIndex = 0
  while ((match = RELATIVE_PATH_RE.exec(normalized)) !== null) {
    const start = match.index
    const end = start + match[0].length
    // A relative path inside a drive path is just the tail of that path
    // (`work\src\foo.ts` inside `C:\work\src\foo.ts`); do not duplicate it.
    if (isContained(start, end, driveMatches)) continue
    relativeMatches.push({ start, end, value: match[0] })
  }

  // Bare `foo.ts:42` is a valid candidate, but only for code extensions.
  // Drop its filename tail when it is already inside a longer path match.
  const bareMatches = []
  BARE_FILENAME_RE.lastIndex = 0
  while ((match = BARE_FILENAME_RE.exec(normalized)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (isContained(start, end, driveMatches)) continue
    if (isContained(start, end, relativeMatches)) continue
    // `a / b.ts` is prose separated by a slash, not a bare filename in a
    // path. Do not turn the right-hand token into a candidate on its own.
    if (followsSpacedSeparator(normalized, start)) continue
    bareMatches.push({ start, end, value: match[0] })
  }

  const matches = [...driveMatches, ...relativeMatches, ...bareMatches]
  matches.sort((left, right) => left.start - right.start)

  const candidates = []
  const seen = new Set()
  for (const item of matches) {
    const value = item.value.replace(TRAILING_PUNCTUATION_RE, '')
    if (value.length < 3 || seen.has(value)) continue
    seen.add(value)
    candidates.push(value)
    if (candidates.length >= MAX_OCR_CANDIDATES) break
  }
  return candidates
}

function sanitizeRect(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) return null
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

function resolvePowershellPath() {
  const root = process.env.SystemRoot || process.env.windir
  if (root) {
    const candidate = join(
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

function parseOcrOutput(stdout) {
  const lines = String(stdout == null ? '' : stdout).split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed.text === 'string') {
        return parseOcrCandidates(parsed.text)
      }
      return []
    } catch {
      // Keep looking in case a diagnostic line happened to start with `{`.
    }
  }
  return []
}

// Best-effort local OCR. It must never reject: a missing language pack, a
// broken WinRT install, or a slow child process all collapse to [].
export function runOcr({
  imagePath,
  scriptPath,
  timeoutMs = DEFAULT_OCR_TIMEOUT_MS,
  spawnImpl = spawn,
  powershellPath,
} = {}) {
  return new Promise((resolve) => {
    const command = powershellPath || resolvePowershellPath()
    let child
    let stdout = ''
    let settled = false
    let timer

    const settle = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }

    try {
      child = spawnImpl(command, [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-ImagePath',
        imagePath,
      ])
    } catch {
      settle([])
      return
    }

    // A malformed injectable spawn implementation must not turn into a
    // rejection; OCR is best-effort by contract.
    if (!child || typeof child.on !== 'function') {
      settle([])
      return
    }

    child.stdout?.on('data', (chunk) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    })
    // Drain stderr so a chatty child cannot block on a full pipe.
    child.stderr?.on('data', () => {})
    child.on?.('error', () => settle([]))
    child.on?.('close', (code) => {
      // A failed child is not a valid OCR result, even if it printed JSON.
      settle(code === 0 ? parseOcrOutput(stdout) : [])
    })

    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // The child may already have exited.
      }
      settle([])
    }, timeoutMs)
  })
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
    // rect is physical screen pixels. It is internal too: the API uses it to
    // decide whether OCR is warranted, then omits it from the HTTP body.
    const rect = sanitizeRect(parsed.rect)
    if (rect) result.rect = rect
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
