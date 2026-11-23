import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { copyCaptureToWorkspace, createApi, imageTokenFromUrl } from '../lib/index.js'
import { createCaptureStore } from '../lib/capture.js'

function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body = '') {
      this.body += body
    },
  }
}

function jsonRequest(value) {
  return Readable.from([Buffer.from(JSON.stringify(value), 'utf8')])
}

function rawRequest(text) {
  return Readable.from([Buffer.from(text, 'utf8')])
}

function invoke(handler, req = Readable.from([]), ...args) {
  const res = fakeRes()
  return Promise.resolve(handler(req, res, ...args)).then(() => res)
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'quote-shot-api-'))
  const png = join(dir, 'shot.png')
  writeFileSync(png, Buffer.from('fake-png-bytes'))
  const store = createCaptureStore({ dir })
  return { dir, png, store }
}

const validContext = {
  dsh: {
    windowRect: { x: 0, y: 0, width: 1440, height: 900 },
    scaleFactor: 1.25,
  },
}

test('extracts image tokens from the registered prefix without a double slash', () => {
  assert.equal(imageTokenFromUrl('/quote-shot/api/image/' + 'a'.repeat(32)), 'a'.repeat(32))
  assert.equal(imageTokenFromUrl('/quote-shot/api/image/' + 'b'.repeat(32) + '?v=1'), 'b'.repeat(32))
  assert.equal(imageTokenFromUrl('/quote-shot/api/image/'), '')
  assert.equal(imageTokenFromUrl('/quote-shot/api/image'), '')
  assert.equal(imageTokenFromUrl('/quote-shot/api/other/' + 'c'.repeat(32)), '')
})

test('copies an ask PNG into the session workspace and avoids overwrites', () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'quote-shot-copy-src-'))
  const workspace = mkdtempSync(join(tmpdir(), 'quote-shot-copy-ws-'))
  const source = join(sourceDir, 'shot.png')
  writeFileSync(source, Buffer.from('first'))

  const first = copyCaptureToWorkspace(workspace, source)
  const second = copyCaptureToWorkspace(workspace, source)

  assert.deepEqual(first, { relativePath: 'quote-shot-captures/shot.png' })
  assert.deepEqual(second, { relativePath: 'quote-shot-captures/shot-1.png' })
  assert.equal(readFileSync(join(workspace, first.relativePath), 'utf8'), 'first')
  assert.equal(readFileSync(join(workspace, second.relativePath), 'utf8'), 'first')
})

test('does not create a capture folder for an unusable workspace root', () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'quote-shot-copy-src-'))
  const source = join(sourceDir, 'shot.png')
  writeFileSync(source, Buffer.from('first'))
  const missing = join(sourceDir, 'missing')

  assert.equal(copyCaptureToWorkspace(missing, source), null)
  assert.equal(copyCaptureToWorkspace('', source), null)
  assert.equal(existsSync(join(missing, 'quote-shot-captures')), false)
})

test('health reports desktop capture capability', async () => {
  const { store } = fixture()
  const api = createApi({ store, capture: async () => ({ action: 'cancel' }), platform: 'win32' })

  const res = await invoke(api.health)

  assert.equal(res.status, 200)
  assert.match(res.headers['Content-Type'], /application\/json/)
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    platform: 'win32',
    capture: 'powershell',
  })
})

test('health reports unsupported capture on a non-Windows host', async () => {
  const { store } = fixture()
  const api = createApi({ store, capture: async () => ({ action: 'cancel' }), platform: 'linux' })

  const res = await invoke(api.health)

  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), {
    ok: false,
    platform: 'linux',
    capture: 'unavailable',
  })
})

