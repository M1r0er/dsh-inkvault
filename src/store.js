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
  MAX_LINKS,
  MAX_TAGS,
  coerceEntry,
  entryToMarkdown,
  extractLinks,
  extractTags,
  hashText,
  makeEntryId,
  parseDocument,
} from './frontmatter.js'
import { buildIndex, serializeIndex, deserializeIndex, searchIndex, tokenize } from './search.js'

/** Directory holding every entry Markdown file in a memory vault. */
const MEMORY_DIR = 'memory'
/** Directory holding every entry Markdown file in a knowledge vault. */
const NOTES_DIR = 'notes'

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
 * Deterministic id for a hand-written note that carries no canonical id.
 *
 * `makeEntryId` embeds the clock, which is right for a new capture but wrong
 * here: the knowledge vault is a folder the user edits directly, so the same
 * file must resolve to the same id on every rebuild. The id is derived from the
 * file's vault-relative path only, which keeps it stable across body edits and
 * unique per file.
 * @param {string} relative - normalized vault-relative path.
 * @returns {string} canonical entry id.
 */
function adoptedId(relative) {
  const digest = hashText(`adopt\u0000${normalizeRelative(relative)}`)
  const stem = String(path.basename(relative, '.md'))
  // Obsidian daily notes are named `2026-10-24` or `20261024`; accept both so an
  // adopted note sorts with its real date instead of the epoch marker.
  const date = stem.match(/(?:^|\D)(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?:\D|$)/)
  const day = date === null ? '19700101' : `${date[1]}${date[2]}${date[3]}`
  return `m-${day}-${digest.slice(0, 6)}`
}

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
/** How many times a title repeats in the indexed text (title-term weighting). */
const TITLE_WEIGHT = 3

