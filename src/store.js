/**
 * InkVault storage: Markdown entries on disk, a derived index, and a journal.
 *
 * The Markdown files under `memory/` are the single source of truth. The
 * `.inkvault/index.json` file is only a derived cache (metadata snapshots plus
 * the serialized BM25 index) and may be deleted at any time; `init()` rebuilds
 * it whenever it is missing, corrupt, or older than any memory file.
 * @module dsh-inkvault/store
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  ensureDir,
  safeWriteAtomic,
  safeMove,
  listMarkdown,
  safeResolve,
  isInside,
  VaultPathError,
} from './paths.js'
import {
  MAX_BODY_CHARS,
  ENTRY_ID_PATTERN,
  coerceEntry,
  entryToMarkdown,
  hashText,
  makeEntryId,
  parseDocument,
} from './frontmatter.js'
import { buildIndex, serializeIndex, deserializeIndex, searchIndex } from './search.js'

/** Directory holding every entry Markdown file. */
const MEMORY_DIR = 'memory'

/** Reject anything that is not one plain folder name; fall back to `memory`. */
function normalizeContentDir(value) {
  if (typeof value !== 'string') return MEMORY_DIR
  const dir = value.trim()
  if (dir === '' || dir === '.' || dir === '..') return MEMORY_DIR
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dir)) return MEMORY_DIR
  return dir
}
/** Hidden plugin directory (index, journal, quarantine). */
const INK_DIR = '.inkvault'
/** Derived index file, relative to the vault root. */
const INDEX_FILE = '.inkvault/index.json'
/** Append-only audit journal, relative to the vault root. */
const JOURNAL_FILE = '.inkvault/journal.jsonl'
/** Quarantine directory for files that cannot be parsed. */
const QUARANTINE_DIR = '.inkvault/quarantine'
/** Reversible archive directory used by `archiveEntry`. */
const TRASH_DIR = '.trash'
/** Index file format version. */
const INDEX_VERSION = 1
/** Statuses returned by `search()` unless overridden. */
const DEFAULT_SEARCH_STATUSES = Object.freeze(['active', 'pending'])
/** Default number of search results. */
const DEFAULT_SEARCH_LIMIT = 8

/**
 * Normalize a relative path to forward slashes (the EntryRecord.path form).
 * @param {string} value - platform path or relative path.
 * @returns {string} normalized relative path.
 */
