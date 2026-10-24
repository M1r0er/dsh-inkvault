/**
 * Knowledge-profile behaviour: hand-written notes, incremental refresh,
 * title weighting, and filtered enumeration.
 * Run with: node --test test/knowledge.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { VaultStore } from '../src/store.js'
import { stringifyDocument } from '../src/frontmatter.js'

const ID_RE = /^m-\d{8}-[a-z0-9]{6}$/

/**
 * Create one temporary knowledge vault removed when the test ends.
 * @param {import('node:test').TestContext} t - test context.
 * @param {object} [storeOptions] - extra VaultStore constructor options.
 * @returns {Promise<{ root: string, store: VaultStore }>} vault handles.
 */
async function makeVault(t, storeOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkvault-kb-'))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  const store = new VaultStore({ root, profile: 'knowledge', ...storeOptions })
  t.after(async () => {
    await store.close()
  })
  return { root, store }
}

/**
 * Controllable clock so timestamps are deterministic.
 * @param {string} [startIso] - initial instant.
 * @returns {{ now: () => Date, clock: () => number, advance: (ms: number) => void }} clock helpers.
 */
function fakeTime(startIso = '2026-10-24T10:00:00.000Z') {
  let current = new Date(startIso)
  return {
    now: () => new Date(current.getTime()),
    clock: () => current.getTime(),
    advance(ms) {
      current = new Date(current.getTime() + ms)
    },
  }
}

/** Absolute path of a vault-relative path. */
function absOf(root, relative) {
  return path.join(root, ...relative.split('/'))
}

/** True when an absolute path exists. */
async function exists(absolute) {
  try {
    await fs.stat(absolute)
    return true
  } catch {
    return false
  }
}

test('a hand-written note without an id is adopted, not quarantined', async (t) => {
  const { root, store } = await makeVault(t)
  await store.init()
  const file = absOf(root, 'notes/读书笔记.md')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, '# 读书笔记\n\n随手写的内容\n', 'utf8')

  const summary = await store.rebuildIndex()
  assert.equal(summary.quarantined.length, 0)
  assert.equal(await exists(file), true, 'the author\'s file must stay where it is')
  assert.equal(await exists(absOf(root, '.inkvault/quarantine')), true)

  const notes = await store.listEntries()
  assert.equal(notes.length, 1)
  assert.match(notes[0].meta.id, ID_RE)
  assert.equal(notes[0].body.includes('随手写的内容'), true)
})

test('adoption assigns the same id on every rebuild', async (t) => {
  const { root, store } = await makeVault(t)
  await store.init()
  const file = absOf(root, 'notes/手工.md')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, '# 手工\n\n正文\n', 'utf8')

  await store.rebuildIndex()
  const first = (await store.listEntries())[0].meta.id
  const reopened = new VaultStore({ root, profile: 'knowledge' })
  t.after(async () => {
    await reopened.close()
  })
  await reopened.rebuildIndex()
  const second = (await reopened.listEntries())[0].meta.id
  assert.equal(second, first, 'a rebuild must not rename the note it adopted')
})

test('a daily-note filename keeps its date in the adopted id', async (t) => {
  const { root, store } = await makeVault(t)
  await store.init()
  const file = absOf(root, 'notes/2026-10-24.md')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, '# 十月二十四日\n\n日记\n', 'utf8')

  await store.rebuildIndex()
  const notes = await store.listEntries()
  assert.equal(notes[0].meta.id.startsWith('m-20261024-'), true, `expected the date marker, got ${notes[0].meta.id}`)
})

test('the memory profile still quarantines an invalid file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkvault-mem-'))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  const store = new VaultStore({ root })
  t.after(async () => {
    await store.close()
  })
  await store.init()
  const file = absOf(root, 'memory/坏文件.md')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, 'not a note at all', 'utf8')

  const summary = await store.rebuildIndex()
  assert.equal(summary.quarantined.length, 1)
  assert.equal(await exists(file), false, 'a broken memory file is moved out')
})

test('incremental refresh re-reads only the changed note', async (t) => {
  const time = fakeTime()
  const { root, store } = await makeVault(t, { now: time.now, clock: time.clock })
  await store.init()
  await store.writeEntry({ meta: { kind: 'reference', title: '第一条' }, body: '甲' })
  time.advance(1000)
  await store.writeEntry({ meta: { kind: 'reference', title: '第二条' }, body: '乙' })

  // Touch one note on disk behind the store's back.
  const listed = await store.listEntries()
  const first = listed.find((entry) => entry.meta.title === '第一条')
  const target = absOf(root, first.path)
  const original = await fs.readFile(target, 'utf8')
  await fs.writeFile(target, original.replace('第一条', '改过的标题'), 'utf8')

  const reopened = new VaultStore({ root, profile: 'knowledge', now: time.now, clock: time.clock })
  t.after(async () => {
    await reopened.close()
  })
  await reopened.init()
  const titles = (await reopened.listEntries()).map((entry) => entry.meta.title).sort()
  assert.deepEqual(titles, ['改过的标题', '第二条'])
})

