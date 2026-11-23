import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createCaptureStore, parseCaptureResult, runCapture } from '../lib/capture.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'quote-shot-'))
  const png = join(dir, 'shot.png')
  writeFileSync(png, Buffer.from('png'))
  let clock = 1_000
  return { dir, png, clock: () => clock, advance: (ms) => { clock += ms } }
}

// Fake child_process.spawn that records the invocation, reads the context file
// synchronously (while the real child would have been running), and then lets
// each test drive stdout and close deterministically.
function makeSpawn(handler) {
  let call
  const spawnImpl = (command, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    const flagValue = (flag) => args[args.indexOf(flag) + 1]
    call = {
      command,
      args,
      outPath: flagValue('-OutPath'),
      contextPath: flagValue('-ContextPath'),
      contextOnDisk: JSON.parse(readFileSync(flagValue('-ContextPath'), 'utf8')),
    }
    queueMicrotask(() => handler(child, call))
    return child
  }
  return { spawnImpl, getCall: () => call }
}

test('registers and resolves a token', () => {
  const f = fixture()
  const store = createCaptureStore({ dir: f.dir, now: f.clock })
  const { token, path } = store.register(f.png, { width: 10, height: 20 })
  assert.match(token, /^[a-f0-9]{32}$/)
  assert.equal(path, f.png)
  assert.deepEqual(store.resolve(token), { path: f.png, width: 10, height: 20, createdAt: 1_000 })
})

test('expires and deletes a token', () => {
  const f = fixture()
  const store = createCaptureStore({ dir: f.dir, ttlMs: 10, now: f.clock })
  const { token } = store.register(f.png)
  f.advance(11)
  assert.equal(store.resolve(token), null)
  assert.equal(existsSync(f.png), false)
})

test('default token TTL is one hour', () => {
  const f = fixture()
  const store = createCaptureStore({ dir: f.dir, now: f.clock })
  const { token } = store.register(f.png)
  f.advance(3_600_000)
  assert.ok(store.resolve(token))
  f.advance(1)
  assert.equal(store.resolve(token), null)
  assert.equal(existsSync(f.png), false)
})

test('discard is idempotent and deletes the file', () => {
  const f = fixture()
  const store = createCaptureStore({ dir: f.dir, now: f.clock })
  const { token } = store.register(f.png)
  assert.equal(store.discard(token), true)
  assert.equal(store.discard(token), false)
  assert.equal(existsSync(f.png), false)
})

test('rejects paths outside the capture directory', () => {
  const f = fixture()
  const outside = join(tmpdir(), 'outside.png')
  const store = createCaptureStore({ dir: f.dir, now: f.clock })
  assert.throws(() => store.register(outside), /outside capture directory/)
})

test('sweeps old files only', () => {
  const f = fixture()
  const old = join(f.dir, 'old.png')
  writeFileSync(old, Buffer.from('old'))
  utimesSync(old, new Date(0), new Date(0))
  const store = createCaptureStore({ dir: f.dir, ttlMs: 10, now: f.clock })
  f.advance(11)
  assert.equal(store.sweep(), 1)
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(f.png), true)
})

test('parses the last JSON line', () => {
  assert.deepEqual(parseCaptureResult('log\n{"action":"cancel"}\n'), { action: 'cancel' })
})

test('runCapture maps an ask result and removes the context file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quote-shot-run-'))
  const context = { dsh: { scaleFactor: 1.25, activeFile: { path: 'src/foo.ts' } } }
  const { spawnImpl, getCall } = makeSpawn((child) => {
    child.stdout.emit('data', 'debug line\n{"action":"ask","width":10,"height":20}\n')
    child.emit('close', 0)
  })

  const result = await runCapture({
    context,
    powershellPath: 'powershell.exe',
    scriptPath: 'C:\\plugin\\capture.ps1',
    tempDir: dir,
    spawnImpl,
  })
  const call = getCall()

  assert.equal(call.command, 'powershell.exe')
  assert.ok(call.args.includes('-OutPath'))
  assert.ok(call.args.includes('-ContextPath'))
  assert.deepEqual(call.contextOnDisk, context)
  assert.deepEqual(result, { action: 'ask', outPath: call.outPath, width: 10, height: 20 })
  assert.equal(dirname(result.outPath), dir)
  assert.match(result.outPath, /\.png$/)
  assert.equal(existsSync(call.contextPath), false)
})

test('runCapture maps a save result and removes the context file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quote-shot-run-'))
  const savedPath = join(dir, 'picked.png')
  const { spawnImpl, getCall } = makeSpawn((child) => {
    child.stdout.emit('data', JSON.stringify({ action: 'save', path: savedPath }) + '\n')
    child.emit('close', 0)
  })

  const result = await runCapture({
    context: { chat: { turn: 3 } },
    powershellPath: 'powershell.exe',
    scriptPath: 'C:\\plugin\\capture.ps1',
    tempDir: dir,
    spawnImpl,
  })
  const call = getCall()

  assert.deepEqual(result, { action: 'save', path: savedPath })
  assert.equal('outPath' in result, false)
  assert.equal(existsSync(call.contextPath), false)
})

test('runCapture times out and removes its context file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quote-shot-run-'))
  let killed = false
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {
    killed = true
  }

  const result = await runCapture({
    context: { dsh: { windowRect: { x: 0, y: 0, width: 1, height: 1 } } },
    powershellPath: 'powershell.exe',
    scriptPath: 'capture.ps1',
    tempDir: dir,
    timeoutMs: 20,
    spawnImpl: () => child,
  })

  assert.deepEqual(result, { action: 'error', message: 'capture timed out' })
  assert.equal(killed, true)
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith('.json')),
    [],
  )
})
