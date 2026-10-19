/**
 * Unit tests for the tokenizer, BM25 index and index serialization.
 * Run with: node --test test/search.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tokenize,
  buildIndex,
  searchIndex,
  serializeIndex,
  deserializeIndex,
} from '../src/search.js'

test('tokenize lowercases ASCII words and drops single characters/punctuation', () => {
  assert.deepEqual(tokenize('Hello, WORLD! a b c'), ['hello', 'world'])
  assert.deepEqual(tokenize('  ...!!!  '), [])
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize(null), [])
  assert.deepEqual(tokenize('Node.js v24'), ['node', 'js', 'v24'])
})

test('tokenize splits CJK runs into 2-grams and keeps lone characters', () => {
  assert.deepEqual(tokenize('中文测试'), ['中文', '文测', '测试'])
  assert.deepEqual(tokenize('中'), ['中'])
  assert.deepEqual(tokenize('我喜欢中文'), ['我喜', '喜欢', '欢中', '中文'])
})

test('tokenize deduplicates while preserving first-seen order', () => {
  assert.deepEqual(tokenize('Apple apple banana APPLE'), ['apple', 'banana'])
  assert.deepEqual(tokenize('中文 中文测试'), ['中文', '文测', '测试'])
})

test('buildIndex records lengths, document frequencies and term frequencies', () => {
  const index = buildIndex([
    { id: 'd1', text: 'alpha beta' },
    { id: 'd2', text: 'alpha gamma' },
  ])
  assert.equal(index.version, 1)
  assert.equal(index.N, 2)
  assert.equal(index.avgdl, 2)
  assert.deepEqual(index.docs, { d1: { len: 2 }, d2: { len: 2 } })
  assert.equal(index.df.alpha, 2)
  assert.equal(index.df.beta, 1)
  assert.equal(index.postings.alpha.d1, 1)
  assert.equal(index.postings.alpha.d2, 1)
})

test('buildIndex is safe for empty and malformed input', () => {
  assert.deepEqual(buildIndex([]), { version: 1, N: 0, avgdl: 0, docs: {}, df: {}, postings: {} })
  assert.deepEqual(buildIndex(null), { version: 1, N: 0, avgdl: 0, docs: {}, df: {}, postings: {} })
  const filtered = buildIndex([{ id: 'ok', text: 'alpha' }, { text: 'no id' }, null])
  assert.deepEqual(Object.keys(filtered.docs), ['ok'])
})

test('searchIndex ranks rarer terms higher and applies length normalization', () => {
  const index = buildIndex([
    { id: 'd1', text: 'alpha beta gamma delta' },
    { id: 'd2', text: 'alpha beta' },
    { id: 'd3', text: 'beta' },
  ])
  const hits = searchIndex(index, 'alpha')
  assert.deepEqual(hits.map((hit) => hit.id), ['d2', 'd1'])
  // Both contain alpha once; the shorter document wins because of b=0.75.
  assert.ok(hits[0].score > hits[1].score)
})

test('searchIndex matches the BM25 formula exactly', () => {
  const index = buildIndex([
    { id: 'd1', text: 'alpha beta' },
    { id: 'd2', text: 'alpha gamma' },
  ])
  // df=2, N=2, tf=1, dl=2, avgdl=2 -> idf=ln(1.2), denominator=2.2, score=ln(1.2)
  const expected = Number(Math.log(1.2).toFixed(6))
  const hits = searchIndex(index, 'alpha')
  assert.equal(hits.length, 2)
  assert.deepEqual(hits.map((hit) => hit.id), ['d1', 'd2']) // deterministic tie-break by id
  assert.equal(hits[0].score, expected)
  assert.equal(hits[0].score, hits[1].score)
})

test('searchIndex returns rounded scores and respects limit', () => {
  const docs = Array.from({ length: 10 }, (_, index) => ({ id: `d${index}`, text: 'common token' }))
  const index = buildIndex(docs)
  const all = searchIndex(index, 'common', { limit: 100 })
  assert.equal(all.length, 10)
  for (const hit of all) {
    assert.equal(hit.score, Number(hit.score.toFixed(6)))
    assert.ok(hit.score > 0)
  }
  assert.equal(searchIndex(index, 'common').length, 8) // default limit
  assert.equal(searchIndex(index, 'common', { limit: 3 }).length, 3)
  assert.equal(searchIndex(index, 'common', { limit: 0 }).length, 0)
})

test('searchIndex returns [] for empty input, empty index or tokenless query', () => {
  const index = buildIndex([{ id: 'd1', text: 'alpha' }])
  assert.deepEqual(searchIndex(index, '...'), [])
  assert.deepEqual(searchIndex(index, ''), [])
  assert.deepEqual(searchIndex(buildIndex([]), 'alpha'), [])
  assert.deepEqual(searchIndex(null, 'alpha'), [])
  assert.deepEqual(searchIndex({ N: 0 }, 'alpha'), [])
})

test('searchIndex ignores query terms absent from the index', () => {
  const index = buildIndex([{ id: 'd1', text: 'alpha' }])
  assert.deepEqual(searchIndex(index, 'missing'), [])
  assert.deepEqual(searchIndex(index, 'missing alpha').map((hit) => hit.id), ['d1'])
})

test('serializeIndex produces a plain JSON object and does not alias the index', () => {
  const index = buildIndex([{ id: 'd1', text: 'alpha beta' }, { id: 'd2', text: 'gamma' }])
  const raw = serializeIndex(index)
  assert.deepEqual(raw, {
    version: 1,
    N: 2,
    avgdl: 1.5,
    docs: { d1: { len: 2 }, d2: { len: 1 } },
    df: { alpha: 1, beta: 1, gamma: 1 },
    postings: { alpha: { d1: 1 }, beta: { d1: 1 }, gamma: { d2: 1 } },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), raw)
  raw.docs.d1.len = 99
  assert.equal(index.docs.d1.len, 2)
})

test('deserializeIndex round-trips a serialized index', () => {
  const index = buildIndex([
    { id: 'd1', text: 'alpha beta' },
    { id: 'd2', text: 'alpha gamma 中文测试' },
  ])
  const restored = deserializeIndex(JSON.parse(JSON.stringify(serializeIndex(index))))
  assert.deepEqual(restored, serializeIndex(index))
  assert.deepEqual(
    searchIndex(restored, 'alpha').map((hit) => [hit.id, hit.score]),
    searchIndex(index, 'alpha').map((hit) => [hit.id, hit.score]),
  )
})

test('deserializeIndex rejects invalid or foreign payloads', () => {
  assert.equal(deserializeIndex(undefined), undefined)
  assert.equal(deserializeIndex(null), undefined)
  assert.equal(deserializeIndex([]), undefined)
  assert.equal(deserializeIndex({}), undefined)
  assert.equal(deserializeIndex({ version: 2, N: 0, avgdl: 0, docs: {}, df: {}, postings: {} }), undefined)
  assert.equal(deserializeIndex({ version: 1, N: 0, avgdl: 0, docs: [], df: {}, postings: {} }), undefined)
  assert.equal(deserializeIndex({ version: 1, N: 'x', avgdl: 0, docs: {}, df: {}, postings: {} }), undefined)
  assert.equal(deserializeIndex({ version: 1, N: 1, avgdl: 1, docs: { d: { len: 'x' } }, df: {}, postings: {} }), undefined)
})

test('searchIndex handles CJK queries', () => {
  const index = buildIndex([
    { id: 'zh', text: '我喜欢中文回答' },
    { id: 'en', text: 'english only' },
  ])
  const hits = searchIndex(index, '中文')
  assert.deepEqual(hits.map((hit) => hit.id), ['zh'])
  assert.deepEqual(searchIndex(index, '英文'), [])
})
