import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { parseOcrCandidates, runOcr } from '../lib/capture.js'

function fakeSpawn(handler) {
  const calls = []
  const spawnImpl = (command, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => {
      child.killed = true
    }
    calls.push({ command, args, child })
    queueMicrotask(() => handler(child))
    return child
  }
  return { spawnImpl, calls }
}

test('extracts path-like candidates and deduplicates them', () => {
  const text = 'see C:\\work\\src\\foo.ts:42 and src/bar.ts then C:\\work\\src\\foo.ts:42'
  assert.deepEqual(parseOcrCandidates(text), ['C:\\work\\src\\foo.ts:42', 'src/bar.ts'])
})

test('normalizes fullwidth punctuation and spacing in OCR text', () => {
  const text = 'C ： \\work\\src\\foo.ts ： 42'
  assert.deepEqual(parseOcrCandidates(text), ['C:\\work\\src\\foo.ts:42'])
})

test('keeps a drive path containing spaces as one candidate', () => {
  const text = 'open C:\\Program Files\\App\\x.ts now'
  assert.deepEqual(parseOcrCandidates(text), ['C:\\Program Files\\App\\x.ts'])
})

test('extracts bare code filenames with optional line numbers', () => {
  assert.deepEqual(parseOcrCandidates('error at foo.ts:42'), ['foo.ts:42'])
  assert.deepEqual(parseOcrCandidates('see main.py'), ['main.py'])
})

test('does not extract arbitrary non-code filenames', () => {
  assert.deepEqual(parseOcrCandidates('notes.txt and README.doc'), [])
})

test('does not merge candidates across newlines', () => {
  assert.deepEqual(parseOcrCandidates('C:\\a\\b.ts\nsrc/c.ts'), [
    'C:\\a\\b.ts',
    'src/c.ts',
  ])
})

test('skips relative matches fully contained inside a drive path', () => {
  const text = 'open C:\\work\\src\\foo.ts:42 and src/bar.ts'
  assert.deepEqual(parseOcrCandidates(text), ['C:\\work\\src\\foo.ts:42', 'src/bar.ts'])
})

test('strips trailing punctuation and filters short fragments', () => {
  const text = 'see C:\\src\\app.ts:12), then src\\lib\\x.js). and a.b.'
  assert.deepEqual(parseOcrCandidates(text), ['C:\\src\\app.ts:12', 'src\\lib\\x.js'])
})

test('strips trailing backticks and quotes', () => {
  assert.deepEqual(parseOcrCandidates('see `C:\\x\\y.ts` and "src/z.js"'), [
    'C:\\x\\y.ts',
    'src/z.js',
  ])
})

test('returns at most five candidates in first-seen order', () => {
  const paths = Array.from({ length: 7 }, (_, index) => `C:\\tmp\\file${index}.ts`)
  assert.deepEqual(parseOcrCandidates(paths.join(' ')), paths.slice(0, 5))
})

test('runOcr parses the final JSON line and returns path candidates', async () => {
  const { spawnImpl, calls } = fakeSpawn((child) => {
    child.stdout.emit('data', 'diagnostic\nnoise\n')
    child.stdout.emit('data', `${JSON.stringify({ text: 'C:\\work\\a.ts:5 and src/b.js' })}\n`)
    child.emit('close', 0)
  })

  const candidates = await runOcr({
    imagePath: 'C:\\temp\\shot.png',
    scriptPath: 'C:\\plugin\\ocr.ps1',
    powershellPath: 'powershell.exe',
    spawnImpl,
  })

  assert.deepEqual(candidates, ['C:\\work\\a.ts:5', 'src/b.js'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'powershell.exe')
  assert.deepEqual(calls[0].args, [
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'C:\\plugin\\ocr.ps1',
    '-ImagePath',
    'C:\\temp\\shot.png',
  ])
})

test('runOcr returns [] when the spawned process cannot start', async () => {
  const candidates = await runOcr({
    imagePath: 'shot.png',
    scriptPath: 'ocr.ps1',
    powershellPath: 'powershell.exe',
    spawnImpl: () => {
      throw new Error('spawn failed')
    },
  })
  assert.deepEqual(candidates, [])
})

test('runOcr returns [] when spawn yields no usable child', async () => {
  const candidates = await runOcr({
    imagePath: 'shot.png',
    scriptPath: 'ocr.ps1',
    powershellPath: 'powershell.exe',
    spawnImpl: () => undefined,
  })
  assert.deepEqual(candidates, [])
})

test('runOcr returns [] on child error or unparseable output', async () => {
  const errored = await runOcr({
    imagePath: 'shot.png',
    scriptPath: 'ocr.ps1',
    powershellPath: 'powershell.exe',
    spawnImpl: () => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      queueMicrotask(() => child.emit('error', new Error('boom')))
      return child
    },
  })
  assert.deepEqual(errored, [])

  const unparseable = await runOcr({
    imagePath: 'shot.png',
    scriptPath: 'ocr.ps1',
    powershellPath: 'powershell.exe',
    spawnImpl: fakeSpawn((child) => {
      child.stdout.emit('data', 'not json at all\n')
      child.emit('close', 1)
    }).spawnImpl,
  })
  assert.deepEqual(unparseable, [])
})

test('runOcr ignores valid JSON when the child exits nonzero', async () => {
  const candidates = await runOcr({
    imagePath: 'shot.png',
    scriptPath: 'ocr.ps1',
    powershellPath: 'powershell.exe',
    spawnImpl: fakeSpawn((child) => {
      child.stdout.emit('data', `${JSON.stringify({ text: 'C:\\a\\b.ts' })}\n`)
      child.emit('close', 1)
    }).spawnImpl,
  })
  assert.deepEqual(candidates, [])
})

test('runOcr treats a null exit code as failure', async () => {
  const candidates = await runOcr({
    imagePath: 'shot.png',
    scriptPath: 'ocr.ps1',
    powershellPath: 'powershell.exe',
    spawnImpl: fakeSpawn((child) => {
      child.stdout.emit('data', `${JSON.stringify({ text: 'C:\\a\\b.ts' })}\n`)
      child.emit('close', null)
    }).spawnImpl,
  })
  assert.deepEqual(candidates, [])
})

test('runOcr returns [] when the result text is not a string', async () => {
  const candidates = await runOcr({
    imagePath: 'shot.png',
    scriptPath: 'ocr.ps1',
    powershellPath: 'powershell.exe',
    spawnImpl: fakeSpawn((child) => {
      child.stdout.emit('data', `${JSON.stringify({ text: 42 })}\n`)
      child.emit('close', 0)
    }).spawnImpl,
  })
  assert.deepEqual(candidates, [])
})

test('runOcr kills a timed-out child and returns []', async () => {
  const { spawnImpl, calls } = fakeSpawn(() => {
    // Deliberately never closes: the timeout must settle the promise.
  })

  const candidates = await runOcr({
    imagePath: 'shot.png',
    scriptPath: 'ocr.ps1',
    powershellPath: 'powershell.exe',
    timeoutMs: 20,
    spawnImpl,
  })

  assert.deepEqual(candidates, [])
  assert.equal(calls[0].child.killed, true)
})
