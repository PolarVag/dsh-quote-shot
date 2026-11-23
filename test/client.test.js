import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function loadClient(overrides = {}) {
  let registration
  const windowOverrides = overrides.window || {}
  const sandbox = {
    ...overrides,
    window: {
      __ModuleLoader__: { load: (r) => { registration = r } },
      ...windowOverrides,
    },
    console: overrides.console || console,
  }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox)
  return registration.factory(() => { throw new Error('unexpected top-level require') })
}

function jsonResponse(value, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    json: async () => value,
  }
}

function blobResponse(blob) {
  return {
    ok: true,
    status: 200,
    blob: async () => blob,
  }
}

class FakeFile {
  constructor(parts, name, options) {
    this.parts = parts
    this.name = name
    this.type = options && options.type
  }
}

function fakeFetch({
  health = { ok: true },
  capture = { action: 'cancel' },
  image = true,
  discard = true,
} = {}) {
  const calls = []
  async function fetch(url, options = {}) {
    calls.push({ url, options })
    if (url === '/quote-shot/api/health') {
      return health ? jsonResponse(health) : jsonResponse({}, { ok: false, status: 503 })
    }
    if (url === '/quote-shot/api/capture') return jsonResponse(capture)
    if (url.startsWith('/quote-shot/api/image/')) {
      if (!image) return jsonResponse({}, { ok: false, status: 404 })
      return blobResponse({ size: 12 })
    }
    if (url === '/quote-shot/api/discard') {
      return discard ? jsonResponse({}) : jsonResponse({}, { ok: false, status: 500 })
    }
    throw new Error('unexpected fetch: ' + url)
  }
  return { calls, fetch }
}

function fakeComposer(tag, { added = true, inserted = true } = {}) {
  const events = []
  const drafts = [{ id: 'draft-' + tag }]
  return {
    tag,
    events,
    sessionId: 'session-' + tag,
    ctx: {
      sessions: {
        scope(id) {
          events.push(['scope', id])
          return {
            get(name) {
              events.push(['get', id, name])
              return {
                createDrafts(sessionId, files) {
                  events.push(['createDrafts', sessionId, files[0].name])
                  return drafts
                },
                releaseDraftAttachments(value) {
                  events.push(['releaseDrafts', value])
                },
              }
            },
          }
        },
      },
    },
    inputActions: {
      captureInsertion() {
        events.push(['captureInsertion'])
        return { draftRev: 1 }
      },
      addAttachments(ids) {
        events.push(['addAttachments', ids])
        return added
      },
      insertText(text, span) {
        events.push(['insertText', text, span])
        return inserted
      },
      focus() {
        events.push(['focus'])
      },
    },
  }
}

function fakeToastDocument() {
  const elements = []
  const body = {
    appendChild(element) {
      element.parentNode = body
      elements.push(element)
    },
    removeChild(element) {
      element.parentNode = null
    },
  }
  return {
    elements,
    body,
    createElement() {
      return {
        style: {},
        setAttribute(name, value) { this[name] = value },
        textContent: '',
        parentNode: null,
      }
    },
  }
}

// Values created inside the vm have a different Object/Array prototype.
// Round-trip through JSON so deepStrictEqual compares plain host values.
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

test('quotes plain text with a file source', () => {
  const { formatQuote } = loadClient().__internals
  assert.equal(
    formatQuote({
      text: 'const x = 1\nconst y = 2',
      source: { kind: 'file', path: 'src/foo.ts', startLine: 42, endLine: 43 },
    }),
    '> 来源：src/foo.ts:42-43\n>\n> const x = 1\n> const y = 2',
  )
})

test('quotes code with a dynamic fence and language', () => {
  const { formatQuote } = loadClient().__internals
  assert.equal(
    formatQuote({
      text: 'const s = `a`',
      source: { kind: 'file', path: 'src/foo.ts', startLine: 42, language: 'ts' },
    }),
    '来源：src/foo.ts:42\n\n```ts\nconst s = `a`\n```',
  )
})