test('capture rejects malformed JSON and malformed shapes with 400', async () => {
  const { store, png } = fixture()
  let calls = 0
  const api = createApi({
    store,
    capture: async () => {
      calls += 1
      return { action: 'cancel', outPath: png }
    },
  })

  const badJson = await invoke(api.capture, rawRequest('{not json'))
  assert.equal(badJson.status, 400)

  const badRect = await invoke(
    api.capture,
    jsonRequest({
      dsh: {
        windowRect: { x: 0, y: 0, width: 'wide', height: 10 },
        scaleFactor: 1,
      },
    }),
  )
  assert.equal(badRect.status, 400)

  const badScale = await invoke(
    api.capture,
    jsonRequest({
      dsh: {
        windowRect: { x: 0, y: 0, width: 10, height: 10 },
        scaleFactor: 0,
      },
    }),
  )
  assert.equal(badScale.status, 400)

  const missingDsh = await invoke(api.capture, jsonRequest({ windowRect: {} }))
  assert.equal(missingDsh.status, 400)

  assert.equal(calls, 0)
})

test('capture rejects bodies over 64 KB with 400', async () => {
  const { store, png } = fixture()
  let calls = 0
  const api = createApi({
    store,
    capture: async () => {
      calls += 1
      return { action: 'cancel', outPath: png }
    },
  })

  const res = await invoke(api.capture, rawRequest('x'.repeat(64 * 1024 + 1)))
  assert.equal(res.status, 400)
  assert.equal(calls, 0)
})

test('valid ask capture calls capture once and registers the token', async () => {
  const { store, png } = fixture()
  const seen = []
  const api = createApi({
    store,
    capture: async (context) => {
      seen.push(context)
      return { action: 'ask', outPath: png, width: 800, height: 600 }
    },
  })

  const res = await invoke(api.capture, jsonRequest(validContext))

  assert.equal(res.status, 200)
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], validContext)
  const payload = JSON.parse(res.body)
  assert.equal(payload.action, 'ask')
  assert.match(payload.token, /^[a-f0-9]{32}$/)
  assert.equal(payload.width, 800)
  assert.equal(payload.height, 600)
  assert.equal('outPath' in payload, false)
  const entry = store.resolve(payload.token)
  assert.equal(entry.path, png)
  assert.equal(entry.width, 800)
  assert.equal(entry.height, 600)
})

test('concurrent captures return 409 and only the first runs', async () => {
  const { store, png } = fixture()
  let calls = 0
  let release
  let started
  const startedPromise = new Promise((resolve) => {
    started = resolve
  })
  const pending = new Promise((resolve) => {
    release = resolve
  })
  const api = createApi({
    store,
    capture: async () => {
      calls += 1
      started()
      await pending
      return { action: 'cancel', outPath: png }
    },
  })

  const first = invoke(api.capture, jsonRequest(validContext))
  await startedPromise
  const second = await invoke(api.capture, jsonRequest(validContext))
  assert.equal(second.status, 409)
  assert.equal(calls, 1)

  release()
  const firstRes = await first
  assert.equal(firstRes.status, 200)
  assert.deepEqual(JSON.parse(firstRes.body), { action: 'cancel' })
})

test('image serves a registered token with no-store and rejects traversal', async () => {
  const { store, png } = fixture()
  const api = createApi({ store, capture: async () => ({ action: 'cancel' }) })
  const { token } = store.register(png, { width: 10, height: 10 })

  const ok = await invoke(api.image, Readable.from([]), token)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['Content-Type'], 'image/png')
  assert.equal(ok.headers['Cache-Control'], 'no-store')
  assert.equal(ok.body, 'fake-png-bytes')

  const traversal = await invoke(api.image, Readable.from([]), '../x')
  assert.equal(traversal.status, 404)

  const unknown = await invoke(api.image, Readable.from([]), 'deadbeef')
  assert.equal(unknown.status, 404)
})

test('discard removes the token and stays idempotent', async () => {
  const { store, png } = fixture()
  const api = createApi({ store, capture: async () => ({ action: 'cancel' }) })
  const { token } = store.register(png)

  const first = await invoke(api.discard, jsonRequest({ token }))
  assert.equal(first.status, 204)
  assert.equal(existsSync(png), false)

  const second = await invoke(api.discard, jsonRequest({ token }))
  assert.equal(second.status, 204)
})

