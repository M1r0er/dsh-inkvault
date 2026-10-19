/**
 * Integration tests for VaultStore against a real temporary vault.
 * Run with: node --test test/store.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { VaultStore } from '../src/store.js'
import { VaultPathError } from '../src/paths.js'
import { coerceEntry, hashText, parseDocument, stringifyDocument } from '../src/frontmatter.js'

const ID_RE = /^m-\d{8}-[a-z0-9]{6}$/

/**
 * Create one temporary vault root that is removed when the test ends.
 * @param {import('node:test').TestContext} t - test context.
 * @param {object} [storeOptions] - extra VaultStore constructor options.
 * @returns {Promise<{ root: string, store: VaultStore }>} vault handles.
 */
async function makeVault(t, storeOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkvault-'))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  const store = new VaultStore({ root, ...storeOptions })
  t.after(async () => {
    await store.close()
  })
  return { root, store }
}

/**
 * Controllable clock so timestamps are deterministic.
 * @param {string} [startIso] - initial instant.
 * @returns {{ now: () => Date, clock: () => number, advance: (ms: number) => void, iso: string }} clock helpers.
 */
function fakeTime(startIso = '2026-10-19T10:00:00.000Z') {
  let current = new Date(startIso)
  return {
    now: () => new Date(current.getTime()),
    clock: () => current.getTime(),
    advance(ms) {
      current = new Date(current.getTime() + ms)
    },
    get iso() {
      return current.toISOString()
    },
  }
}

/** Absolute path of a vault-relative entry path. */
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

/** Read and parse the append-only journal. */
async function readJournal(root) {
  const text = await fs.readFile(path.join(root, '.inkvault', 'journal.jsonl'), 'utf8')
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('init creates the layout, writes a valid index and is idempotent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkvault-'))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  const store = new VaultStore({ root })
  // The constructor performs no IO.
  assert.equal(await exists(path.join(root, 'memory')), false)
  await store.init()

  assert.equal(store.root, path.resolve(root))
  for (const dir of ['memory', '.inkvault', '.inkvault/quarantine', '.trash']) {
    assert.equal((await fs.stat(path.join(root, dir))).isDirectory(), true, dir)
  }
  const raw = JSON.parse(await fs.readFile(path.join(root, '.inkvault', 'index.json'), 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(typeof raw.builtAt, 'number')
  assert.deepEqual(raw.entries, [])
  assert.equal(raw.search.version, 1)

  const journal = await readJournal(root)
  assert.equal(journal.length, 1)
  assert.equal(journal[0].op, 'rebuild')

  await store.init() // a second init must not rebuild
  assert.equal((await readJournal(root)).length, 1)
})

test('writeEntry persists Markdown and returns an EntryRecord', async (t) => {
  const time = fakeTime()
  const { root, store } = await makeVault(t, time)
  await store.init()

  const record = await store.writeEntry({
    meta: {
      kind: 'preference',
      title: '回答语言',
      tags: ['preference', 'language'],
      confidence: 0.8,
      source: 'capture',
      origin: 'sess-1',
    },
    body: '用户偏好：回答用中文。',
  })

  assert.match(record.meta.id, ID_RE)
  assert.equal(record.path, `memory/${record.meta.id}.md`)
  assert.equal(record.meta.created, time.iso)
  assert.equal(record.meta.updated, time.iso)
  assert.equal(record.meta.hash, hashText(record.body))
  assert.deepEqual(record.meta.tags, ['preference', 'language'])
  assert.equal(record.meta.origin, 'sess-1')

  const disk = await fs.readFile(absOf(root, record.path), 'utf8')
  const parsed = parseDocument(disk)
  assert.equal(parsed.meta.id, record.meta.id)
  assert.equal(parsed.meta.title, '回答语言')
  assert.equal(parsed.meta.source, 'capture')
  assert.equal(parsed.body, '用户偏好：回答用中文。')

  assert.deepEqual(await store.getEntry(record.meta.id), record)
  assert.deepEqual(await store.listEntries(), [record])
  assert.equal(await store.getEntry('not-an-id'), undefined)
  assert.equal(await store.getEntry('m-20261019-ABCDEF'), undefined)
  assert.equal(await store.getEntry(undefined), undefined)

  const writes = (await readJournal(root)).filter((line) => line.op === 'write')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].id, record.meta.id)
  assert.equal(writes[0].path, record.path)
  assert.equal(typeof writes[0].ts, 'number')
})

