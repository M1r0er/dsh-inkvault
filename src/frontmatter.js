/**
 * Frontmatter parsing, serialization and metadata normalization for InkVault.
 *
 * Only a deliberately small YAML subset is supported: `key: value` lines,
 * inline arrays (`[a, b]`), quoted scalars, numbers, booleans and null-ish
 * values. Anything richer (nested objects, block scalars, duplicate keys) is
 * reported as a non-fatal issue instead of throwing, because a malformed
 * memory file must never break the vault.
 * @module dsh-inkvault/frontmatter
 */
import { createHash } from 'node:crypto'

/** Entry kinds, frozen so callers cannot mutate shared vocabulary. */
export const ENTRY_KINDS = Object.freeze(['preference', 'fact', 'decision', 'project', 'reference', 'task'])

/** Entry lifecycle states, frozen for the same reason. */
export const ENTRY_STATUSES = Object.freeze(['active', 'pending', 'superseded', 'archived'])

/** Hard cap on stored body length (characters). */
export const MAX_BODY_CHARS = 20000

/** Entry id format; the date stem plus six hash characters. */
const ENTRY_ID_RE = /^m-\d{8}-[a-z0-9]{6}$/

/** Sources accepted by {@link coerceEntry}. */
const ENTRY_SOURCES = Object.freeze(['capture', 'manual', 'import'])

/** Canonical frontmatter key order (see internal contract §0.1). */
const ENTRY_KEY_ORDER = Object.freeze([
  'id', 'title', 'kind', 'status', 'created', 'updated', 'tags', 'confidence', 'source', 'hash', 'origin',
])

/** Values YAML (and this subset) treat as null; `window` is kept for compatibility with v0.1. */
const NULL_LITERALS = new Set(['null', '~', 'window'])

/** Collapse all whitespace runs to single spaces and trim. */
function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Strip a single matching pair of quotes from a scalar and unescape it.
 * @param {string} value - trimmed scalar text.
 * @returns {string} unquoted text.
 */
function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/**
 * Parse one inline array body (`a, b`) into a string array.
 * Commas inside quotes are kept, per the YAML subset.
 * @param {string} inner - text between the brackets.
 * @returns {string[]} items.
 */
function parseInlineArray(inner) {
  const items = []
  let current = ''
  let quote = ''
  for (const char of inner) {
    if (quote !== '') {
      current += char
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
      current += char
    } else if (char === ',') {
      items.push(current)
      current = ''
    } else {
      current += char
    }
  }
  items.push(current)
  return items
    .map((item) => unquote(item.trim()))
    .filter((item) => item !== '')
}

/**
 * Parse a single-line YAML-subset scalar.
 * Typed values (number, boolean) are only produced when the conversion is
 * lossless; anything else stays a string.
 * @param {string} raw - trimmed raw value text.
 * @returns {string|number|boolean} parsed scalar.
 */
function parseScalar(raw) {
  if (raw === '') return ''
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) return raw
    return parseInlineArray(raw.slice(1, -1))
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return unquote(raw)
  }
  const lower = raw.toLowerCase()
  if (NULL_LITERALS.has(lower)) return ''
  if (raw === 'true' || raw === 'false') return raw === 'true'
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const numeric = Number(raw)
    // Keep strings such as "0123456789abcdef"-style ids intact: only convert
    // when the number round-trips to the exact same text.
    if (Number.isFinite(numeric) && String(numeric) === raw) return numeric
  }
  return raw
}

/**
 * Parse a complete Markdown document.
 *
 * The document is only treated as having frontmatter when the first line is
 * exactly `---` and a later line closes it; otherwise the whole text is body.
 * @param {string} text - full Markdown document.
 * @returns {{ meta: Record<string, unknown>, body: string, issues: string[] }} parse result.
 */
export function parseDocument(text) {
  const issues = []
  if (typeof text !== 'string') return { meta: {}, body: '', issues: ['input is not a string'] }

  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = normalized.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') return { meta: {}, body: text, issues }

  let closing = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      closing = i
      break
    }
  }
  if (closing === -1) {
    issues.push('frontmatter is not terminated; treating the document as plain body')
    return { meta: {}, body: text, issues }
  }

  const meta = {}
  let lastKey = null
  const nestedReported = new Set()
  for (let i = 1; i < closing; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (/^\s*#/.test(line)) continue // YAML comment

    // Indented lines belong to a nested object or a multi-line value.
    if (/^\s/.test(line)) {
      const owner = lastKey ?? ''
      if (!nestedReported.has(owner)) {
        nestedReported.add(owner)
        issues.push(owner === ''
          ? 'nested object or multi-line value is not supported'
          : `nested object or multi-line value is not supported for "${owner}"`)
      }
      continue
    }

    const colon = line.indexOf(':')
    if (colon === -1) {
      issues.push(`invalid frontmatter line: ${line.trim()}`)
      continue
    }
    const key = line.slice(0, colon).trim()
    if (key === '') {
      issues.push('frontmatter key is empty')
      continue
    }
    if (Object.prototype.hasOwnProperty.call(meta, key)) {
      issues.push(`duplicate frontmatter key: ${key}`)
      continue
    }

    const rawValue = line.slice(colon + 1).trim()
    lastKey = key
    if (rawValue === '|' || rawValue === '>' || /^[|>][+-]?$/.test(rawValue)) {
      issues.push(`multi-line value is not supported for "${key}"`)
      meta[key] = ''
      continue
    }
    meta[key] = parseScalar(rawValue)
  }

  const bodyLines = lines.slice(closing + 1)
  // Drop the single blank line that separates the closing fence from the body.
  if (bodyLines.length > 0 && bodyLines[0] === '') bodyLines.shift()
  let body = bodyLines.join('\n')
  // A file written on disk usually ends with a newline; the in-memory body is
  // canonical and has none, which keeps round-trips stable.
  if (body.endsWith('\n')) body = body.slice(0, -1)

  return { meta, body, issues }
}