test('failed token registration returns 500 and removes the temp PNG', async () => {
  const { dir, store } = fixture()
  const tempPng = join(dir, 'temp-ask.png')
  writeFileSync(tempPng, Buffer.from('temp'))
  const brokenStore = {
    register() {
      throw new Error('register failed')
    },
    resolve: store.resolve,
    discard: store.discard,
  }
  const api = createApi({
    store: brokenStore,
    capture: async () => ({ action: 'ask', outPath: tempPng, width: 10, height: 10 }),
  })

  const res = await invoke(api.capture, jsonRequest(validContext))

  assert.equal(res.status, 500)
  assert.equal(existsSync(tempPng), false)
})

test('save response strips outPath and removes the temp PNG', async () => {
  const { dir, store } = fixture()
  const tempPng = join(dir, 'temp-save.png')
  const savedPath = join(dir, 'picked.png')
  writeFileSync(tempPng, Buffer.from('temp'))
  const api = createApi({
    store,
    capture: async () => ({ action: 'save', path: savedPath, outPath: tempPng }),
  })

  const res = await invoke(api.capture, jsonRequest(validContext))

  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.deepEqual(payload, { action: 'save', path: savedPath })
  assert.equal(existsSync(tempPng), false)
})

test('cancel response strips outPath and removes the temp PNG', async () => {
  const { dir, store } = fixture()
  const tempPng = join(dir, 'temp-cancel.png')
  writeFileSync(tempPng, Buffer.from('temp'))
  const api = createApi({
    store,
    capture: async () => ({ action: 'cancel', outPath: tempPng }),
  })

  const res = await invoke(api.capture, jsonRequest(validContext))

  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { action: 'cancel' })
  assert.equal(existsSync(tempPng), false)
})

test('error response strips outPath and removes the temp PNG', async () => {
  const { dir, store } = fixture()
  const tempPng = join(dir, 'temp-error.png')
  writeFileSync(tempPng, Buffer.from('temp'))
  const api = createApi({
    store,
    capture: async () => ({ action: 'error', message: 'boom', outPath: tempPng }),
  })

  const res = await invoke(api.capture, jsonRequest(validContext))

  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { action: 'error', message: 'boom' })
  assert.equal(existsSync(tempPng), false)
})

test('ask outside the DSH window runs OCR and attaches candidates', async () => {
  const { store, png } = fixture()
  const ocrCalls = []
  const api = createApi({
    store,
    capture: async () => ({
      action: 'ask',
      outPath: png,
      width: 300,
      height: 200,
      rect: { x: 2000, y: 100, width: 300, height: 200 },
    }),
    ocr: async (args) => {
      ocrCalls.push(args)
      return ['C:\\work\\a.ts:9', 'src/b.js']
    },
  })

  const res = await invoke(api.capture, jsonRequest(validContext))
  const payload = JSON.parse(res.body)

  assert.equal(res.status, 200)
  assert.deepEqual(ocrCalls, [{ imagePath: png }])
  assert.equal(payload.action, 'ask')
  assert.deepEqual(payload.ocrCandidates, ['C:\\work\\a.ts:9', 'src/b.js'])
  assert.equal('outPath' in payload, false)
  assert.equal('rect' in payload, false)
})

test('ask inside the DSH window skips OCR', async () => {
  const { store, png } = fixture()
  let ocrCalls = 0
  const api = createApi({
    store,
    capture: async () => ({
      action: 'ask',
      outPath: png,
      width: 200,
      height: 120,
      rect: { x: 100, y: 100, width: 200, height: 120 },
    }),
    ocr: async () => {
      ocrCalls += 1
      return ['should-not-appear']
    },
  })

  const res = await invoke(api.capture, jsonRequest(validContext))
  const payload = JSON.parse(res.body)

  assert.equal(res.status, 200)
  assert.equal(ocrCalls, 0)
  assert.equal('ocrCandidates' in payload, false)
  assert.equal('outPath' in payload, false)
  assert.equal('rect' in payload, false)
})

test('ask with an invalid or missing rect never runs OCR', async () => {
  const { store, png } = fixture()
  let ocrCalls = 0
  const api = createApi({
    store,
    capture: async () => ({
      action: 'ask',
      outPath: png,
      width: 200,
      height: 120,
      rect: { x: 1, y: 2, width: Number.NaN, height: 4 },
    }),
    ocr: async () => {
      ocrCalls += 1
      return ['should-not-appear']
    },
  })

  const res = await invoke(api.capture, jsonRequest(validContext))

  assert.equal(res.status, 200)
  assert.equal(ocrCalls, 0)
  assert.equal('ocrCandidates' in JSON.parse(res.body), false)
})

