/**
 * Unit tests for the directive lane (channel B): escaping, rendering, and the
 * active/prompt-only filter with its refuse-instead-of-truncate rule.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DIRECTIVE_TAG,
  MAX_DIRECTIVE_CHARS,
  escapePromptBraces,
  renderDirectiveBlock,
  buildDirectiveText,
} from '../src/prompt.js'

/** One vault entry as `store.listEntries()` returns it. */
function entry(overrides = {}, body = '正文') {
  return {
    meta: {
      id: 'm-20261019-ab12cd',
      title: '标题',
      kind: 'preference',
      status: 'active',
      delivery: 'prompt',
      ...overrides,
    },
    body,
  }
}

test('escapePromptBraces breaks the {{ interpolation anchor and is idempotent', () => {
  assert.equal(escapePromptBraces('a{{b}}c'), 'a{ {b}}c')
  assert.equal(escapePromptBraces('{{x}} {{y}}'), '{ {x}} { {y}}')
  // Already-escaped input is left alone: no single { pair survives to re-split.
  assert.equal(escapePromptBraces('a{ {b}}c'), 'a{ {b}}c')
  // Single braces and closing braces are untouched.
  assert.equal(escapePromptBraces('{a} }}'), '{a} }}')
  assert.equal(escapePromptBraces(''), '')
  assert.equal(escapePromptBraces(undefined), '')
  assert.equal(escapePromptBraces(null), '')
  assert.equal(escapePromptBraces(42), '42')
})

test('renderDirectiveBlock puts fixed declarations outside the body', () => {
  const block = renderDirectiveBlock('BODY-LINE')
  assert.ok(block.startsWith(`<${DIRECTIVE_TAG} trust="user-declared">`))
  assert.ok(block.endsWith(`</${DIRECTIVE_TAG}>`))
  assert.ok(block.includes('\n\nBODY-LINE\n'))
  // The declaration sentences are constant and precede the body.
  assert.ok(block.indexOf('显式声明为「长期约定」') < block.indexOf('BODY-LINE'))
  assert.ok(block.includes('以当前消息为准'))
})

test('buildDirectiveText returns null when nothing qualifies', () => {
  assert.equal(buildDirectiveText([]), null)
  assert.equal(buildDirectiveText(undefined), null)
  assert.equal(buildDirectiveText([entry({ delivery: 'recall' })]), null)
  assert.equal(buildDirectiveText([entry({ status: 'pending' })]), null)
  assert.equal(buildDirectiveText([entry({ status: 'archived' })]), null)
  assert.equal(buildDirectiveText([{ meta: null, body: 'x' }]), null)
  assert.equal(buildDirectiveText([null]), null)
})

test('buildDirectiveText renders active prompt entries with id and full body', () => {
  const long = 'x'.repeat(500)
  const built = buildDirectiveText([
    entry({ id: 'm-20261019-aaaaaa', title: '规则 A' }, long),
    entry({ id: 'm-20261019-bbbbbb', title: '规则 B' }, '短正文'),
  ])
  assert.equal(built.count, 2)
  // Body is kept whole — no 160-character snippet like the recall lane.
  assert.ok(built.text.includes(long))
  assert.ok(built.text.includes('### 规则 A (m-20261019-aaaaaa)'))
  assert.ok(built.text.includes('### 规则 B (m-20261019-bbbbbb)'))
  // Everything went through the brace escape.
  assert.ok(!built.text.includes('{{'))
})

test('buildDirectiveText mixes lanes correctly and skips the rest', () => {
  const built = buildDirectiveText([
    entry({ id: 'm-20261019-aaaaaa', title: '要' }),
    entry({ id: 'm-20261019-bbbbbb', title: '不要', delivery: 'recall' }),
    entry({ id: 'm-20261019-cccccc', title: '待定', status: 'pending' }),
  ])
  assert.equal(built.count, 1)
  assert.ok(built.text.includes('要 (m-20261019-aaaaaa)'))
  assert.ok(!built.text.includes('不要'))
  assert.ok(!built.text.includes('待定'))
})

test('buildDirectiveText refuses an oversized block instead of truncating', () => {
  const built = buildDirectiveText([entry({}, 'y'.repeat(MAX_DIRECTIVE_CHARS + 10))])
  assert.equal(built.text, null)
  assert.equal(built.count, 1)
  assert.equal(built.maxChars, MAX_DIRECTIVE_CHARS)
  assert.ok(built.overflow > MAX_DIRECTIVE_CHARS)
})

test('buildDirectiveText honours a custom maxChars and tolerates junk options', () => {
  // Custom limit low enough to overflow: refused, and the limit is echoed back.
  const tight = buildDirectiveText([entry({}, 'z'.repeat(400))], { maxChars: 300 })
  assert.equal(tight.text, null)
  assert.equal(tight.maxChars, 300)
  // Junk limits fall back to the default instead of disabling the guard.
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'big', null, undefined]) {
    const built = buildDirectiveText([entry({}, 'short')], { maxChars: bad })
    assert.notEqual(built.text, null, `maxChars=${String(bad)} should fall back, not refuse`)
  }
  // A fractional limit is floored, not rounded up.
  const floored = buildDirectiveText([entry({}, 'y'.repeat(MAX_DIRECTIVE_CHARS))], { maxChars: MAX_DIRECTIVE_CHARS + 0.9 })
  assert.equal(floored.text, null)
  assert.equal(floored.maxChars, MAX_DIRECTIVE_CHARS)
})

test('buildDirectiveText escapes braces coming from the user body', () => {
  const built = buildDirectiveText([entry({ title: 'tpl' }, 'use {{name}} here')])
  assert.ok(built.text.includes('use { {name}} here'))
  assert.ok(!built.text.includes('{{'))
})

test('buildDirectiveText normalizes a blank title and a missing id', () => {
  const built = buildDirectiveText([entry({ id: '', title: '  spaced   out  ' }, 'b')])
  assert.ok(built.text.includes('### spaced out\nb'))
})
