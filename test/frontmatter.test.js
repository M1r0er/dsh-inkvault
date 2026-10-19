/**
 * Unit tests for frontmatter parsing, serialization and normalization.
 * Run with: node --test test/frontmatter.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  ENTRY_KINDS,
  ENTRY_STATUSES,
  MAX_BODY_CHARS,
  parseDocument,
  stringifyDocument,
  coerceEntry,
  entryToMarkdown,
  hashText,
  makeEntryId,
  titleFromBody,
  parseDate,
} from '../src/frontmatter.js'

const HASH_RE = /^[0-9a-f]{16}$/
const ID_RE = /^m-\d{8}-[a-z0-9]{6}$/

/** A fully populated entry as used across the suites. */
const SAMPLE_META = {
  id: 'm-20261019-ab12cd',
  title: '用户偏好：回答用中文',
  kind: 'preference',
  status: 'active',
  created: '2026-10-19T10:00:00.000Z',
  updated: '2026-10-19T10:00:00.000Z',
  tags: ['preference', 'language'],
  confidence: 0.8,
  source: 'capture',
  hash: '0123456789abcdef',
  origin: '',
}
const SAMPLE_BODY = '正文 Markdown。'

test('vocabulary constants are frozen and match the contract', () => {
  assert.deepEqual([...ENTRY_KINDS], ['preference', 'fact', 'decision', 'project', 'reference', 'task'])
  assert.deepEqual([...ENTRY_STATUSES], ['active', 'pending', 'superseded', 'archived'])
  assert.equal(MAX_BODY_CHARS, 20000)
  assert.equal(Object.isFrozen(ENTRY_KINDS), true)
  assert.equal(Object.isFrozen(ENTRY_STATUSES), true)
})

test('parseDocument returns raw text when there is no frontmatter', () => {
  const text = '# Just a note\n\nwith a body.\n'
  const parsed = parseDocument(text)
  assert.deepEqual(parsed.meta, {})
  assert.equal(parsed.body, text)
  assert.deepEqual(parsed.issues, [])
})

test('parseDocument parses the contract example', () => {
  const text = [
    '---',
    'id: m-20261019-ab12cd',
    'title: 用户偏好：回答用中文',
    'kind: preference',
    'status: active',
    'created: 2026-10-19T10:00:00.000Z',
    'updated: 2026-10-19T10:00:00.000Z',
    'tags: [preference, language]',
    'confidence: 0.8',
    'source: capture',
    'hash: 0123456789abcdef',
    "origin: ''",
    '---',
    '',
    SAMPLE_BODY,
  ].join('\n')

  const { meta, body, issues } = parseDocument(text)
  assert.deepEqual(issues, [])
  assert.equal(meta.id, 'm-20261019-ab12cd')
  assert.equal(meta.title, '用户偏好：回答用中文')
  assert.equal(meta.kind, 'preference')
  assert.equal(meta.confidence, 0.8)
  assert.equal(meta.hash, '0123456789abcdef')
  assert.equal(meta.origin, '')
  assert.deepEqual(meta.tags, ['preference', 'language'])
  assert.equal(body, SAMPLE_BODY)
})

test('parseDocument handles null-ish values, quoting and inline arrays', () => {
  const text = [
    '---',
    'a: null',
    'b: ~',
    'c: window',
    'd: "quoted: value"',
    "e: 'single ''quoted'''",
    'f: [x, "y z", ,]',
    'g: true',
    'h: 42',
    'i:',
    '---',
    'body',
  ].join('\n')
  const { meta } = parseDocument(text)
  assert.equal(meta.a, '')
  assert.equal(meta.b, '')
  assert.equal(meta.c, '')
  assert.equal(meta.d, 'quoted: value')
  assert.equal(meta.e, "single 'quoted'")
  assert.deepEqual(meta.f, ['x', 'y z'])
  assert.equal(meta.g, true)
  assert.equal(meta.h, 42)
  assert.equal(meta.i, '')
})