test('expands the fence past backtick runs in the selected code', () => {
  const { formatQuote } = loadClient().__internals
  assert.equal(
    formatQuote({ text: '```\ninside\n```', source: { kind: 'chat', turn: 3, language: 'md' } }),
    '来源：对话第 3 轮 · 代码块（md）\n\n````md\n```\ninside\n```\n````',
  )
})

test('uses chat turn labels and omits missing source lines', () => {
  const { formatSourceLabel, formatQuote } = loadClient().__internals
  assert.equal(formatSourceLabel({ kind: 'chat', turn: 3 }), '对话第 3 轮')
  assert.equal(formatSourceLabel({ kind: 'file', path: 'src/a.ts' }), 'src/a.ts')
  assert.equal(formatQuote({ text: 'hi' }), '> hi')
})

test('labels chat code blocks with their language but keeps file labels path-based', () => {
  const { formatSourceLabel, formatQuote } = loadClient().__internals
  assert.equal(formatSourceLabel({ kind: 'chat', turn: 3, language: 'ts' }), '对话第 3 轮 · 代码块（ts）')
  assert.equal(formatSourceLabel({ kind: 'chat', anchorKey: 'a1', language: 'md' }), '当前对话 · 代码块（md）')
  assert.equal(formatSourceLabel({ kind: 'file', path: 'src/foo.ts', language: 'ts' }), 'src/foo.ts')
  assert.equal(
    formatQuote({ text: 'const x = 1', source: { kind: 'chat', turn: 2, language: 'ts' } }),
    '来源：对话第 2 轮 · 代码块（ts）\n\n```ts\nconst x = 1\n```',
  )
})

test('truncates long bodies and marks them', () => {
  const { formatQuote } = loadClient().__internals
  const output = formatQuote({ text: 'abcdef', maxChars: 3 })
  assert.equal(output, '> abc\n\n（已截断）')
})

test('applies the default character cap at the boundary', () => {
  const { formatQuote } = loadClient().__internals
  const atLimit = 'a'.repeat(12000)
  assert.equal(formatQuote({ text: atLimit }), '> ' + atLimit)
  assert.equal(formatQuote({ text: 'a'.repeat(12001) }), '> ' + atLimit + '\n\n（已截断）')
})

test('builds a file source from a dsh-resource address and line range', () => {
  const { sourceFromPreview } = loadClient().__internals
  assert.deepEqual(
    { ...sourceFromPreview({
      address: 'dsh-resource://file/session/s1/src%2Ffoo.ts',
      startLine: 42,
      endLine: 43,
      language: 'ts',
    }) },
    { kind: 'file', path: 'src/foo.ts', startLine: 42, endLine: 43, language: 'ts' },
  )
})

test('omits absent preview fields and decodes the path', () => {
  const { sourceFromPreview } = loadClient().__internals
  assert.deepEqual(
    { ...sourceFromPreview({ address: 'dsh-resource://file/session/s1/a%20b%2Fc.md' }) },
    { kind: 'file', path: 'a b/c.md' },
  )
  assert.deepEqual(
    { ...sourceFromPreview({ address: 'dsh-resource://file/session/s1/src%2Ffoo.ts' }) },
    { kind: 'file', path: 'src/foo.ts' },
  )
  // Spec 4.4: lines are a pair; a lone endpoint is omitted entirely.
  assert.deepEqual(
    { ...sourceFromPreview({ address: 'dsh-resource://file/session/s1/src%2Ffoo.ts', startLine: 7 }) },
    { kind: 'file', path: 'src/foo.ts' },
  )
  assert.deepEqual(
    { ...sourceFromPreview({ address: 'dsh-resource://file/session/s1/src%2Ffoo.ts', endLine: 9 }) },
    { kind: 'file', path: 'src/foo.ts' },
  )
  assert.deepEqual(
    { ...sourceFromPreview({ address: 'dsh-resource://file/session/s1/src%2Ffoo.ts', startLine: 7, endLine: 7 }) },
    { kind: 'file', path: 'src/foo.ts', startLine: 7, endLine: 7 },
  )
})

