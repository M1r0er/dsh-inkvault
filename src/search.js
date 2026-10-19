/**
 * Lexical search: tokenizer, BM25 index, scoring and index (de)serialization.
 *
 * The tokenizer is language-aware: ASCII alphanumeric runs of at least two
 * characters become whole tokens, while CJK runs are split into overlapping
 * 2-grams (a single CJK character stays a token) so Chinese notes can be
 * matched without a dictionary.
 * @module dsh-inkvault/search
 */
/** BM25 term-frequency saturation. */
const K1 = 1.2

/** BM25 length-normalization strength. */
const B = 0.75

/** Serialized index format version. */
const INDEX_VERSION = 1

/** Default number of returned hits. */
const DEFAULT_LIMIT = 8

/** One CJK character (Han plus kana ranges). */
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
/** One ASCII alphanumeric character. */
const ASCII_ALNUM_RE = /[a-z0-9]/

/** Round to six decimals, matching the contract's persisted score precision. */
function round6(value) {
  return Number(value.toFixed(6))
}

/**
 * Tokenize text for indexing and querying.
 * Rules: lowercase; ASCII alphanumeric runs of length >= 2; CJK runs split into
 * 2-grams (single-character runs kept as-is); pure punctuation dropped;
 * duplicates removed preserving first-seen order.
 * @param {unknown} text - text to tokenize.
 * @returns {string[]} unique tokens.
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const lower = text.toLowerCase()
  const tokens = []
  const seen = new Set()
  const push = (token) => {
    if (token === '' || seen.has(token)) return
    seen.add(token)
    tokens.push(token)
  }

  let ascii = ''
  let cjk = ''
  const flushAscii = () => {
    if (ascii.length >= 2) push(ascii)
    ascii = ''
  }
  const flushCjk = () => {
    if (cjk.length === 1) push(cjk)
    else {
      for (let i = 0; i + 1 < cjk.length; i += 1) push(cjk.slice(i, i + 2))
    }
    cjk = ''
  }

  for (const char of lower) {
    if (CJK_CHAR_RE.test(char)) {
      flushAscii()
      cjk += char
    } else if (ASCII_ALNUM_RE.test(char)) {
      flushCjk()
      ascii += char
    } else {
      flushAscii()
      flushCjk()
    }
  }
  flushAscii()
  flushCjk()
  return tokens
}

/**
 * Build an empty index skeleton.
 * @returns {{ version: number, N: number, avgdl: number, docs: object, df: object, postings: object }} index.
 */
function emptyIndex() {
  return { version: INDEX_VERSION, N: 0, avgdl: 0, docs: {}, df: {}, postings: {} }
}

/**
 * Build a BM25 index from documents.
 * Duplicate ids are merged (token counts and lengths summed) so the result
 * stays internally consistent.
 * @param {Array<{ id: string, text: string }>} docs - documents to index.
 * @returns {{ version: number, N: number, avgdl: number, docs: object, df: object, postings: object }} index.
 */
export function buildIndex(docs) {
  const index = emptyIndex()
  if (!Array.isArray(docs)) return index

  // id -> { len, tf: Map<term, count> }
  const collected = new Map()
  for (const doc of docs) {
    if (doc === null || typeof doc !== 'object' || typeof doc.id !== 'string' || doc.id === '') continue
    const text = typeof doc.text === 'string' ? doc.text : ''
    const tokens = tokenize(text)
    let record = collected.get(doc.id)
    if (record === undefined) {
      record = { len: 0, tf: new Map() }
      collected.set(doc.id, record)
    }
    record.len += tokens.length
    for (const term of tokens) record.tf.set(term, (record.tf.get(term) ?? 0) + 1)
  }

  if (collected.size === 0) return index
  index.N = collected.size
  let totalLength = 0
  for (const [id, record] of collected) {
    totalLength += record.len
    index.docs[id] = { len: record.len }
    for (const [term, tf] of record.tf) {
      index.df[term] = (index.df[term] ?? 0) + 1
      if (index.postings[term] === undefined) index.postings[term] = {}
      index.postings[term][id] = tf
    }
  }
  index.avgdl = round6(totalLength / index.N)
  return index
}

/**
 * Score documents with BM25 and return the best matches.
 * @param {object} index - index produced by {@link buildIndex} (or deserialized).
 * @param {unknown} query - raw query text.
 * @param {{ limit?: number }} [options] - result cap (default 8).
 * @returns {Array<{ id: string, score: number }>} hits sorted by descending score, then id.
 */
