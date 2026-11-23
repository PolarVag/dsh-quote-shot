import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createApi } from '../lib/index.js'
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

test('health reports desktop capture capability', async () => {
  const { store } = fixture()
  const api = createApi({ store, capture: async () => ({ action: 'cancel' }) })

  const res = await invoke(api.health)

  assert.equal(res.status, 200)
  assert.match(res.headers['Content-Type'], /application\/json/)
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    platform: 'win32',
    capture: 'powershell',
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