test('ignores invalid preview addresses', () => {
  const { sourceFromPreview } = loadClient().__internals
  assert.equal(sourceFromPreview({ address: 'https://example.com/src%2Ffoo.ts' }), undefined)
  assert.equal(sourceFromPreview({ address: 'dsh-resource://file/other/s1/src%2Ffoo.ts' }), undefined)
  assert.equal(sourceFromPreview({ address: 'dsh-resource://file/session/s1/' }), undefined)
  assert.equal(sourceFromPreview({ address: 'dsh-resource://file/session/s1/%E0%A4%A' }), undefined)
  assert.equal(sourceFromPreview({}), undefined)
})

test('builds a chat source and falls back when no turn exists', () => {
  const { sourceFromChat } = loadClient().__internals
  assert.deepEqual({ ...sourceFromChat({ turn: 3 }) }, { kind: 'chat', turn: 3 })
  assert.deepEqual({ ...sourceFromChat({ anchorKey: 'a1' }) }, { kind: 'chat', anchorKey: 'a1' })
  assert.equal(sourceFromChat({}), undefined)
})

test('prefers a numeric chat turn over an anchor key', () => {
  const { sourceFromChat } = loadClient().__internals
  assert.deepEqual(
    { ...sourceFromChat({ turn: 4, anchorKey: 'turn-4' }) },
    { kind: 'chat', turn: 4 },
  )
  assert.deepEqual(
    { ...sourceFromChat({ turn: 'not-a-number', anchorKey: 'turn-x' }) },
    { kind: 'chat', anchorKey: 'turn-x' },
  )
  assert.equal(sourceFromChat({ anchorKey: '   ' }), undefined)
})

test('builds a bounded capture request', () => {
  const { buildCaptureRequest } = loadClient().__internals
  assert.deepEqual(
    plain(buildCaptureRequest({
      windowRect: { x: 0, y: 0, width: 1440, height: 900 },
      scaleFactor: 1.25,
      activeFile: { path: 'src/foo.ts', startLine: 42, endLine: 58 },
      chat: { turn: 3 },
    })),
    { dsh: { windowRect: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 1.25, activeFile: { path: 'src/foo.ts', startLine: 42, endLine: 58 }, chat: { turn: 3 } } },
  )
})

test('accepts only known capture actions', () => {
  const { parseCaptureResponse } = loadClient().__internals
  assert.deepEqual(
    plain(parseCaptureResponse({ action: 'ask', token: 'a'.repeat(32), width: 10, height: 20, ocrCandidates: ['src/foo.ts'] })),
    { action: 'ask', token: 'a'.repeat(32), sourceKind: 'none', width: 10, height: 20, ocrCandidates: ['src/foo.ts'] },
  )
  assert.throws(() => parseCaptureResponse({ action: 'nope' }), /unsupported capture action/)
})

test('names screenshots with a timestamp', () => {
  const { captureFileName } = loadClient().__internals
  assert.equal(captureFileName(new Date(2026, 10, 23, 17, 15, 0)), 'quote-shot-20261123-171500.png')
})

test('rejects malformed capture responses', () => {
  const { parseCaptureResponse } = loadClient().__internals
  assert.throws(() => parseCaptureResponse({ action: 'ask', token: 'abc' }), /unsupported capture action/)
  assert.throws(() => parseCaptureResponse({ action: 'ask', token: 'z'.repeat(32) }), /unsupported capture action/)
  assert.throws(() => parseCaptureResponse({ action: 'save' }), /unsupported capture action/)
  assert.throws(() => parseCaptureResponse({ action: 'save', path: '   ' }), /unsupported capture action/)
  assert.throws(() => parseCaptureResponse({ action: 'save', path: 42 }), /unsupported capture action/)
  assert.throws(() => parseCaptureResponse({ action: 'error' }), /unsupported capture action/)
  assert.throws(() => parseCaptureResponse(null), /unsupported capture action/)
})