export function searchIndex(index, query, options = {}) {
  if (index === null || typeof index !== 'object') return []
  const total = Number(index.N)
  if (!Number.isFinite(total) || total <= 0) return []

  const tokens = tokenize(query)
  if (tokens.length === 0) return []

  const rawLimit = options !== null && typeof options === 'object' ? options.limit : undefined
  const limit = rawLimit === undefined
    ? DEFAULT_LIMIT
    : rawLimit === Infinity
      ? Infinity
      : Number.isFinite(Number(rawLimit)) && Number(rawLimit) >= 0
        ? Math.floor(Number(rawLimit))
        : DEFAULT_LIMIT
  if (limit === 0) return []

  const avgdl = Number(index.avgdl)
  const scores = new Map()
  const docs = index.docs !== null && typeof index.docs === 'object' ? index.docs : {}
  const postingsByTerm = index.postings !== null && typeof index.postings === 'object' ? index.postings : {}
  const dfByTerm = index.df !== null && typeof index.df === 'object' ? index.df : {}

  for (const term of tokens) {
    const postings = postingsByTerm[term]
    const df = Number(dfByTerm[term])
    if (postings === null || typeof postings !== 'object' || !Number.isFinite(df) || df <= 0) continue
    const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
    for (const id of Object.keys(postings)) {
      const tf = Number(postings[id])
      if (!Number.isFinite(tf) || tf <= 0) continue
      const doc = docs[id]
      const dl = doc !== null && typeof doc === 'object' ? Number(doc.len) : 0
      const safeDl = Number.isFinite(dl) && dl > 0 ? dl : 0
      const lengthRatio = avgdl > 0 ? safeDl / avgdl : 0
      const denominator = tf + K1 * (1 - B + B * lengthRatio)
      const contribution = (idf * tf * (K1 + 1)) / denominator
      scores.set(id, (scores.get(id) ?? 0) + contribution)
    }
  }

  const hits = []
  for (const [id, score] of scores) {
    if (score > 0) hits.push({ id, score: round6(score) })
  }
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return limit === Infinity ? hits : hits.slice(0, limit)
}

/**
 * Convert an index into a plain JSON-serializable object (defensive copy).
 * @param {object} index - index to serialize.
 * @returns {{ version: number, N: number, avgdl: number, docs: object, df: object, postings: object }} plain object.
 */
export function serializeIndex(index) {
  const target = emptyIndex()
  if (index === null || typeof index !== 'object') return target

  const N = Number(index.N)
  target.N = Number.isFinite(N) && N > 0 ? Math.floor(N) : 0
  const avgdl = Number(index.avgdl)
  target.avgdl = Number.isFinite(avgdl) && avgdl > 0 ? round6(avgdl) : 0

  const docs = index.docs !== null && typeof index.docs === 'object' ? index.docs : {}
  for (const id of Object.keys(docs)) {
    const len = Number(docs[id]?.len)
    target.docs[id] = { len: Number.isFinite(len) && len > 0 ? Math.floor(len) : 0 }
  }

  const df = index.df !== null && typeof index.df === 'object' ? index.df : {}
  for (const term of Object.keys(df)) {
    const count = Number(df[term])
    if (Number.isFinite(count) && count > 0) target.df[term] = Math.floor(count)
  }

  const postings = index.postings !== null && typeof index.postings === 'object' ? index.postings : {}
  for (const term of Object.keys(postings)) {
    const perDoc = postings[term]
    if (perDoc === null || typeof perDoc !== 'object') continue
    const copy = {}
    for (const id of Object.keys(perDoc)) {
      const tf = Number(perDoc[id])
      if (Number.isFinite(tf) && tf > 0) copy[id] = Math.floor(tf)
    }
    target.postings[term] = copy
  }
  return target
}

/**
 * Restore an index from its serialized form. Returns undefined when the input
 * is not a version-1 index, so callers can fall back to a rebuild.
 * @param {unknown} raw - deserialized JSON.
 * @returns {object|undefined} index, or undefined when invalid.
 */
export function deserializeIndex(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  if (raw.version !== INDEX_VERSION) return undefined

  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!isPlainObject(raw.docs) || !isPlainObject(raw.df) || !isPlainObject(raw.postings)) return undefined

  const N = Number(raw.N)
  const avgdl = Number(raw.avgdl)
  if (!Number.isFinite(N) || N < 0) return undefined
  if (!Number.isFinite(avgdl) || avgdl < 0) return undefined

  for (const id of Object.keys(raw.docs)) {
    if (!isPlainObject(raw.docs[id]) || !Number.isFinite(Number(raw.docs[id].len))) return undefined
  }
  for (const term of Object.keys(raw.df)) {
    if (!Number.isFinite(Number(raw.df[term]))) return undefined
  }
  for (const term of Object.keys(raw.postings)) {
    const perDoc = raw.postings[term]
    if (!isPlainObject(perDoc)) return undefined
    for (const id of Object.keys(perDoc)) {
      if (!Number.isFinite(Number(perDoc[id]))) return undefined
    }
  }

  return serializeIndex({ ...raw, N, avgdl })
}