test('writeEntry preserves created for an existing id and bumps updated', async (t) => {
  const time = fakeTime()
  const { store } = await makeVault(t, time)
  await store.init()

  const first = await store.writeEntry({ meta: { kind: 'fact', title: 'one' }, body: 'first body' })
  time.advance(60_000)
  const second = await store.writeEntry({
    meta: { ...first.meta, created: '2000-01-01T00:00:00.000Z', title: 'two' },
    body: 'second body',
  })

  assert.equal(second.meta.id, first.meta.id)
  assert.equal(second.meta.created, first.meta.created)
  assert.equal(second.meta.updated, time.iso)
  assert.notEqual(second.meta.updated, first.meta.updated)
  assert.equal(second.meta.hash, hashText('second body'))
  assert.equal((await store.listEntries()).length, 1)
})

test('writeEntry normalizes unnormalized metadata', async (t) => {
  const { store } = await makeVault(t)
  await store.init()

  const record = await store.writeEntry({
    meta: { kind: 'nonsense', tags: 'a, b', confidence: '0.8' },
    body: '# 标题\n\n正文',
  })
  assert.equal(record.meta.kind, 'fact')
  assert.equal(record.meta.status, 'active')
  assert.deepEqual(record.meta.tags, ['a', 'b'])
  assert.equal(record.meta.confidence, 0.8)
  assert.equal(record.meta.title, '标题')
  assert.equal(record.meta.source, 'manual')
  assert.equal(record.meta.hash, hashText('# 标题\n\n正文'))
})

test('writeEntry allocates distinct ids for separate notes under a frozen clock', async (t) => {
  const time = fakeTime()
  const { store } = await makeVault(t, time)
  await store.init()

  const a = await store.writeEntry({ body: 'first note' })
  const b = await store.writeEntry({ body: 'second note' })
  assert.match(a.meta.id, ID_RE)
  assert.match(b.meta.id, ID_RE)
  assert.notEqual(a.meta.id, b.meta.id)
  assert.equal((await store.listEntries()).length, 2)
})

test('listEntries orders by updated descending, then id ascending', async (t) => {
  const time = fakeTime()
  const { store } = await makeVault(t, time)
  await store.init()

  const a = await store.writeEntry({ body: 'alpha' })
  time.advance(1000)
  const b = await store.writeEntry({ body: 'bravo' })
  time.advance(1000)
  const c = await store.writeEntry({ body: 'charlie' })
  assert.deepEqual((await store.listEntries()).map((entry) => entry.meta.id), [c.meta.id, b.meta.id, a.meta.id])

  // Equal `updated` falls back to id ordering.
  const time2 = fakeTime('2026-10-20T10:00:00.000Z')
  const second = await makeVault(t, time2)
  await second.store.init()
  const x = await second.store.writeEntry({ body: 'same time x' })
  const y = await second.store.writeEntry({ body: 'same time y' })
  const expected = [x.meta.id, y.meta.id].sort()
  assert.deepEqual((await second.store.listEntries()).map((entry) => entry.meta.id), expected)
})