test('sanitizes known save, cancel, and error responses', () => {
  const { parseCaptureResponse } = loadClient().__internals
  assert.deepEqual(
    plain(parseCaptureResponse({ action: 'save', path: 'C:\\Users\\me\\shot.png' })),
    { action: 'save', path: 'C:\\Users\\me\\shot.png' },
  )
  assert.deepEqual(plain(parseCaptureResponse({ action: 'cancel' })), { action: 'cancel' })
  assert.deepEqual(
    plain(parseCaptureResponse({ action: 'error', message: 'capture failed' })),
    { action: 'error', message: 'capture failed' },
  )
})

test('sanitizes optional ask fields', () => {
  const { parseCaptureResponse } = loadClient().__internals
  assert.deepEqual(
    plain(parseCaptureResponse({
      action: 'ask',
      token: 'B'.repeat(32),
      sourceKind: 'file',
      width: 0,
      height: 12.5,
      ocrCandidates: ['a', '', 3, 'b', 'c', 'd', 'e', 'f'],
    })),
    { action: 'ask', token: 'B'.repeat(32), sourceKind: 'file', height: 12.5, ocrCandidates: ['a', 'b', 'c', 'd', 'e'] },
  )
})

test('omits invalid optional capture fields and clamps strings', () => {
  const { buildCaptureRequest } = loadClient().__internals
  const long = 'a'.repeat(1200)
  assert.deepEqual(
    plain(buildCaptureRequest({
      windowRect: { x: -10, y: 20, width: 800, height: 600 },
      scaleFactor: 1.5,
      activeFile: { path: long, startLine: 0, endLine: 2.5, language: long, extra: 'ignored' },
      chat: { turn: '3', anchorKey: long, extra: 'ignored' },
    })),
    {
      dsh: {
        windowRect: { x: -10, y: 20, width: 800, height: 600 },
        scaleFactor: 1.5,
        activeFile: { path: 'a'.repeat(1000), language: 'a'.repeat(1000) },
        chat: { anchorKey: 'a'.repeat(1000) },
      },
    },
  )
  assert.deepEqual(
    plain(buildCaptureRequest({
      windowRect: { x: 1, y: 2, width: 3, height: 4 },
      scaleFactor: 2,
      activeFile: { startLine: 'not-a-line' },
      chat: {},
    })),
    { dsh: { windowRect: { x: 1, y: 2, width: 3, height: 4 }, scaleFactor: 2 } },
  )
})

test('names screenshots with a zero-padded local timestamp', () => {
  const { captureFileName } = loadClient().__internals
  assert.equal(captureFileName(new Date(2026, 0, 2, 3, 4, 5)), 'quote-shot-20260102-030405.png')
  assert.equal(captureFileName(new Date(2026, 8, 9, 8, 7, 6)), 'quote-shot-20260909-080706.png')
})

test('registers the capture command with desktop-only defaults', () => {
  const client = loadClient()
  const registered = []
  client.apply({
    get(name) {
      if (name !== 'shortcuts') return null
      return {
        register(definition) {
          registered.push(definition)
          return () => {}
        },
      }
    },
    effect(run) { run() },
  })

  const capture = registered.find((entry) => entry.id === 'quote-shot.capture')
  assert.ok(capture)
  assert.equal(capture.label(), '截图并附加到对话')
  assert.deepEqual(plain(capture.aliases), ['screenshot', '截图'])
  assert.deepEqual(plain(capture.defaults), {
    'desktop:windows': { code: 'KeyZ', modifiers: ['primary', 'alt'] },
  })
  assert.deepEqual(plain(capture.regions), ['page', 'editable'])
  assert.deepEqual(plain(capture.modals), [])
  const resolved = capture.resolve()
  assert.equal(resolved.status, 'handled')
  assert.equal(typeof resolved.run, 'function')
})