function searchableText(entry) {
  const tags = Array.isArray(entry.meta.tags) ? entry.meta.tags.join(' ') : ''
  const title = typeof entry.meta.title === 'string' ? entry.meta.title : ''
  // A note's title is the strongest signal of what it is about, so it is
  // repeated in the indexed text. BM25's length normalization partly absorbs
  // the extra length, keeping short titles from dominating the whole corpus.
  const repeated = title === '' ? [] : new Array(TITLE_WEIGHT).fill(title)
  return [...repeated, tags, entry.body].filter((part) => typeof part === 'string' && part !== '').join('\n')
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
 * Merge two string lists case-insensitively, keeping the first occurrence.
 * @param {unknown} base - primary list (frontmatter values).
 * @param {unknown} extra - secondary list (body-derived values).
 * @param {number} cap - maximum merged length.
 * @returns {string[]} merged list.
 */
function mergeLists(base, extra, cap) {
  const merged = []
  const seen = new Set()
  for (const source of [base, extra]) {
    if (!Array.isArray(source)) continue
    for (const item of source) {
      if (typeof item !== 'string') continue
      const value = item.trim()
      if (value === '') continue
      const key = value.toLowerCase()
      if (seen.has(key)) continue
      if (merged.length >= cap) return merged
      seen.add(key)
      merged.push(value)
    }
  }
  return merged
}

/**
 * The subfolder of one entry path, relative to the content directory.
 * @param {string} relativePath - entry path.
 * @param {string} contentDir - content directory name.
 * @returns {string} folder ('' means directly under the content directory).
 */
function folderOfPath(relativePath, contentDir) {
  const relative = normalizeRelative(relativePath)
  const prefix = `${contentDir}/`
  const rest = relative.startsWith(prefix) ? relative.slice(prefix.length) : relative
  const slash = rest.lastIndexOf('/')
  return slash === -1 ? '' : rest.slice(0, slash)
}

/**
 * One vault backed by a directory. Construction performs no IO; call
 * {@link VaultStore#init} before using it (other methods do so lazily).
 */
export class VaultStore {
  /**
   * @param {{ root: string, contentDir?: string, profile?: string, now?: () => Date, clock?: () => number }} options - vault options.
   */
  constructor({ root, contentDir, profile = 'memory', now = () => new Date(), clock = () => Date.now() } = {}) {
    if (typeof root !== 'string' || root.trim() === '') throw new TypeError('VaultStore requires a root directory')
    this._root = path.resolve(root)
    this._profile = profile === 'knowledge' ? 'knowledge' : 'memory'
    // The profile decides the default content folder: a knowledge vault keeps
    // notes in `notes/`, a memory vault in `memory/`. Callers may still pass an
    // explicit contentDir, which wins.
    this._contentDir = normalizeContentDir(contentDir ?? (this._profile === 'knowledge' ? NOTES_DIR : MEMORY_DIR))
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

  /** Metadata profile this vault uses (`memory` or `knowledge`). */
  get profile() {
    return this._profile
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
      if (!loaded.stale) {
        this._entries = loaded.entries
        this._search = loaded.search
        this._initialized = true
        return this
      }
      // The cached index is structurally valid but at least one note changed
      // since it was written. Re-read just those notes instead of the whole
      // vault; anything the refresh cannot vouch for falls back to a rebuild.
      const refreshed = await this._refreshEntries(loaded.entries, loaded.files)
      if (refreshed !== null) {
        this._entries = refreshed.entries
        this._search = this._buildSearch()
        await this._saveIndex()
        if (refreshed.changed > 0) {
          await this.journalRecord({
            ts: this._clock(),
            op: 'rebuild',
            detail: `incremental=${refreshed.changed}`,
          })
        }
        this._initialized = true
        return this
      }
    }
    await this.rebuildIndex()
    return this
  }
  /**
   * Load the cached index when it is structurally valid.
   *
   * `stale` reports whether any note file is newer than the index; a stale
   * index is still usable as a starting point for an incremental refresh, so
   * it is returned rather than discarded.
   * @returns {Promise<{ entries: Map<string, object>, search: object, files: Array<string>, stale: boolean }|null>} loaded state.
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
    let stale = false
    for (const relative of files) {
      const record = byPath.get(relative)
      if (record === undefined) return null
      let stat
      try {
        stat = await fs.stat(toAbsolute(this._root, relative))
      } catch {
        return null
      }
      // Any note newer than builtAt makes the cached state stale. The entries
      // stay usable — the incremental path re-reads exactly the changed files —
      // so this no longer forces a whole-vault rebuild.
      if (stat.mtimeMs > raw.builtAt) stale = true
      const meta = coerceEntry(record.meta, record.body, { now: this._now, profile: this._profile })
      if (meta.id !== record.meta.id || entries.has(meta.id)) return null
      // Keep the mtime the index was built from, not the one just observed:
      // the incremental refresh compares them to decide what to re-read.
      const recordedMtime = Number(record.mtimeMs)
      const mtimeMs = Number.isFinite(recordedMtime) ? recordedMtime : stat.mtimeMs
      if (mtimeMs !== stat.mtimeMs) stale = true
      entries.set(meta.id, { meta, body: record.body, path: relative, mtimeMs })
    }
    return { entries, search, files, stale }
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
   * @param {{ folder?: string, tags?: string[] }} [options] - filters.
   * @returns {Promise<Array<{ meta: object, body: string, path: string }>>} entries.
   */
  async listEntries(options = {}) {
    await this.ensureIndex()
    const config = options !== null && typeof options === 'object' ? options : {}
    const folder = typeof config.folder === 'string' ? normalizeRelative(config.folder).replace(/^\/+|\/+$/g, '') : ''
    const tags = Array.isArray(config.tags) ? config.tags.map((tag) => String(tag).toLowerCase()) : []
    const matched = []
    for (const entry of this._entries.values()) {
      if (folder !== '' && folderOfPath(entry.path, this._contentDir) !== folder) continue
      if (tags.length > 0) {
        const own = Array.isArray(entry.meta.tags) ? entry.meta.tags.map((tag) => String(tag).toLowerCase()) : []
        if (!tags.every((tag) => own.includes(tag))) continue
      }
      matched.push(entry)
    }
    return matched
      .sort((a, b) => {
        if (a.meta.updated !== b.meta.updated) return a.meta.updated < b.meta.updated ? 1 : -1
        return compareIds(a.meta.id, b.meta.id)
      })
      .map(toEntryRecord)
  }

  /**
   * Resolve every entry that links to `id` through its `links` list.
   *
   * A link target matches either the entry id or the note title (case
   * insensitive), which is how Obsidian resolves `[[Note title]]`.
   * @param {string} id - entry id.
   * @returns {Promise<Array<{ id: string, title: string }>>} backlinks.
   */
  async backlinksOf(id) {
    await this.ensureIndex()
    if (typeof id !== 'string') return []
    const target = this._entries.get(id.trim())
    if (target === undefined) return []
    const keys = new Set([String(target.meta.id).toLowerCase(), String(target.meta.title ?? '').toLowerCase()])
    keys.delete('')
    const backlinks = []
    for (const entry of this._entries.values()) {
      if (entry.meta.id === target.meta.id) continue
      const links = Array.isArray(entry.meta.links) ? entry.meta.links : []
      if (!links.some((link) => keys.has(String(link).toLowerCase()))) continue
      backlinks.push({ id: entry.meta.id, title: entry.meta.title })
    }
    backlinks.sort((a, b) => compareIds(a.id, b.id))
    return backlinks
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
   * @param {{ limit?: number, statuses?: string[], kinds?: string[]|null, tags?: string[], folder?: string }} [options] - filters.
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
    const tags = Array.isArray(config.tags) ? config.tags.map((tag) => String(tag).toLowerCase()) : []
    const folder = typeof config.folder === 'string' ? normalizeRelative(config.folder).replace(/^\/+|\/+$/g, '') : ''

    if (this._search === null) return []
    // An empty query carries no lexical signal. Returning every note would
    // silently change what `search('')` means, so an unfiltered empty query
    // stays empty. A caller that supplies a tag/folder slice ("everything
    // tagged #x") does get the enumeration it asked for.
    const tokens = tokenize(query)
    if (tokens.length === 0 && tags.length === 0 && folder === '') return []
    const hits = tokens.length === 0
      ? [...this._entries.values()].map((entry) => ({ id: entry.meta.id, score: 0 }))
      : searchIndex(this._search, query, { limit: Infinity })
    const results = []
    for (const hit of hits) {
      if (results.length >= limit) break
      const entry = this._entries.get(hit.id)
      if (entry === undefined) continue
      // The knowledge profile has no lifecycle: every note is always live.
      if (this._profile !== 'knowledge' && !statuses.includes(entry.meta.status)) continue
      if (kinds !== null && !kinds.has(entry.meta.kind)) continue
      if (folder !== '' && folderOfPath(entry.path, this._contentDir) !== folder) continue
      if (tags.length > 0) {
        const own = Array.isArray(entry.meta.tags) ? entry.meta.tags.map((tag) => String(tag).toLowerCase()) : []
        if (!tags.every((tag) => own.includes(tag))) continue
      }
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
    const meta = coerceEntry({ ...rawMeta, id }, body, { now: this._now, profile: this._profile })
    meta.id = id
    if (existing !== undefined) meta.created = existing.meta.created
    meta.updated = nowIso
    meta.hash = hashText(body)

    // The knowledge profile derives tags and links from the body itself: an
    // Obsidian note written by hand is the source of truth, and a `#tag` or a
    // `[[link]]` typed into the body must survive the write even when the
    // caller supplied no frontmatter for it.
    if (this._profile === 'knowledge') {
      meta.tags = mergeLists(meta.tags, extractTags(body), MAX_TAGS)
      meta.links = mergeLists(meta.links, extractLinks(body), MAX_LINKS)
    }

    let relative
    if (source.path === undefined || source.path === null) {
      relative = `${this._contentDir}/${id}.md`
    } else {
      relative = await this._memoryRelativePath(source.path)
    }

    // Write the Markdown first: a failed write must leave the index untouched.
    const markdown = entryToMarkdown({ meta, body }, { profile: this._profile })
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
   * Read and normalize one entry file.
   *
   * Shared by the full rebuild and the incremental refresh so both paths agree
   * on id derivation, adoption and hashing.
   * @param {string} relative - content-relative path of the file.
   * @param {Set<string>} taken - ids already claimed by other files.
   * @returns {Promise<object>} entry record (`{ meta, body, path, mtimeMs }`).
   * @throws when the file cannot be read, parsed, or resolved to a unique id.
   */
  async _readEntryFile(relative, taken) {
    const absolute = toAbsolute(this._root, relative)
    const text = await fs.readFile(absolute, 'utf8')
    const parsed = parseDocument(text)
    const stem = path.basename(relative, '.md')
    const metaId = typeof parsed.meta.id === 'string' ? parsed.meta.id.trim() : ''
    let id = ''
    if (ENTRY_ID_PATTERN.test(metaId)) id = metaId
    else if (ENTRY_ID_PATTERN.test(stem)) id = stem
    if (id === '') {
      // The knowledge vault is a folder people edit by hand in Obsidian: a
      // note that arrives without a canonical id is adopted (id derived from
      // its path and body) instead of being moved out from under the author.
      // The memory profile keeps the strict rule — a broken memory file is a
      // bug worth quarantining.
      if (this._profile !== 'knowledge') throw new Error(`entry id missing or invalid in ${relative}`)
      id = adoptedId(relative)
    }
    if (taken.has(id)) {
      if (this._profile !== 'knowledge') throw new Error(`duplicate entry id ${id} in ${relative}`)
      // A hand-written copy of an existing note: keep the first one and adopt
      // the rest under a path-derived id rather than deleting the user's file.
      id = adoptedId(relative)
      if (taken.has(id)) throw new Error(`duplicate entry id ${id} in ${relative}`)
    }

    const meta = coerceEntry({ ...parsed.meta, id }, parsed.body, { now: this._now, profile: this._profile })
    meta.id = id
    // The body is the source of truth, so the content hash follows it.
    meta.hash = hashText(parsed.body)
    const stat = await fs.stat(absolute)
    return { meta, body: parsed.body, path: relative, mtimeMs: stat.mtimeMs }
  }

  /**
   * Re-read only the files whose mtime disagrees with the cached index.
   *
   * A full rebuild costs one read per note, which is wasteful when a single
   * file changed. The incremental path keeps every unchanged entry as-is,
   * drops the ones whose file vanished, and re-parses only the rest. Anything
   * that makes the cached state untrustworthy (version skew, a file that now
   * fails to parse, an unreadable directory) falls back to a full rebuild.
   * @param {Map<string, object>} cached - entries from the cached index.
   * @param {Array<string>} files - current content-relative file list.
   * @returns {Promise<{ entries: Map<string, object>, changed: number }|null>} refreshed state, or null to force a full rebuild.
   */
  async _refreshEntries(cached, files) {
    const present = new Set(files)
    const byPath = new Map()
    for (const entry of cached.values()) byPath.set(normalizeRelative(entry.path), entry)

    const entries = new Map()
    let changed = 0
    for (const relative of files) {
      const previous = byPath.get(relative)
      if (previous !== undefined) {
        let stat
        try {
          stat = await fs.stat(toAbsolute(this._root, relative))
        } catch {
          return null
        }
        // mtime equality is the whole point: an untouched file is kept verbatim,
        // so a one-note edit no longer re-reads the entire vault.
        if (stat.mtimeMs === previous.mtimeMs) {
          entries.set(previous.meta.id, previous)
          continue
        }
      }
      try {
        const entry = await this._readEntryFile(relative, new Set(entries.keys()))
        entries.set(entry.meta.id, entry)
        changed += 1
      } catch {
        return null
      }
    }
    // A vanished file is a real change even though nothing was re-read.
    if (present.size !== files.length) return null
    if (entries.size !== files.length) return null
    if (changed === 0 && cached.size === entries.size) return { entries, changed: 0 }
    return { entries, changed }
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
      try {
        const entry = await this._readEntryFile(relative, new Set(entries.keys()))
        entries.set(entry.meta.id, entry)
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
