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
