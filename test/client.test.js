import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function loadClient() {
  let registration
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registration = r } } },
    console,
  }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox)
  return registration.factory(() => { throw new Error('unexpected top-level require') })
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
    { action: 'ask', token: 'a'.repeat(32), width: 10, height: 20, ocrCandidates: ['src/foo.ts'] },
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
      width: 0,
      height: 12.5,
      ocrCandidates: ['a', '', 3, 'b', 'c', 'd', 'e', 'f'],
    })),
    { action: 'ask', token: 'B'.repeat(32), height: 12.5, ocrCandidates: ['a', 'b', 'c', 'd', 'e'] },
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