test('sanitizes source kinds and defaults unknown values to none', () => {
  const { parseCaptureResponse } = loadClient().__internals
  assert.equal(plain(parseCaptureResponse({ action: 'ask', token: 'c'.repeat(32), sourceKind: 'file' })).sourceKind, 'file')
  assert.equal(plain(parseCaptureResponse({ action: 'ask', token: 'c'.repeat(32), sourceKind: 'chat' })).sourceKind, 'chat')
  assert.equal(plain(parseCaptureResponse({ action: 'ask', token: 'c'.repeat(32) })).sourceKind, 'none')
  assert.equal(plain(parseCaptureResponse({ action: 'ask', token: 'c'.repeat(32), sourceKind: 'other' })).sourceKind, 'none')
})

test('sanitizes and caps save paths and error messages', () => {
  const { parseCaptureResponse } = loadClient().__internals
  assert.deepEqual(
    plain(parseCaptureResponse({ action: 'save', path: '  C:\\a.png  ' })),
    { action: 'save', path: 'C:\\a.png' },
  )
  assert.equal(parseCaptureResponse({ action: 'save', path: 'x'.repeat(5000) }).path.length, 4096)
  assert.deepEqual(
    plain(parseCaptureResponse({ action: 'error', message: '  failed  ' })),
    { action: 'error', message: 'failed' },
  )
  assert.throws(() => parseCaptureResponse({ action: 'error', message: '   ' }), /unsupported capture action/)
})

test('whitelists finite positive source rects and drops invalid ones', () => {
  const { buildCaptureRequest } = loadClient().__internals
  assert.deepEqual(
    plain(buildCaptureRequest({
      windowRect: { x: 1, y: 2, width: -3, height: 0 },
      scaleFactor: 1,
      activeFile: { path: 'a.ts', rect: { x: 10, y: 20, width: 30, height: 40, extra: 1 } },
      chat: { turn: 1, rect: { x: 'bad', y: 0, width: 10, height: 10 } },
    })),
    {
      dsh: {
        windowRect: { x: 1, y: 2, width: 0, height: 0 },
        scaleFactor: 1,
        activeFile: { path: 'a.ts', rect: { x: 10, y: 20, width: 30, height: 40 } },
        chat: { turn: 1 },
      },
    },
  )
})

test('captures an ask image, attaches it, inserts OCR source, and discards', async () => {
  const fake = fakeFetch({
    capture: {
      action: 'ask',
      token: 'c'.repeat(32),
      sourceKind: 'none',
      ocrCandidates: ['C:\\work\\a.ts:9'],
    },
  })
  const client = loadClient({ fetch: fake.fetch, File: FakeFile })
  const composer = fakeComposer('a')
  client.__internals.__setActiveComposer(composer)

  await client.__internals.startCapture()

  const urls = fake.calls.map((call) => call.url)
  assert.ok(urls.includes('/quote-shot/api/health'))
  assert.ok(urls.includes('/quote-shot/api/capture'))
  assert.ok(urls.includes('/quote-shot/api/image/' + 'c'.repeat(32)))
  assert.ok(urls.includes('/quote-shot/api/discard'))
  assert.ok(composer.events.some((event) => event[0] === 'createDrafts' && event[1] === 'session-a'))
  assert.ok(composer.events.some((event) => event[0] === 'addAttachments'))
  const insertion = composer.events.find((event) => event[0] === 'insertText')
  assert.ok(insertion)
  assert.match(insertion[1], /^【截图来源】自动识别：C:\\work\\a\.ts:9\n$/)
})

test('releases drafts and discards when addAttachments refuses', async () => {
  const fake = fakeFetch({
    capture: { action: 'ask', token: 'd'.repeat(32), sourceKind: 'none' },
  })
  const client = loadClient({ fetch: fake.fetch, File: FakeFile })
  const composer = fakeComposer('a', { added: false })
  client.__internals.__setActiveComposer(composer)

  await client.__internals.startCapture()

  assert.ok(composer.events.some((event) => event[0] === 'createDrafts'))
  assert.ok(composer.events.some((event) => event[0] === 'releaseDrafts'))
  assert.equal(composer.events.some((event) => event[0] === 'insertText'), false)
  assert.ok(fake.calls.some((call) => call.url === '/quote-shot/api/discard'))
})