test('parseDocument reports issues instead of throwing on unsupported YAML', () => {
  const text = [
    '---',
    'id: one',
    'id: two',
    'nested:',
    '  child: value',
    'block: |',
    '  line one',
    'not a key value line',
    '---',
    '',
    'body',
  ].join('\n')
  const { meta, body, issues } = parseDocument(text)
  assert.equal(meta.id, 'one') // first duplicate wins
  assert.equal(body, 'body')
  assert.ok(issues.length >= 3)
  assert.ok(issues.some((issue) => issue.includes('duplicate')))
  assert.ok(issues.some((issue) => issue.includes('nested')))
  assert.ok(issues.some((issue) => issue.includes('multi-line')))
})

test('parseDocument treats unterminated frontmatter as plain body', () => {
  const text = '---\nid: m-20261019-ab12cd\nno closing fence'
  const { meta, body, issues } = parseDocument(text)
  assert.deepEqual(meta, {})
  assert.equal(body, text)
  assert.equal(issues.length, 1)
})

test('parseDocument strips one leading blank line and the trailing newline of the body', () => {
  const text = '---\n---\n\n\nbody line\n'
  const { body } = parseDocument(text)
  assert.equal(body, '\nbody line')
})

test('stringifyDocument writes fixed key order, inline tags and no trailing body newline', () => {
  const markdown = stringifyDocument(SAMPLE_META, `${SAMPLE_BODY}\n`)
  const lines = markdown.split('\n')
  assert.equal(lines[0], '---')
  assert.deepEqual(
    lines.slice(1, 12).map((line) => line.slice(0, line.indexOf(':'))),
    ['id', 'title', 'kind', 'status', 'created', 'updated', 'tags', 'confidence', 'source', 'hash', 'origin'],
  )
  assert.ok(lines.includes('tags: [preference, language]'))
  assert.ok(lines.includes("origin: ''"))
  assert.ok(lines.includes('created: 2026-10-19T10:00:00.000Z'))
  assert.ok(markdown.endsWith(SAMPLE_BODY))
  assert.equal(markdown.endsWith('\n'), false)
})

test('stringifyDocument quotes values that would break the YAML subset', () => {
  const meta = { ...SAMPLE_META, title: 'Note: a # b', tags: ['with space', 'plain'] }
  const { meta: parsed } = parseDocument(stringifyDocument(meta, 'body'))
  assert.equal(parsed.title, 'Note: a # b')
  assert.deepEqual(parsed.tags, ['with space', 'plain'])
})

test('round-trips metadata and body through stringify/parse', () => {
  const body = '第一行\n\n- 第二行\n- 第三行'
  const markdown = stringifyDocument(SAMPLE_META, body)
  const parsed = parseDocument(markdown)
  assert.deepEqual(parsed.meta, SAMPLE_META)
  assert.equal(parsed.body, body)
  // A second round-trip is byte-identical.
  assert.equal(stringifyDocument(parsed.meta, parsed.body), markdown)
})

test('entryToMarkdown equals stringifyDocument', () => {
  assert.equal(entryToMarkdown({ meta: SAMPLE_META, body: SAMPLE_BODY }), stringifyDocument(SAMPLE_META, SAMPLE_BODY))
})

test('titleFromBody strips Markdown markers and caps length', () => {
  assert.equal(titleFromBody('\n\n##  A title  \n\nmore'), 'A title')
  assert.equal(titleFromBody('- bullet item'), 'bullet item')
  assert.equal(titleFromBody('> quoted line'), 'quoted line')
  assert.equal(titleFromBody('- [ ] task item'), 'task item')
  assert.equal(titleFromBody(''), '')
  assert.equal(titleFromBody('   \n\t\n'), '')
  assert.equal(titleFromBody('x'.repeat(300)).length, 120)
})

test('hashText is the 16-character lowercase sha256 prefix', () => {
  const expected = createHash('sha256').update('hello', 'utf8').digest('hex').slice(0, 16)
  assert.equal(hashText('hello'), expected)
  assert.match(hashText(''), HASH_RE)
  assert.equal(hashText('hello'), hashText('hello'))
})

