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
    '来源：对话第 3 轮\n\n````md\n```\ninside\n```\n````',
  )
})

test('uses chat turn labels and omits missing source lines', () => {
  const { formatSourceLabel, formatQuote } = loadClient().__internals
  assert.equal(formatSourceLabel({ kind: 'chat', turn: 3 }), '对话第 3 轮')
  assert.equal(formatSourceLabel({ kind: 'file', path: 'src/a.ts' }), 'src/a.ts')
  assert.equal(formatQuote({ text: 'hi' }), '> hi')
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
})