test('OCR rejection does not fail the capture', async () => {
  const { store, png } = fixture()
  const api = createApi({
    store,
    logger: { warn() {} },
    capture: async () => ({
      action: 'ask',
      outPath: png,
      width: 300,
      height: 200,
      rect: { x: 2000, y: 100, width: 300, height: 200 },
    }),
    ocr: async () => {
      throw new Error('ocr exploded')
    },
  })

  const res = await invoke(api.capture, jsonRequest(validContext))
  const payload = JSON.parse(res.body)

  assert.equal(res.status, 200)
  assert.equal(payload.action, 'ask')
  assert.match(payload.token, /^[a-f0-9]{32}$/)
  assert.equal('ocrCandidates' in payload, false)
  assert.equal('outPath' in payload, false)
  assert.equal('rect' in payload, false)
})

test('OCR timeout is omitted without delaying the capture indefinitely', async () => {
  const { store, png } = fixture()
  const api = createApi({
    store,
    capture: async () => ({
      action: 'ask',
      outPath: png,
      width: 300,
      height: 200,
      rect: { x: 2000, y: 100, width: 300, height: 200 },
    }),
    ocr: () => new Promise(() => {}),
  })

  const started = Date.now()
  const res = await invoke(api.capture, jsonRequest(validContext))
  const elapsed = Date.now() - started
  const payload = JSON.parse(res.body)

  assert.equal(res.status, 200)
  assert.equal(payload.action, 'ask')
  assert.equal('ocrCandidates' in payload, false)
  assert.ok(elapsed >= 3500, `capture returned before the 4s OCR budget: ${elapsed}ms`)
  assert.ok(elapsed < 5000, `capture took ${elapsed}ms`)
})

test('sanitizes OCR candidates by trimming, deduping, and capping at five', async () => {
  const { store, png } = fixture()
  const api = createApi({
    store,
    capture: async () => ({
      action: 'ask',
      outPath: png,
      width: 300,
      height: 200,
      rect: { x: 2000, y: 100, width: 300, height: 200 },
    }),
    ocr: async () => [
      ' C:\\a.ts ',
      'C:\\a.ts',
      'src/b.js',
      'c/d.ts',
      'e/f.ts',
      'g/h.ts',
      'C:\\i.ts',
      42,
    ],
  })

  const res = await invoke(api.capture, jsonRequest(validContext))
  const payload = JSON.parse(res.body)

  assert.equal(res.status, 200)
  assert.deepEqual(payload.ocrCandidates, [
    'C:\\a.ts',
    'src/b.js',
    'c/d.ts',
    'e/f.ts',
    'g/h.ts',
  ])
})

test('edge-touching rectangles are disjoint, so OCR runs', async () => {
  const { store, png } = fixture()
  const context = {
    dsh: {
      windowRect: { x: 0, y: 0, width: 100, height: 100 },
      scaleFactor: 1,
    },
  }
  const ocrCalls = []
  const api = createApi({
    store,
    capture: async () => ({
      action: 'ask',
      outPath: png,
      width: 50,
      height: 50,
      rect: { x: 100, y: 0, width: 50, height: 50 },
    }),
    ocr: async (args) => {
      ocrCalls.push(args)
      return ['foo.ts:42']
    },
  })

  const res = await invoke(api.capture, jsonRequest(context))
  const payload = JSON.parse(res.body)

  assert.equal(res.status, 200)
  assert.deepEqual(ocrCalls, [{ imagePath: png }])
  assert.deepEqual(payload.ocrCandidates, ['foo.ts:42'])
})