test('discards when the image request fails and never inserts a source', async () => {
  const fake = fakeFetch({
    image: false,
    capture: { action: 'ask', token: 'e'.repeat(32), sourceKind: 'file' },
  })
  const client = loadClient({ fetch: fake.fetch, File: FakeFile })
  const composer = fakeComposer('a')
  client.__internals.__setActiveComposer(composer)

  await client.__internals.startCapture()

  assert.equal(composer.events.some((event) => event[0] === 'addAttachments'), false)
  assert.equal(composer.events.some((event) => event[0] === 'insertText'), false)
  assert.ok(fake.calls.some((call) => call.url === '/quote-shot/api/discard'))
})

test('does not call capture when the desktop health check fails', async () => {
  const fake = fakeFetch({ health: null })
  const client = loadClient({ fetch: fake.fetch, File: FakeFile })
  client.__internals.__setActiveComposer(fakeComposer('a'))

  await client.__internals.startCapture()

  assert.equal(fake.calls.some((call) => call.url === '/quote-shot/api/capture'), false)
})

test('handles cancel, save, and error responses without attaching', async () => {
  const cases = [
    { response: { action: 'cancel' }, expected: null },
    { response: { action: 'save', path: 'C:\\Users\\me\\shot.png' }, expected: '已保存到 C:\\Users\\me\\shot.png' },
    { response: { action: 'error', message: 'capture failed' }, expected: 'capture failed' },
  ]
  for (const entry of cases) {
    const doc = fakeToastDocument()
    const fake = fakeFetch({ capture: entry.response })
    const client = loadClient({
      fetch: fake.fetch,
      File: FakeFile,
      document: doc,
      setTimeout: () => 0,
      clearTimeout: () => {},
    })
    const composer = fakeComposer('a')
    client.__internals.__setActiveComposer(composer)

    await client.__internals.startCapture()

    assert.equal(composer.events.some((event) => event[0] === 'addAttachments'), false)
    assert.equal(fake.calls.some((call) => call.url.startsWith('/quote-shot/api/image/')), false)
    if (entry.expected) {
      assert.equal(doc.elements[doc.elements.length - 1].textContent, entry.expected)
    }
  }
})

test('a second trigger while capturing does not start another capture POST', async () => {
  const calls = []
  let releaseCapture
  let started
  const startedPromise = new Promise((resolve) => { started = resolve })
  const fetch = async (url, options = {}) => {
    calls.push({ url, options })
    if (url === '/quote-shot/api/health') return jsonResponse({ ok: true })
    if (url === '/quote-shot/api/capture') {
      started()
      return new Promise((resolve) => {
        releaseCapture = () => resolve(jsonResponse({ action: 'cancel' }))
      })
    }
    return jsonResponse({})
  }
  const client = loadClient({ fetch, File: FakeFile })
  client.__internals.__setActiveComposer(fakeComposer('a'))

  const first = client.__internals.startCapture()
  await startedPromise
  const second = client.__internals.startCapture()
  await second
  releaseCapture()
  await first

  assert.equal(calls.filter((call) => call.url === '/quote-shot/api/capture').length, 1)
})

test('insertion failure keeps the attachment and still discards', async () => {
  const doc = fakeToastDocument()
  const fake = fakeFetch({
    capture: {
      action: 'ask',
      token: 'f'.repeat(32),
      sourceKind: 'none',
      ocrCandidates: ['C:\\work\\a.ts'],
    },
  })
  const client = loadClient({
    fetch: fake.fetch,
    File: FakeFile,
    document: doc,
    setTimeout: () => 0,
    clearTimeout: () => {},
  })
  const composer = fakeComposer('a', { inserted: false })
  client.__internals.__setActiveComposer(composer)

  await client.__internals.startCapture()

  assert.ok(composer.events.some((event) => event[0] === 'addAttachments'))
  assert.equal(composer.events.some((event) => event[0] === 'releaseDrafts'), false)
  assert.ok(fake.calls.some((call) => call.url === '/quote-shot/api/discard'))
  assert.equal(doc.elements[doc.elements.length - 1].textContent, '图片已附加，但来源未能插入')
})