test('search ranks hits, defaults to active+pending and supports status/kind/limit filters', async (t) => {
  const time = fakeTime()
  const { store } = await makeVault(t, time)
  await store.init()

  const preference = await store.writeEntry({
    meta: { kind: 'preference', title: '语言偏好' },
    body: '回答用中文',
  })
  time.advance(1000)
  const fact = await store.writeEntry({
    meta: { kind: 'fact', title: '中文项目' },
    body: '项目使用中文文档',
  })
  time.advance(1000)
  const archived = await store.writeEntry({
    meta: { kind: 'fact', status: 'archived', title: '中文归档' },
    body: '归档的中文笔记',
  })

  const hits = await store.search('中文')
  assert.deepEqual(new Set(hits.map((hit) => hit.entry.meta.id)), new Set([preference.meta.id, fact.meta.id]))
  assert.equal(hits.some((hit) => hit.entry.meta.id === archived.meta.id), false)
  for (let i = 1; i < hits.length; i += 1) assert.ok(hits[i - 1].score >= hits[i].score)
  assert.equal(typeof hits[0].entry.body, 'string')
  assert.equal(hits[0].entry.path.endsWith('.md'), true)

  const byKind = await store.search('中文', { kinds: ['preference'] })
  assert.deepEqual(byKind.map((hit) => hit.entry.meta.id), [preference.meta.id])

  const archivedHits = await store.search('中文', { statuses: ['archived'] })
  assert.deepEqual(archivedHits.map((hit) => hit.entry.meta.id), [archived.meta.id])

  assert.equal((await store.search('中文', { limit: 1 })).length, 1)
  assert.equal((await store.search('中文', { limit: 0 })).length, 0)
  assert.deepEqual(await store.search('...'), [])
  assert.deepEqual(await store.search('不存在的词'), [])
})

test('a reopened store loads entries from the cached index', async (t) => {
  const time = fakeTime()
  const { root, store } = await makeVault(t, time)
  await store.init()
  await store.writeEntry({ meta: { kind: 'project', title: '项目约定' }, body: '本仓库使用中文注释' })
  time.advance(1000)
  await store.writeEntry({ meta: { kind: 'fact', title: '事实' }, body: 'Node 24 已安装' })

  const expected = await store.listEntries()
  const reopened = new VaultStore({ root, now: time.now, clock: time.clock })
  await reopened.init()
  assert.deepEqual(await reopened.listEntries(), expected)
  assert.equal((await reopened.search('中文')).length, 1)
  // Index was reused: only the first store's rebuild is in the journal.
  assert.deepEqual((await readJournal(root)).map((line) => line.op).filter((op) => op === 'rebuild'), ['rebuild'])
})

test('reopening rebuilds when the index file is deleted', async (t) => {
  const { root, store } = await makeVault(t)
  await store.init()
  const record = await store.writeEntry({ meta: { kind: 'decision', title: '决策' }, body: '采用 Markdown 作为事实源' })
  const indexFile = path.join(root, '.inkvault', 'index.json')
  await fs.rm(indexFile)
  assert.equal(await exists(indexFile), false)

  const reopened = new VaultStore({ root })
  await reopened.init()
  assert.deepEqual(await reopened.listEntries(), [record])
  assert.equal(await exists(indexFile), true)
  assert.equal((await reopened.search('Markdown')).length, 1)
})

test('reopening rebuilds when a memory file is newer than builtAt', async (t) => {
  const { root, store } = await makeVault(t)
  await store.init()
  const record = await store.writeEntry({ meta: { kind: 'fact', title: '旧标题' }, body: '旧正文' })

  const target = absOf(root, record.path)
  const newMeta = { ...record.meta, title: '外部修改' }
  await fs.writeFile(target, stringifyDocument(newMeta, '新的正文'), 'utf8')
  const future = new Date(Date.now() + 120_000)
  await fs.utimes(target, future, future)

  const reopened = new VaultStore({ root })
  await reopened.init()
  const entry = await reopened.getEntry(record.meta.id)
  assert.equal(entry.meta.title, '外部修改')
  assert.equal(entry.body, '新的正文')
  assert.equal(entry.meta.hash, hashText('新的正文'))
})