test('ask tags file sourceKind when the crop intersects an active file rect', async () => {
  const { store, png } = fixture()
  let ocrCalls = 0
  const context = {
    dsh: {
      windowRect: { x: 0, y: 0, width: 800, height: 600 },
      scaleFactor: 1,
      activeFile: { path: 'src/a.ts', rect: { x: 100, y: 100, width: 100, height: 100 } },
      chat: { turn: 2, rect: { x: 300, y: 300, width: 100, height: 100 } },
    },
  }
  const api = createApi({
    store,
    capture: async () => ({
      action: 'ask',
      outPath: png,
      width: 20,
      height: 20,
      rect: { x: 120, y: 120, width: 20, height: 20 },
    }),
    ocr: async () => {
      ocrCalls += 1
      return ['should-not-appear']
    },
  })

  const res = await invoke(api.capture, jsonRequest(context))
  const payload = JSON.parse(res.body)

  assert.equal(res.status, 200)
  assert.equal(payload.sourceKind, 'file')
  assert.equal(ocrCalls, 0)
  assert.equal('rect' in payload, false)
  assert.equal('outPath' in payload, false)
})

test('ask tags chat sourceKind and still omits source geometry', async () => {
  const { store, png } = fixture()
  const context = {
    dsh: {
      windowRect: { x: 0, y: 0, width: 800, height: 600 },
      scaleFactor: 1,
      activeFile: { path: 'src/a.ts', rect: { x: 100, y: 100, width: 50, height: 50 } },
      chat: { turn: 2, rect: { x: 300, y: 300, width: 100, height: 100 } },
    },
  }
  const api = createApi({
    store,
    capture: async () => ({
      action: 'ask',
      outPath: png,
      width: 20,
      height: 20,
      rect: { x: 320, y: 320, width: 20, height: 20 },
    }),
  })

  const res = await invoke(api.capture, jsonRequest(context))
  const payload = JSON.parse(res.body)

  assert.equal(payload.sourceKind, 'chat')
  assert.equal('activeFile' in payload, false)
  assert.equal('chat' in payload, false)
})

test('ask defaults to none when source rects are absent or invalid', async () => {
  const { store, png } = fixture()
  const context = {
    dsh: {
      windowRect: { x: 0, y: 0, width: 800, height: 600 },
      scaleFactor: 1,
      activeFile: { path: 'src/a.ts' },
      chat: { turn: 2, rect: { x: 300, y: 300, width: 0, height: 100 } },
    },
  }
  const api = createApi({
    store,
    capture: async () => ({
      action: 'ask',
      outPath: png,
      width: 20,
      height: 20,
      rect: { x: 2000, y: 100, width: 20, height: 20 },
    }),
    ocr: async () => ['C:\\work\\a.ts'],
  })

  const res = await invoke(api.capture, jsonRequest(context))
  const payload = JSON.parse(res.body)

  assert.equal(payload.sourceKind, 'none')
  assert.deepEqual(payload.ocrCandidates, ['C:\\work\\a.ts'])
})

test('ask reports sourceKind none even when the crop has no usable rect', async () => {
  const { store, png } = fixture()
  const api = createApi({
    store,
    capture: async () => ({ action: 'ask', outPath: png, width: 20, height: 20 }),
  })

  const res = await invoke(api.capture, jsonRequest(validContext))
  const payload = JSON.parse(res.body)

  assert.equal(payload.sourceKind, 'none')
  assert.equal('ocrCandidates' in payload, false)
})

test('intersection uses physical pixels for negative, fractional-scale rects', async () => {
  const { store, png } = fixture()
  const context = {
    dsh: {
      windowRect: { x: -1000.5, y: -500.5, width: 800, height: 600 },
      scaleFactor: 1.5,
    },
  }
  let ocrCalls = 0
  const api = createApi({
    store,
    capture: async () => ({
      action: 'ask',
      outPath: png,
      width: 50,
      height: 50,
      // DSH physical rect is (-1500.75, -750.75) to (-300.75, 149.25).
      rect: { x: -1400, y: -700, width: 50, height: 50 },
    }),
    ocr: async () => {
      ocrCalls += 1
      return ['should-not-appear']
    },
  })

  const res = await invoke(api.capture, jsonRequest(context))

  assert.equal(res.status, 200)
  assert.equal(ocrCalls, 0)
  assert.equal('ocrCandidates' in JSON.parse(res.body), false)
})