test('makeEntryId matches the id pattern and honours now/seed', () => {
  const now = new Date(2026, 9, 19, 10, 0, 0)
  const id = makeEntryId(now, 'seed')
  assert.match(id, ID_RE)
  assert.ok(id.startsWith('m-20261019-'))
  assert.equal(makeEntryId(now, 'seed'), id)
  assert.notEqual(makeEntryId(now, 'other'), id)
})

test('parseDate accepts ISO strings and millisecond timestamps', () => {
  assert.equal(parseDate('2026-10-19T10:00:00.000Z').toISOString(), '2026-10-19T10:00:00.000Z')
  assert.equal(parseDate(0).toISOString(), '1970-01-01T00:00:00.000Z')
  assert.equal(parseDate(1729322400000).getTime(), 1729322400000)
  assert.equal(parseDate(new Date(5)).getTime(), 5)
  assert.equal(parseDate('not a date'), undefined)
  assert.equal(parseDate(''), undefined)
  assert.equal(parseDate(null), undefined)
  assert.equal(parseDate(new Date('invalid')), undefined)
})

test('coerceEntry fills contract defaults', () => {
  const now = () => new Date('2026-10-19T10:00:00.000Z')
  const meta = coerceEntry({}, '## 第一行标题\n\n正文', { now })
  assert.match(meta.id, ID_RE)
  assert.equal(meta.title, '第一行标题')
  assert.equal(meta.kind, 'fact')
  assert.equal(meta.status, 'active')
  assert.equal(meta.created, '2026-10-19T10:00:00.000Z')
  assert.equal(meta.updated, '2026-10-19T10:00:00.000Z')
  assert.deepEqual(meta.tags, [])
  assert.equal(meta.confidence, 0.5)
  assert.equal(meta.source, 'manual')
  assert.equal(meta.hash, hashText('## 第一行标题\n\n正文'))
  assert.equal(meta.origin, '')
  // Deterministic for the same clock and body.
  assert.equal(coerceEntry({}, '## 第一行标题\n\n正文', { now }).id, meta.id)
})

test('coerceEntry falls back on invalid values and records issues', () => {
  const issues = []
  const now = () => new Date('2026-10-19T10:00:00.000Z')
  const meta = coerceEntry({
    id: 'not-an-id',
    title: `  ${'长'.repeat(300)}  `,
    kind: 'nonsense',
    status: 'gone',
    created: 'not-a-real-date-###',
    updated: 1729322400000,
    tags: ['a', 'a', '', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'],
    confidence: 3,
    source: 'telepathy',
    hash: 'XYZ',
    origin: 'sess-1',
  }, 'body', { now, issues })

  assert.match(meta.id, ID_RE)
  assert.equal(meta.title.length, 120)
  assert.equal(meta.kind, 'fact')
  assert.equal(meta.status, 'active')
  assert.equal(meta.created, '2026-10-19T10:00:00.000Z')
  assert.equal(meta.updated, new Date(1729322400000).toISOString())
  assert.deepEqual(meta.tags, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'])
  assert.equal(meta.confidence, 1)
  assert.equal(meta.source, 'manual')
  assert.equal(meta.hash, hashText('body'))
  assert.equal(meta.origin, 'sess-1')
  assert.ok(issues.length >= 5)
})

test('coerceEntry clamps confidence and truncates oversized bodies', () => {
  const meta = coerceEntry({ confidence: -1 }, 'body', { now: () => new Date(0) })
  assert.equal(meta.confidence, 0)
  const longBody = 'x'.repeat(MAX_BODY_CHARS + 10)
  const issues = []
  const truncated = coerceEntry({}, longBody, { now: () => new Date(0), issues })
  assert.equal(truncated.hash, hashText(longBody.slice(0, MAX_BODY_CHARS)))
  assert.ok(issues.some((issue) => issue.includes('truncated')))
})

test('coerceEntry uses "Untitled" when no title can be derived', () => {
  const meta = coerceEntry({}, '   \n\n', { now: () => new Date(0) })
  assert.equal(meta.title, 'Untitled')
  assert.ok(meta.title.length > 0)
})