test('pins the capture session and skips insertion after a session switch', async () => {
  let releaseCapture
  let started
  const startedPromise = new Promise((resolve) => { started = resolve })
  const fetch = async (url) => {
    if (url === '/quote-shot/api/health') return jsonResponse({ ok: true })
    if (url === '/quote-shot/api/capture') {
      started()
      return new Promise((resolve) => {
        releaseCapture = () => resolve(jsonResponse({
          action: 'ask',
          token: 'a'.repeat(32),
          sourceKind: 'none',
          ocrCandidates: ['C:\\work\\a.ts'],
        }))
      })
    }
    if (url.startsWith('/quote-shot/api/image/')) return blobResponse({ size: 12 })
    return jsonResponse({})
  }
  const client = loadClient({ fetch, File: FakeFile })
  const composerA = fakeComposer('a')
  const composerB = fakeComposer('b')
  client.__internals.__setActiveComposer(composerA)

  const pending = client.__internals.startCapture()
  await startedPromise
  client.__internals.__setActiveComposer(composerB)
  releaseCapture()
  await pending

  assert.ok(composerA.events.some((event) => event[0] === 'createDrafts' && event[1] === 'session-a'))
  assert.ok(composerA.events.some((event) => event[0] === 'addAttachments'))
  assert.equal(composerA.events.some((event) => event[0] === 'insertText'), false)
  assert.deepEqual(composerB.events, [])
})

test('keeps source insertion when the same session re-renders', async () => {
  let releaseCapture
  let started
  const startedPromise = new Promise((resolve) => { started = resolve })
  const fetch = async (url) => {
    if (url === '/quote-shot/api/health') return jsonResponse({ ok: true })
    if (url === '/quote-shot/api/capture') {
      started()
      return new Promise((resolve) => {
        releaseCapture = () => resolve(jsonResponse({
          action: 'ask',
          token: 'b'.repeat(32),
          sourceKind: 'none',
          ocrCandidates: ['C:\\work\\a.ts'],
        }))
      })
    }
    if (url.startsWith('/quote-shot/api/image/')) return blobResponse({ size: 12 })
    return jsonResponse({})
  }
  const client = loadClient({ fetch, File: FakeFile })
  const composerA = fakeComposer('a')
  client.__internals.__setActiveComposer(composerA)

  const pending = client.__internals.startCapture()
  await startedPromise
  // CameraButton assigns a new object on every render. The session did not
  // change, so this must not suppress source insertion.
  client.__internals.__setActiveComposer({ ...composerA, inputActions: composerA.inputActions })
  releaseCapture()
  await pending

  assert.ok(composerA.events.some((event) => event[0] === 'createDrafts' && event[1] === 'session-a'))
  assert.ok(composerA.events.some((event) => event[0] === 'addAttachments'))
  const insertion = composerA.events.find((event) => event[0] === 'insertText')
  assert.ok(insertion)
  assert.match(insertion[1], /^【截图来源】自动识别：C:\\work\\a\.ts\n$/)
})

test('places a menu inside the viewport and flips at the edge', () => {
  const { placeMenu } = loadClient().__internals
  // Spread into the host realm: the client runs in a vm context, and
  // deepStrictEqual compares object prototypes across realms.
  assert.deepEqual(
    { ...placeMenu({ point: { x: 20, y: 20 }, menu: { width: 160, height: 80 }, viewport: { width: 800, height: 600 } }) },
    { left: 22, top: 22 },
  )
  assert.deepEqual(
    { ...placeMenu({ point: { x: 780, y: 590 }, menu: { width: 160, height: 80 }, viewport: { width: 800, height: 600 } }) },
    { left: 632, top: 512 },
  )
  assert.deepEqual(
    { ...placeMenu({ point: { x: -40, y: -30 }, menu: { width: 160, height: 80 }, viewport: { width: 800, height: 600 } }) },
    { left: 8, top: 8 },
  )
})