test('a manually added memory file becomes an entry (Markdown is the source of truth)', async (t) => {
  const { root, store } = await makeVault(t)
  await store.init()
  await store.writeEntry({ body: '普通条目' })

  const externalMeta = coerceEntry(
    { id: 'm-20261019-abcdef', kind: 'reference', title: '外部条目', tags: ['external'] },
    '外部正文',
    { now: () => new Date('2026-10-19T10:00:00.000Z') },
  )
  await fs.writeFile(
    path.join(root, 'memory', 'm-20261019-abcdef.md'),
    stringifyDocument(externalMeta, '外部正文'),
    'utf8',
  )

  const reopened = new VaultStore({ root })
  await reopened.init()
  const entries = await reopened.listEntries()
  assert.equal(entries.length, 2)
  const external = entries.find((entry) => entry.meta.id === 'm-20261019-abcdef')
  assert.equal(external.meta.title, '外部条目')
  assert.equal(external.body, '外部正文')
  assert.deepEqual(external.meta.tags, ['external'])
})

test('archiveEntry moves the file to .trash and removes it from the index', async (t) => {
  const time = fakeTime()
  const { root, store } = await makeVault(t, time)
  await store.init()
  const record = await store.writeEntry({ meta: { kind: 'fact', title: '待归档' }, body: '可以归档的内容' })

  const archived = await store.archiveEntry(record.meta.id, 'unit test')
  assert.equal(archived.id, record.meta.id)
  assert.match(archived.trashPath, /^\.trash\/m-\d{8}-[a-z0-9]{6}-\d+\.md$/)
  assert.equal(await exists(absOf(root, archived.trashPath)), true)
  assert.equal(await exists(absOf(root, record.path)), false)
  assert.equal(await store.getEntry(record.meta.id), undefined)
  assert.deepEqual(await store.listEntries(), [])
  assert.deepEqual(await store.search('归档'), [])

  const archiveLines = (await readJournal(root)).filter((line) => line.op === 'archive')
  assert.equal(archiveLines.length, 1)
  assert.equal(archiveLines[0].id, record.meta.id)
  assert.equal(archiveLines[0].path, archived.trashPath)
  assert.equal(archiveLines[0].detail, 'unit test')

  assert.equal(await store.archiveEntry(record.meta.id), undefined)
  assert.equal(await store.archiveEntry('nope'), undefined)
})

test('rebuildIndex quarantines files with an unusable id', async (t) => {
  const { root, store } = await makeVault(t)
  await store.init()
  const valid = await store.writeEntry({ body: '正常条目' })
  await fs.writeFile(
    path.join(root, 'memory', 'broken.md'),
    '---\nid: not-a-valid-id\n---\nbroken body',
    'utf8',
  )

  const result = await store.rebuildIndex()
  assert.deepEqual(result.quarantined, ['memory/broken.md'])
  assert.equal(result.count, 1)
  assert.equal(await exists(path.join(root, 'memory', 'broken.md')), false)
  const quarantinedFiles = await fs.readdir(path.join(root, '.inkvault', 'quarantine'))
  assert.equal(quarantinedFiles.length, 1)
  assert.match(quarantinedFiles[0], /^broken-\d+\.md$/)
  assert.deepEqual((await store.listEntries()).map((entry) => entry.meta.id), [valid.meta.id])

  const quarantineLines = (await readJournal(root)).filter((line) => line.op === 'quarantine')
  assert.equal(quarantineLines.length, 1)
  assert.equal(typeof quarantineLines[0].path, 'string')
  assert.match(quarantineLines[0].detail, /id/)
})

test('rebuildIndex quarantines duplicate ids deterministically', async (t) => {
  const { root, store } = await makeVault(t)
  await store.init()
  const valid = await store.writeEntry({ body: '原始条目' })
  await fs.copyFile(absOf(root, valid.path), path.join(root, 'memory', 'zz-dupe.md'))

  const result = await store.rebuildIndex()
  assert.deepEqual(result.quarantined, ['memory/zz-dupe.md'])
  assert.equal(result.count, 1)
  const entries = await store.listEntries()
  assert.deepEqual(entries.map((entry) => entry.meta.id), [valid.meta.id])
})