/**
 * Decide whether a plain scalar needs quoting in the serialized form.
 * @param {string} value - scalar text.
 * @returns {boolean} true when it must be quoted.
 */
function needsQuotes(value) {
  if (value === '') return true
  if (/^\s|\s$/.test(value)) return true
  if (/[:#[\]{}'"\n\r\t,]/.test(value)) return true
  if (/^(?:true|false|null|window|~)$/i.test(value)) return true
  if (/^[-?*&!|>@%`]/.test(value)) return true
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return true
  return false
}

/**
 * Format one scalar for the frontmatter block.
 * @param {unknown} value - value to format.
 * @returns {string} YAML-subset representation.
 */
function formatScalar(value) {
  if (value === undefined || value === null) return "''"
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : "''"
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map((item) => formatScalaritem(item)).join(', ')}]`
  const text = collapse(value)
  if (text === '') return "''"
  // ISO timestamps are safe unquoted and are the canonical date representation.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text)) return text
  if (!needsQuotes(text)) return text
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Format one array item; items are always strings in this schema.
 * @param {unknown} item - item value.
 * @returns {string} formatted item.
 */
function formatScalaritem(item) {
  const text = collapse(item)
  if (text === '' || needsQuotes(text)) return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return text
}

/**
 * Serialize metadata plus body into a complete Markdown document.
 * Key order is fixed to the contract's EntryMeta order; unknown keys are
 * appended (in insertion order) so parsing never silently drops data.
 * @param {object} meta - metadata object.
 * @param {string} body - Markdown body.
 * @returns {string} serialized document.
 */
export function stringifyDocument(meta, body) {
  const source = meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}
  const lines = ['---']
  for (const key of ENTRY_KEY_ORDER) {
    if (key === 'tags') {
      const tags = Array.isArray(source.tags) ? source.tags.map(String) : []
      lines.push(`tags: [${tags.map((tag) => formatScalaritem(tag)).join(', ')}]`)
      continue
    }
    lines.push(`${key}: ${formatScalar(source[key])}`)
  }
  for (const key of Object.keys(source)) {
    if (ENTRY_KEY_ORDER.includes(key)) continue
    if (source[key] === undefined) continue
    lines.push(`${key}: ${formatScalar(source[key])}`)
  }
  lines.push('---')

  const cleanBody = String(body ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/, '')
  return cleanBody === '' ? `${lines.join('\n')}\n` : `${lines.join('\n')}\n\n${cleanBody}`
}

/**
 * Extract a title from the first non-empty body line, dropping simple
 * Markdown markers (#, -, >, * and task checkboxes).
 * @param {string} body - Markdown body.
 * @returns {string} title, at most 120 characters, or '' when no content.
 */
export function titleFromBody(body) {
  if (typeof body !== 'string') return ''
  for (const rawLine of body.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (line === '') continue
    // Repeat so combinations such as "> # Heading" are stripped too.
    for (let i = 0; i < 4; i += 1) {
      const next = line
        .replace(/^#{1,6}\s*/, '')
        .replace(/^>\s?/, '')
        .replace(/^[-*+]\s+/, '')
        .replace(/^\[[ xX]\]\s*/, '')
        .trim()
      if (next === line) break
      line = next
    }
    if (line !== '') return line.slice(0, 120)
  }
  return ''
}

/**
 * Hash text to the 16-character lowercase hexadecimal digest used by entries.
 * @param {string} text - text to hash.
 * @returns {string} first 16 hex characters of SHA-256.
 */
export function hashText(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

/**
 * Build an entry id: `m-YYYYMMDD-` plus the first six hash characters of
 * `seed + timestamp`. The date part uses local time.
 * @param {Date} [now] - creation time.
 * @param {string} [seed] - extra entropy (for example the body).
 * @returns {string} entry id.
 */
export function makeEntryId(now = new Date(), seed = '') {
  const date = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stem = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const digest = hashText(`${seed}${date.getTime()}`)
  return `m-${stem}-${digest.slice(0, 6)}`
}

/**
 * Parse an ISO 8601 string or a millisecond timestamp into a valid Date.
 * @param {unknown} value - candidate value.
 * @returns {Date|undefined} valid Date, or undefined.
 */
export function parseDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : new Date(value.getTime())
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return undefined
    const millis = /^-?\d+$/.test(text) ? Number(text) : Date.parse(text)
    if (Number.isNaN(millis)) return undefined
    const date = new Date(millis)
    return Number.isNaN(date.getTime()) ? undefined : date
  }
  return undefined
}

/**
 * Normalize tags: strings only, trimmed, deduplicated, at most 12 items.
 * A plain comma-separated string is accepted as a convenience.
 * @param {unknown} value - raw tags value.
 * @returns {string[]} normalized tags.
 */
function coerceTags(value) {
  let items = []
  if (Array.isArray(value)) items = value
  else if (typeof value === 'string') items = value.split(',')
  const seen = new Set()
  const tags = []
  for (const item of items) {
    if (item === null || item === undefined) continue
    const tag = collapse(item)
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
    if (tags.length >= 12) break
  }
  return tags
}

/**
 * Normalize any metadata object into a valid EntryMeta.
 * Invalid fields fall back to contract defaults; when `options.issues` is an
 * array, each fallback is reported there (parseDocument-style, never thrown).
 * @param {unknown} meta - raw metadata (possibly already normalized).
 * @param {string} body - entry body.
 * @param {{ now?: () => Date, issues?: string[] }} [options] - clock and issue sink.
 * @returns {object} EntryMeta.
 */
export function coerceEntry(meta, body, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const issues = Array.isArray(options.issues) ? options.issues : null
  const report = (message) => {
    if (issues !== null) issues.push(message)
  }

  const raw = meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}
  let bodyText = typeof body === 'string' ? body : ''
  if (bodyText.length > MAX_BODY_CHARS) {
    report(`body truncated to ${MAX_BODY_CHARS} characters`)
    bodyText = bodyText.slice(0, MAX_BODY_CHARS)
  }

  let nowDate = now()
  if (!(nowDate instanceof Date) || Number.isNaN(nowDate.getTime())) nowDate = new Date()
  const fallbackIso = nowDate.toISOString()

  let id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!ENTRY_ID_RE.test(id)) {
    if (id !== '') report(`invalid id "${id}"; generated a new one`)
    id = makeEntryId(nowDate, hashText(bodyText))
  }

  let title = raw.title === undefined || raw.title === null ? '' : collapse(raw.title)
  if (title === '') title = titleFromBody(bodyText)
  if (title === '') {
    report('title missing; using "Untitled"')
    title = 'Untitled'
  }
  if (title.length > 120) title = title.slice(0, 120)

  let kind = collapse(raw.kind).toLowerCase()
  if (!ENTRY_KINDS.includes(kind)) {
    if (kind !== '') report(`invalid kind "${raw.kind}"; using "fact"`)
    kind = 'fact'
  }

  let status = collapse(raw.status).toLowerCase()
  if (!ENTRY_STATUSES.includes(status)) {
    if (status !== '') report(`invalid status "${raw.status}"; using "active"`)
    status = 'active'
  }

  let createdDate = parseDate(raw.created)
  if (createdDate === undefined) {
    if (raw.created !== undefined && raw.created !== '') report('invalid created date; using now')
    createdDate = nowDate
  }

  let updatedDate = parseDate(raw.updated)
  if (updatedDate === undefined) {
    if (raw.updated !== undefined && raw.updated !== '') report('invalid updated date; using now')
    updatedDate = nowDate
  }

  const tags = coerceTags(raw.tags)

  let confidence = 0.5
  if (typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)) {
    confidence = Math.min(1, Math.max(0, raw.confidence))
  } else if (typeof raw.confidence === 'string' && raw.confidence.trim() !== '' && Number.isFinite(Number(raw.confidence))) {
    confidence = Math.min(1, Math.max(0, Number(raw.confidence)))
  } else if (raw.confidence !== undefined && raw.confidence !== null) {
    report(`invalid confidence "${raw.confidence}"; using 0.5`)
  }

  let source = collapse(raw.source).toLowerCase()
  if (!ENTRY_SOURCES.includes(source)) {
    if (source !== '') report(`invalid source "${raw.source}"; using "manual"`)
    source = 'manual'
  }

  let hash = typeof raw.hash === 'string' ? raw.hash.trim().toLowerCase() : ''
  if (!/^[0-9a-f]{16}$/.test(hash)) hash = hashText(bodyText)

  const origin = raw.origin === undefined || raw.origin === null ? '' : collapse(raw.origin)

  return {
    id,
    title,
    kind,
    status,
    created: createdDate.toISOString(),
    updated: updatedDate.toISOString(),
    tags,
    confidence,
    source,
    hash,
    origin,
  }
}

/**
 * Serialize an EntryRecord into Markdown (metadata + body).
 * @param {{ meta: object, body: string }} entry - entry record.
 * @returns {string} Markdown document.
 */
export function entryToMarkdown(entry) {
  const record = entry !== null && typeof entry === 'object' ? entry : {}
  return stringifyDocument(record.meta, record.body)
}

// Exposed for store.js so it can validate ids without duplicating the regex.
/** @type {RegExp} */
export const ENTRY_ID_PATTERN = ENTRY_ID_RE