test('an unchanged vault does not journal an incremental rebuild', async (t) => {
  const time = fakeTime()
  const { root, store } = await makeVault(t, { now: time.now, clock: time.clock })
  await store.init()
  await store.writeEntry({ meta: { kind: 'reference', title: '稳定' }, body: '不变' })

  const reopened = new VaultStore({ root, profile: 'knowledge', now: time.now, clock: time.clock })
  t.after(async () => {
    await reopened.close()
  })
  await reopened.init()
  const journal = await fs.readFile(absOf(root, '.inkvault/journal.jsonl'), 'utf8')
  assert.equal(journal.includes('incremental='), false, 'nothing changed, so nothing is re-indexed')
})

test('a note title outranks a body-only mention', async (t) => {
  const time = fakeTime()
  const { store } = await makeVault(t, { now: time.now, clock: time.clock })
  await store.init()
  await store.writeEntry({ meta: { kind: 'reference', title: '无关标题' }, body: '正文里提到一次 检索内核' })
  time.advance(1000)
  const titled = await store.writeEntry({ meta: { kind: 'reference', title: '检索内核' }, body: '正文不重复那个词' })

  const hits = await store.search('检索内核')
  assert.equal(hits[0].entry.meta.id, titled.meta.id, 'the note whose title matches must rank first')
})

test('an empty query enumerates a tag slice but stays empty without a filter', async (t) => {
  const time = fakeTime()
  const { store } = await makeVault(t, { now: time.now, clock: time.clock })
  await store.init()
  await store.writeEntry({ meta: { kind: 'reference', title: '甲', tags: ['dsh'] }, body: '一' })
  time.advance(1000)
  await store.writeEntry({ meta: { kind: 'reference', title: '乙', tags: ['other'] }, body: '二' })

  assert.deepEqual(await store.search(''), [], 'an unfiltered empty query has no meaning')
  const tagged = await store.search('', { tags: ['dsh'] })
  assert.equal(tagged.length, 1)
  assert.equal(tagged[0].entry.meta.title, '甲')
})

test('tags filter requires every requested tag', async (t) => {
  const time = fakeTime()
  const { store } = await makeVault(t, { now: time.now, clock: time.clock })
  await store.init()
  await store.writeEntry({ meta: { kind: 'reference', title: '双标签', tags: ['dsh', 'plugin'] }, body: '共同内容' })
  time.advance(1000)
  await store.writeEntry({ meta: { kind: 'reference', title: '单标签', tags: ['dsh'] }, body: '共同内容' })

  const both = await store.search('共同内容', { tags: ['dsh', 'plugin'] })
  assert.deepEqual(both.map((hit) => hit.entry.meta.title), ['双标签'])
})

test('a note written through writeEntry keeps its body and hash', async (t) => {
  const time = fakeTime()
  const { store } = await makeVault(t, { now: time.now, clock: time.clock })
  await store.init()
  const record = await store.writeEntry({ meta: { kind: 'reference', title: '完整' }, body: '正文内容' })

  const readBack = await store.getEntry(record.meta.id)
  assert.equal(readBack.body, '正文内容')
  assert.equal(readBack.meta.hash, record.meta.hash)
  assert.equal(readBack.meta.hash.length > 0, true)
})

test('a subfolder note is listed under its folder', async (t) => {
  const time = fakeTime()
  const { store } = await makeVault(t, { now: time.now, clock: time.clock })
  await store.init()
  await store.writeEntry({ meta: { kind: 'reference', title: '嵌套' }, body: '内容', path: 'notes/dsh-plugin/嵌套.md' })

  const listed = await store.listEntries({ folder: 'dsh-plugin' })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].meta.title, '嵌套')
  assert.deepEqual(await store.listEntries({ folder: 'other' }), [])
})

test('backlinks resolve by title as well as by id', async (t) => {
  const time = fakeTime()
  const { store } = await makeVault(t, { now: time.now, clock: time.clock })
  await store.init()
  const target = await store.writeEntry({ meta: { kind: 'reference', title: '被引用' }, body: '目标' })
  time.advance(1000)
  await store.writeEntry({
    meta: { kind: 'reference', title: '引用者', links: ['被引用'] },
    body: '见 [[被引用]]',
  })

  const backlinks = await store.backlinksOf(target.meta.id)
  assert.equal(backlinks.length, 1)
  assert.equal(backlinks[0].title, '引用者')
})

test('a hand-written note carrying frontmatter is parsed, not adopted blind', async (t) => {
  const { root, store } = await makeVault(t)
  await store.init()
  const file = absOf(root, 'notes/带元数据.md')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    stringifyDocument({ title: '带元数据', kind: 'decision', tags: ['dsh'] }, '正文内容'),
    'utf8',
  )

  await store.rebuildIndex()
  const notes = await store.listEntries()
  assert.equal(notes.length, 1)
  assert.equal(notes[0].meta.title, '带元数据')
  assert.equal(notes[0].meta.kind, 'decision')
  assert.deepEqual(notes[0].meta.tags, ['dsh'])
})