test('a store initializing on a vault with a broken file quarantines it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkvault-'))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  await fs.mkdir(path.join(root, 'memory'), { recursive: true })
  const goodMeta = coerceEntry({ id: 'm-20261019-abcdef', title: '好文件' }, '好的正文', {
    now: () => new Date('2026-10-19T10:00:00.000Z'),
  })
  await fs.writeFile(path.join(root, 'memory', 'm-20261019-abcdef.md'), stringifyDocument(goodMeta, '好的正文'))
  await fs.writeFile(path.join(root, 'memory', 'no-frontmatter.md'), 'plain text without frontmatter')

  const store = new VaultStore({ root })
  await store.init()
  const entries = await store.listEntries()
  assert.deepEqual(entries.map((entry) => entry.meta.id), ['m-20261019-abcdef'])
  assert.equal(await exists(path.join(root, 'memory', 'no-frontmatter.md')), false)
  assert.equal((await fs.readdir(path.join(root, '.inkvault', 'quarantine'))).length, 1)
})

test('writeEntry honours an explicit path inside memory/ and rejects unsafe paths', async (t) => {
  const { root, store } = await makeVault(t)
  await store.init()

  const custom = await store.writeEntry({ path: 'memory/custom-note.md', body: '自定义路径' })
  assert.equal(custom.path, 'memory/custom-note.md')
  assert.equal(await exists(path.join(root, 'memory', 'custom-note.md')), true)
  assert.equal(parseDocument(await fs.readFile(path.join(root, 'memory', 'custom-note.md'), 'utf8')).body, '自定义路径')

  await assert.rejects(store.writeEntry({ path: '../escape.md', body: 'x' }), VaultPathError)
  await assert.rejects(store.writeEntry({ path: 'other/note.md', body: 'x' }), VaultPathError)
  await assert.rejects(
    store.writeEntry({ path: path.join(root, 'memory', 'absolute.md'), body: 'x' }),
    VaultPathError,
  )

  const withBackslashes = await store.writeEntry({ path: 'memory\\win-note.md', body: '反斜杠路径' })
  assert.equal(withBackslashes.path, 'memory/win-note.md')
  assert.equal(await exists(path.join(root, 'memory', 'win-note.md')), true)
})

test('journalRecord appends lines and swallows append failures', async (t) => {
  const { root, store } = await makeVault(t)
  await store.init()
  const journalPath = path.join(root, '.inkvault', 'journal.jsonl')

  await store.journalRecord({ ts: 123, op: 'write', id: 'm-20261019-abcdef', detail: 'manual' })
  const lines = await readJournal(root)
  assert.equal(lines.length, 2) // rebuild + manual
  assert.deepEqual(lines[1], { ts: 123, op: 'write', id: 'm-20261019-abcdef', detail: 'manual' })

  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    await fs.rm(journalPath)
    await fs.mkdir(journalPath) // a directory cannot be opened as an append target
    await assert.doesNotReject(store.journalRecord({ ts: 456, op: 'write' }))
  } finally {
    console.warn = originalWarn
    await fs.rmdir(journalPath)
  }
  assert.equal(warnings.length, 1)
})

test('index write failure does not make writeEntry throw', async (t) => {
  const { root, store } = await makeVault(t)
  await store.init()
  const indexFile = path.join(root, '.inkvault', 'index.json')
  await fs.rm(indexFile)
  await fs.mkdir(indexFile)

  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const record = await store.writeEntry({ body: '索引写失败仍可写入' })
    assert.match(record.meta.id, ID_RE)
    assert.equal(await exists(absOf(root, record.path)), true)
    assert.deepEqual(await store.getEntry(record.meta.id), record)
    assert.equal((await store.listEntries()).length, 1)
  } finally {
    console.warn = originalWarn
    await fs.rmdir(indexFile)
  }
  assert.ok(warnings.some((line) => line.includes('failed to save index')))
})

test('writeEntry works without an explicit init call', async (t) => {
  const { root, store } = await makeVault(t)
  const record = await store.writeEntry({ meta: { kind: 'task', title: '懒初始化' }, body: '无需显式 init' })
  assert.match(record.meta.id, ID_RE)
  assert.equal(await exists(path.join(root, 'memory')), true)
  assert.equal((await store.listEntries()).length, 1)
  await store.close()
})