function normalizeRelative(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Resolve a relative vault path to an absolute one without touching the disk.
 * @param {string} root - absolute vault root.
 * @param {string} relative - normalized relative path.
 * @returns {string} absolute path.
 */
function toAbsolute(root, relative) {
  return path.resolve(root, ...normalizeRelative(relative).split('/'))
}

/**
 * Render one error for a warning message.
 * @param {unknown} error - thrown value.
 * @returns {string} message.
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the text indexed for one entry: title, tags and body.
 * @param {{ meta: object, body: string }} entry - entry record.
 * @returns {string} searchable text.
 */
function searchableText(entry) {
  const tags = Array.isArray(entry.meta.tags) ? entry.meta.tags.join(' ') : ''
  return [entry.meta.title, tags, entry.body].filter((part) => typeof part === 'string' && part !== '').join('\n')
}

/**
 * Copy an internal record into the public EntryRecord shape.
 * @param {{ meta: object, body: string, path: string }} entry - internal record.
 * @returns {{ meta: object, body: string, path: string }} detached EntryRecord.
 */
function toEntryRecord(entry) {
  return {
    meta: { ...entry.meta, tags: [...(entry.meta.tags ?? [])] },
    body: entry.body,
    path: entry.path,
  }
}

/**
 * Compare two ids for deterministic ordering.
 * @param {string} a - left id.
 * @param {string} b - right id.
 * @returns {number} comparator result.
 */
function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * One vault backed by a directory. Construction performs no IO; call
 * {@link VaultStore#init} before using it (other methods do so lazily).
 */
export class VaultStore {
  /**
   * @param {{ root: string, contentDir?: string, now?: () => Date, clock?: () => number }} options - vault options.
   */
  constructor({ root, contentDir = MEMORY_DIR, now = () => new Date(), clock = () => Date.now() } = {}) {
    if (typeof root !== 'string' || root.trim() === '') throw new TypeError('VaultStore requires a root directory')
    this._root = path.resolve(root)
    this._contentDir = normalizeContentDir(contentDir)
    this._now = typeof now === 'function' ? now : () => new Date()
    this._clock = typeof clock === 'function' ? clock : () => Date.now()
    /** @type {Map<string, { meta: object, body: string, path: string, mtimeMs: number }>} */
    this._entries = new Map()
    /** @type {object|null} */
    this._search = null
    this._initialized = false
  }

  /** Absolute vault root. */
  get root() {
    return this._root
  }

  /** Entry folder under the root (`memory` or `notes`). */
  get contentDir() {
    return this._contentDir
  }

  /**
   * Create the vault layout and load or rebuild the index.
   * @returns {Promise<this>} this store.
   */
  async init() {
    if (this._initialized) return this
    await this._ensureLayout()
    const loaded = await this._loadIndex()
    if (loaded !== null) {
      this._entries = loaded.entries
      this._search = loaded.search
      this._initialized = true
      return this
    }
    await this.rebuildIndex()
    return this
  }

  /**
   * Load the cached index when it is valid and fresh, otherwise return null.
   * @returns {Promise<{ entries: Map<string, object>, search: object }|null>} loaded state.
   */
  async _loadIndex() {
    let raw
    try {
      raw = JSON.parse(await fs.readFile(toAbsolute(this._root, INDEX_FILE), 'utf8'))
    } catch {
      return null
    }
    if (raw === null || typeof raw !== 'object' || raw.version !== INDEX_VERSION) return null
    if (!Array.isArray(raw.entries) || typeof raw.builtAt !== 'number' || !Number.isFinite(raw.builtAt)) return null
    const search = deserializeIndex(raw.search)
    if (search === undefined) return null

    let files
    try {
      files = (await listMarkdown(this._root, this._contentDir)).map(normalizeRelative)
    } catch {
      return null
    }
    if (files.length !== raw.entries.length) return null

    const byPath = new Map()
    for (const record of raw.entries) {
      if (record === null || typeof record !== 'object') return null
      if (typeof record.path !== 'string' || typeof record.body !== 'string') return null
      if (record.meta === null || typeof record.meta !== 'object') return null
      if (!ENTRY_ID_PATTERN.test(String(record.meta.id ?? ''))) return null
      byPath.set(normalizeRelative(record.path), record)
    }

    const entries = new Map()
    for (const relative of files) {
      const record = byPath.get(relative)
      if (record === undefined) return null
      let stat
      try {
        stat = await fs.stat(toAbsolute(this._root, relative))
      } catch {
        return null
      }
      // Contract staleness rule: any memory file newer than builtAt expires it.
      if (stat.mtimeMs > raw.builtAt) return null
      const meta = coerceEntry(record.meta, record.body, { now: this._now })
      if (meta.id !== record.meta.id || entries.has(meta.id)) return null
      entries.set(meta.id, { meta, body: record.body, path: relative, mtimeMs: stat.mtimeMs })
    }
    return { entries, search }
  }

  /** Create every directory the vault needs. */
  async _ensureLayout() {
    await ensureDir(path.join(this._root, this._contentDir))
    await ensureDir(path.join(this._root, INK_DIR))
    await ensureDir(path.join(this._root, INK_DIR, 'quarantine'))
    await ensureDir(path.join(this._root, TRASH_DIR))
  }

  /** Rebuild the in-memory BM25 index from the current entry map. */
  _buildSearch() {
    const docs = []
    for (const [id, entry] of this._entries) docs.push({ id, text: searchableText(entry) })
    return buildIndex(docs)
  }

  /**
   * Persist the index. Failures are warnings only: the index is derived state.
   * `builtAt` is never earlier than a memory-file mtime, so reloading the index
   * cannot mistake a freshly written entry for a stale cache.
   * @returns {Promise<void>} resolves even when the write failed.
   */
  async _saveIndex() {
    let builtAt = this._clock()
    for (const entry of this._entries.values()) {
      if (Number.isFinite(entry.mtimeMs) && entry.mtimeMs > builtAt) builtAt = entry.mtimeMs
    }
    const payload = {
      version: INDEX_VERSION,
      builtAt,
      entries: [...this._entries.values()].map((entry) => ({
        meta: entry.meta,
        body: entry.body,
        path: entry.path,
        mtimeMs: entry.mtimeMs,
      })),
      search: serializeIndex(this._search ?? buildIndex([])),
    }
    try {
      await safeWriteAtomic(this._root, INDEX_FILE, JSON.stringify(payload))
    } catch (error) {
      console.warn(`[inkvault] failed to save index: ${describeError(error)}`)
    }
  }

  /**
   * Move an unparseable memory file into `.inkvault/quarantine/`.
   * @param {string} relative - memory-relative path of the original file.
   * @returns {Promise<string>} quarantine-relative path.
   */
  async _quarantine(relative) {
    const stem = path.basename(relative, '.md').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'file'
    let target = `${QUARANTINE_DIR}/${stem}-${this._clock()}.md`
    let counter = 0
    while (await fileExists(toAbsolute(this._root, target))) {
      counter += 1
      target = `${QUARANTINE_DIR}/${stem}-${this._clock()}-${counter}.md`
    }
    await safeMove(this._root, relative, target)
    return target
  }

  /**
   * List all entries, newest `updated` first, then by id.
   * @returns {Promise<Array<{ meta: object, body: string, path: string }>>} entries.
   */
  async listEntries() {
    await this.ensureIndex()
    return [...this._entries.values()]
      .sort((a, b) => {
        if (a.meta.updated !== b.meta.updated) return a.meta.updated < b.meta.updated ? 1 : -1
        return compareIds(a.meta.id, b.meta.id)
      })
      .map(toEntryRecord)
  }

  /**
   * Read one entry by id.
   * @param {string} id - entry id.
   * @returns {Promise<{ meta: object, body: string, path: string }|undefined>} entry, if present.
   */
  async getEntry(id) {
    await this.ensureIndex()
    if (typeof id !== 'string') return undefined
    const normalized = id.trim()
    if (!ENTRY_ID_PATTERN.test(normalized)) return undefined
    const entry = this._entries.get(normalized)
    return entry === undefined ? undefined : toEntryRecord(entry)
  }

  /**
   * Rank entries against a query.
   * @param {string} query - search query.
   * @param {{ limit?: number, statuses?: string[], kinds?: string[]|null }} [options] - filters.
   * @returns {Promise<Array<{ entry: { meta: object, body: string, path: string }, score: number }>>} hits.
   */
  async search(query, options = {}) {
    await this.ensureIndex()
    const config = options !== null && typeof options === 'object' ? options : {}

    const rawLimit = config.limit === undefined ? DEFAULT_SEARCH_LIMIT : Number(config.limit)
    const limit = Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.floor(rawLimit) : DEFAULT_SEARCH_LIMIT
    if (limit === 0) return []

    const statuses = Array.isArray(config.statuses)
      ? config.statuses.map(String)
      : [...DEFAULT_SEARCH_STATUSES]
    const kinds = Array.isArray(config.kinds) && config.kinds.length > 0
      ? new Set(config.kinds.map(String))
      : null

    if (this._search === null) return []
    const hits = searchIndex(this._search, query, { limit: Infinity })
    const results = []
    for (const hit of hits) {
      if (results.length >= limit) break
      const entry = this._entries.get(hit.id)
      if (entry === undefined) continue
      if (!statuses.includes(entry.meta.status)) continue
      if (kinds !== null && !kinds.has(entry.meta.kind)) continue
      results.push({ entry: toEntryRecord(entry), score: hit.score })
    }
    return results
  }

  /**
   * Normalize and validate an optional entry path, requiring it under `memory/`.
   * @param {unknown} value - caller-provided path.
   * @returns {Promise<string>} normalized memory-relative path.
   */
  async _memoryRelativePath(value) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new VaultPathError('entry path must be a non-empty string')
    }
    const relative = normalizeRelative(value.trim())
    const absolute = await safeResolve(this._root, relative)
    if (!isInside(path.resolve(this._root, this._contentDir), absolute)) {
      throw new VaultPathError(`entry path must stay inside ${this._contentDir}/: ${value}`)
    }
    return relative
  }

  /**
   * Write one entry (create or update) and refresh memory, index and journal.
   * @param {{ meta?: object, body?: string, path?: string }} input - entry input.
   * @returns {Promise<{ meta: object, body: string, path: string }>} stored record.
   */
  async writeEntry(input = {}) {
    await this.ensureIndex()
    const source = input !== null && typeof input === 'object' ? input : {}
    const rawMeta = source.meta !== null && typeof source.meta === 'object' && !Array.isArray(source.meta)
      ? source.meta
      : {}
    let body = typeof source.body === 'string' ? source.body : ''
    if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS)

    const nowDate = this._now()
    const safeNow = nowDate instanceof Date && !Number.isNaN(nowDate.getTime()) ? nowDate : new Date()
    const nowIso = safeNow.toISOString()

    let id = typeof rawMeta.id === 'string' ? rawMeta.id.trim() : ''
    if (!ENTRY_ID_PATTERN.test(id)) {
      // Allocate a collision-free id; the body hash seeds variation when the
      // injected clock is frozen (tests, imports, replay).
      const seed = hashText(body)
      id = makeEntryId(safeNow, seed)
      let attempt = 0
      while (this._entries.has(id) && attempt < 100) {
        attempt += 1
        id = makeEntryId(safeNow, `${seed}#${attempt}`)
      }
    }

    const existing = this._entries.get(id)
    const meta = coerceEntry({ ...rawMeta, id }, body, { now: this._now })
    meta.id = id
    if (existing !== undefined) meta.created = existing.meta.created
    meta.updated = nowIso
    meta.hash = hashText(body)

    let relative
    if (source.path === undefined || source.path === null) {
      relative = `${this._contentDir}/${id}.md`
    } else {
      relative = await this._memoryRelativePath(source.path)
    }

    // Write the Markdown first: a failed write must leave the index untouched.
    const markdown = entryToMarkdown({ meta, body })
    await safeWriteAtomic(this._root, relative, markdown)
    let mtimeMs = this._clock()
    try {
      mtimeMs = (await fs.stat(toAbsolute(this._root, relative))).mtimeMs
    } catch {
      // Keep the clock fallback; the file was just written successfully.
    }

    const stored = { meta, body, path: relative, mtimeMs }
    this._entries.set(id, stored)
    this._search = this._buildSearch()
    await this._saveIndex()
    await this.journalRecord({ ts: this._clock(), op: 'write', id, path: relative })
    return toEntryRecord(stored)
  }

  /**
   * Move one entry into `.trash/` and drop it from the index.
   * @param {string} id - entry id.
   * @param {string} [reason] - journal detail.
   * @returns {Promise<{ id: string, trashPath: string }|undefined>} archive result, or undefined when absent.
   */
  async archiveEntry(id, reason = '') {
    await this.ensureIndex()
    if (typeof id !== 'string') return undefined
    const normalized = id.trim()
    if (!ENTRY_ID_PATTERN.test(normalized)) return undefined
    const entry = this._entries.get(normalized)
    if (entry === undefined) return undefined

    const trashPath = `${TRASH_DIR}/${normalized}-${this._clock()}.md`
    await safeMove(this._root, entry.path, trashPath)
    this._entries.delete(normalized)
    this._search = this._buildSearch()
    await this._saveIndex()
    await this.journalRecord({
      ts: this._clock(),
      op: 'archive',
      id: normalized,
      path: trashPath,
      detail: String(reason ?? ''),
    })
    return { id: normalized, trashPath }
  }

  /**
   * Scan `memory/`, quarantine unparseable files, and rebuild the BM25 index.
   * @returns {Promise<{ count: number, quarantined: string[] }>} rebuild summary.
   */
  async rebuildIndex() {
    await this._ensureLayout()
    let files = []
    try {
      files = (await listMarkdown(this._root, this._contentDir)).map(normalizeRelative).sort()
    } catch (error) {
      console.warn(`[inkvault] failed to list ${this._contentDir}/: ${describeError(error)}`)
    }

    const entries = new Map()
    const quarantined = []
    for (const relative of files) {
      const absolute = toAbsolute(this._root, relative)
      try {
        const text = await fs.readFile(absolute, 'utf8')
        const parsed = parseDocument(text)
        const stem = path.basename(relative, '.md')
        const metaId = typeof parsed.meta.id === 'string' ? parsed.meta.id.trim() : ''
        let id = ''
        if (ENTRY_ID_PATTERN.test(metaId)) id = metaId
        else if (ENTRY_ID_PATTERN.test(stem)) id = stem
        if (id === '') throw new Error(`entry id missing or invalid in ${relative}`)
        if (entries.has(id)) throw new Error(`duplicate entry id ${id} in ${relative}`)

        const meta = coerceEntry({ ...parsed.meta, id }, parsed.body, { now: this._now })
        meta.id = id
        // The body is the source of truth, so the content hash follows it.
        meta.hash = hashText(parsed.body)
        const stat = await fs.stat(absolute)
        entries.set(id, { meta, body: parsed.body, path: relative, mtimeMs: stat.mtimeMs })
      } catch (error) {
        try {
          const quarantinePath = await this._quarantine(relative)
          quarantined.push(relative)
          await this.journalRecord({
            ts: this._clock(),
            op: 'quarantine',
            path: quarantinePath,
            detail: describeError(error),
          })
        } catch (moveError) {
          console.warn(`[inkvault] failed to quarantine ${relative}: ${describeError(moveError)}`)
        }
      }
    }

    this._entries = entries
    this._search = this._buildSearch()
    await this._saveIndex()
    await this.journalRecord({
      ts: this._clock(),
      op: 'rebuild',
      detail: `count=${entries.size};quarantined=${quarantined.length}`,
    })
    this._initialized = true
    return { count: entries.size, quarantined }
  }

  /**
   * Lazily initialize the store; a ready store returns immediately.
   * @returns {Promise<void>} resolves once the index is ready.
   */
  async ensureIndex() {
    if (this._initialized) return
    await this.init()
  }

  /**
   * Append one JSON line to the journal. Failures never propagate.
   * @param {object} record - journal record (caller supplies `ts`).
   * @returns {Promise<void>} resolves even when the append failed.
   */
  async journalRecord(record) {
    try {
      const absolute = await safeResolve(this._root, JOURNAL_FILE)
      await ensureDir(path.dirname(absolute))
      const handle = await fs.open(absolute, 'a')
      try {
        await handle.write(`${JSON.stringify(record ?? {})}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (error) {
      console.warn(`[inkvault] failed to append journal: ${describeError(error)}`)
    }
  }

  /** Release resources. Reserved by the contract; currently a no-op. */
  async close() {}
}

/**
 * Check whether a path exists (any file type).
 * @param {string} absolute - absolute path.
 * @returns {Promise<boolean>} true when it exists.
 */
async function fileExists(absolute) {
  try {
    await fs.access(absolute)
    return true
  } catch {
    return false
  }
}
