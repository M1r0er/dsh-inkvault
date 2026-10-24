/**
 * dsh-inkvault — Obsidian bridge for DeepSeek Harness.
 *
 * Two independent features, each with its own user-chosen folder:
 *
 * 1. knowledge — write knowledge from a DSH conversation into an Obsidian
 *    folder (`inkvault_note_*` tools). Never touches folders it was not given.
 * 2. memory — use another Obsidian folder as the agent's long-term memory:
 *    `agent/pre-step` recall (waterfall) and `agent/turn-stopping` capture
 *    (serial) over a `session/event` text buffer.
 *
 * Directories are never invented: an unset root keeps that feature inactive,
 * and `inkvault_status` reports exactly where each vault lives. The plugin
 * appends no session events of its own (a new event type cannot be marked
 * `ignorable` from `Session.append`), so notes are Markdown files and indexes
 * are derived data.
 * @module dsh-inkvault
 */
import path from 'node:path'
import { resolveConfig, memoryActive, knowledgeActive } from './src/config.js'
import { makeEntryId, hashText, titleFromBody } from './src/frontmatter.js'
import { extractQueryText, buildInjectionText, buildRecallMessage } from './src/recall.js'
import { buildDirectiveText, escapePromptBraces, MAX_DIRECTIVE_CHARS } from './src/prompt.js'
import { extractCandidates, textOfContent } from './src/capture.js'
import { VaultStore } from './src/store.js'
import { registerTools } from './src/tools.js'

/** Loader plugin name. */
export const name = 'inkvault'

/** Settings form schema projected by the Host into the Plugin settings page. */
export { Config } from './src/config-schema.js'

/** The plugin registers tools and listens to events; it needs the tool registry. */
export const inject = ['tools']

const MAX_TRACKED_INJECTIONS = 1000
const MAX_BUFFERED_TURNS = 50

/** Assembly-context name for the standing-directive block (stable across steps). */
const DIRECTIVE_CONTEXT_NAME = 'inkvault:directives'

/** Assembly-context name for the knowledge capability hint (stable across steps). */
const KNOWLEDGE_HINT_CONTEXT_NAME = 'inkvault:knowledge-hint'

/**
 * The knowledge capability hint pushed into `system-prompt/assemble`.
 *
 * Deliberately a frozen constant: `system-prompt/assemble` runs on every step and
 * the Host only appends a new snapshot when the rendered text changes, so any
 * turn counter or timestamp here would churn the prompt cache forever. It states
 * *when* to reach for the tools and never restates their parameters — those live
 * in the tool schemas, which are already in context.
 */
const KNOWLEDGE_HINT_TEXT = escapePromptBraces([
  'Obsidian knowledge vault active: save with inkvault_note_save when the user says store, keep or organize;',
  'find with inkvault_note_search.',
  'Also note_list, note_read, note_update, note_forget.',
].join(' '))

/** Folder segments accepted by `notes/<folder>/`: no dot-segments, no separators. */
const FOLDER_SEGMENT = /^[A-Za-z0-9._-]+$/

/**
 * Validate one optional knowledge subfolder name.
 * A bad name is rejected instead of being silently dropped, so a note never
 * lands somewhere the user did not ask for.
 * @param {unknown} value - caller-supplied folder.
 * @returns {string} normalized folder ('' means "directly under notes/").
 */
function normalizeFolder(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error('folder must be a string')
  const raw = value.trim()
  if (raw === '') return ''
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`folder must be relative to notes/, not an absolute path: ${value}`)
  }
  const folder = raw.replace(/^\/+|\/+$/g, '')
  if (folder === '') return ''
  for (const segment of folder.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`folder must not contain empty, "." or ".." segments: ${value}`)
    }
    if (!FOLDER_SEGMENT.test(segment)) {
      throw new Error(`folder segments may only use letters, digits, dot, dash and underscore: ${value}`)
    }
  }
  return folder
}

/** Whether one entry carries every requested tag (AND semantics, case-insensitive). */
function hasAllTags(record, tags) {
  if (tags.length === 0) return true
  const own = Array.isArray(record?.meta?.tags) ? record.meta.tags.map((tag) => String(tag).toLowerCase()) : []
  return tags.every((tag) => own.includes(tag))
}

/** The subfolder of one entry path, relative to the content directory ('' = root). */
function folderOf(record, contentDir) {
  const relative = String(record?.path ?? '')
  const prefix = `${contentDir}/`
  const rest = relative.startsWith(prefix) ? relative.slice(prefix.length) : relative
  const slash = rest.lastIndexOf('/')
  return slash === -1 ? '' : rest.slice(0, slash)
}

/** Memoize one store's lazy initialization; failures stay retryable. */
function makeReady(store) {
  let promise
  return function ensureReady() {
    if (promise === undefined) {
      promise = store.init().catch((error) => {
        promise = undefined
        throw error
      })
    }
    return promise
  }
}

/**
 * Build the mutable runtime shared by hooks and tools, without touching a
 * context. Exposed so tests can exercise behavior without a live Host.
 * @param {unknown} rawConfig - loader row config.
 * @param {{ logger?: object, now?: () => Date }} deps - injected environment.
 * @returns {object} runtime with hooks and tool-facing operations.
 */
export function createRuntime(rawConfig, deps = {}) {
  const { config, issues } = resolveConfig(rawConfig)
  const logger = deps.logger ?? console
  const now = typeof deps.now === 'function' ? deps.now : () => new Date()
  const memoryOn = memoryActive(config)
  const knowledgeOn = knowledgeActive(config)
  const memoryStore = memoryOn ? new VaultStore({ root: config.memoryRoot, now }) : null
  const knowledgeStore = knowledgeOn ? new VaultStore({ root: config.knowledgeRoot, contentDir: 'notes', profile: 'knowledge', now }) : null
  const ensureMemoryReady = memoryStore === null ? null : makeReady(memoryStore)
  const ensureKnowledgeReady = knowledgeStore === null ? null : makeReady(knowledgeStore)
  const turnBuffers = new Map()
  const injectedTurns = new Set()

  function warn(message) {
    try { logger.warn?.(`inkvault: ${message}`) } catch { /* logging must never break a hook */ }
  }

  function debug(message, detail) {
    if (!config.debug) return
    try {
      logger.info?.(`inkvault: ${message}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
    } catch { /* ignore */ }
  }

  /** Remember an injection turn key and keep the tracker bounded. */
  function markInjected(key) {
    injectedTurns.add(key)
    while (injectedTurns.size > MAX_TRACKED_INJECTIONS) {
      injectedTurns.delete(injectedTurns.values().next().value)
    }
  }

  /** Fail fast when a feature was not configured but its operation is called. */
  function requireMemory() {
    if (!memoryOn) throw new Error('memory feature is not active: set memoryEnabled and memoryRoot in the inkvault config')
    return memoryStore
  }

  function requireKnowledge() {
    if (!knowledgeOn) throw new Error('knowledge feature is not active: set knowledgeEnabled and knowledgeRoot in the inkvault config')
    return knowledgeStore
  }

  /**
   * Compute the recall message for one pre-step, if the step needs one.
   * @param {{ agent?: object, messages?: unknown[], turn?: number, step?: number }} payload - pre-step payload.
   * @returns {Promise<object | undefined>} user message to append, if any.
   */
  async function recallMessage(payload) {
    if (!memoryOn || config.disabled || !config.inject) return undefined
    if (payload?.step !== 0) return undefined
    const sessionId = payload?.agent?.session?.id ?? 'unknown'
    const turn = payload?.turn ?? -1
    const key = `${sessionId}:${turn}`
    if (injectedTurns.has(key)) return undefined
    const query = extractQueryText(payload.messages)
    if (query.length < 2) return undefined
    await ensureMemoryReady()
    const results = await memoryStore.search(query, { limit: Math.max(1, config.maxRecallItems * 2) })
    const built = buildInjectionText(results, {
      budgetTokens: config.injectBudgetTokens,
      maxItems: config.maxRecallItems,
    })
    if (built === null) return undefined
    markInjected(key)
    debug('recall', { sessionId, turn, count: built.count })
    return buildRecallMessage(built.text)
  }

  /**
   * Build the standing-directive block for one `system-prompt/assemble` pass.
   *
   * Unlike {@link recallMessage} this is **not** keyword-gated: every assemble
   * pass re-derives the same text from the vault, so the rendered snapshot stays
   * byte-identical and the Host appends nothing until a directive note actually
   * changes. Returning `null` (no directive entries, or over budget) means the
   * caller pushes no context — that is a real snapshot change, so it is only
   * ever reached on a genuine transition, never per turn.
   *
   * @returns {Promise<{ name: string, text: string } | null>} context to push.
   */
  async function directiveContext() {
    if (!memoryOn || config.disabled || !config.directives) return null
    await ensureMemoryReady()
    const entries = await memoryStore.listEntries()
    const built = buildDirectiveText(entries, { maxChars: config.maxDirectiveChars })
    if (built === null) return null
    if (built.text === null) {
      // Refuse rather than truncate: a half-stated standing rule is worse than
      // an absent one, and silent per-entry dropping makes "which rules apply"
      // drift with note order.
      warn(`directive block skipped: ${built.overflow} chars exceeds maxDirectiveChars ${built.maxChars}; shorten or split the standing rules`)
      return null
    }
    debug('directive', { count: built.count, chars: built.text.length })
    return { name: DIRECTIVE_CONTEXT_NAME, text: built.text }
  }

  /**
   * Build the knowledge capability hint for one `system-prompt/assemble` pass.
   *
   * Unlike the directive lane this does not read the vault: the text is a frozen
   * constant, so every pass renders the same snapshot and the Host appends
   * nothing. It exists because 0.4.0 proved tool descriptions alone do not
   * trigger `inkvault_note_save` often enough — the model needs one plain
   * sentence saying the vault is there and when to reach for it.
   *
   * @returns {{ name: string, text: string } | null} context to push.
   */
  function knowledgeHintContext() {
    if (!knowledgeOn || config.disabled || !config.knowledgeHint) return null
    return { name: KNOWLEDGE_HINT_CONTEXT_NAME, text: KNOWLEDGE_HINT_TEXT }
  }

  /**
   * `agent/pre-step` waterfall listener body. Always returns the next decision,
   * spread so fields such as `startsRequestSeries` survive.
   */
  async function handlePreStep(payload, next) {
    const decision = await next()
    if (decision === undefined || decision === null || decision.kind !== 'enter') return decision
    try {
      const message = await recallMessage(payload)
      if (message === undefined) return decision
      return { ...decision, messages: [...decision.messages, message] }
    } catch (error) {
      warn(`recall failed: ${String(error)}`)
      return decision
    }
  }

  /**
   * `session/event` emit listener body: buffer the current turn's text.
   * Recall messages are excluded so the vault never captures its own output.
   */
  function handleSessionEvent(session, event) {
    if (!memoryOn || config.disabled || !config.capture) return
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    if (event?.type === 'turn/start') {
      if (turnBuffers.size >= MAX_BUFFERED_TURNS) turnBuffers.delete(turnBuffers.keys().next().value)
      turnBuffers.set(sessionId, { turn: event.data?.turn ?? -1, user: [], assistant: [] })
      return
    }
    const buffer = turnBuffers.get(sessionId)
    if (buffer === undefined) return
    if (event?.type === 'user/message') {
      const message = event.data
      if (message?.source?.kind === 'inkvault-recall') return
      const text = textOfContent(message?.content)
      if (text !== '') buffer.user.push(text)
    } else if (event?.type === 'assistant/message') {
      const text = textOfContent(event.data?.message?.content)
      if (text !== '') buffer.assistant.push(text)
    } else if (event?.type === 'turn/end') {
      turnBuffers.delete(sessionId)
    }
  }

  /** Extract candidates from one finished turn and persist the new ones. */
  async function captureBuffer(buffer, sessionId) {
    const userText = buffer.user.join('\n').trim()
    if (userText === '') return
    const candidates = extractCandidates({
      userText,
      assistantText: buffer.assistant.join('\n'),
      turn: buffer.turn,
      now,
      maxCandidates: config.captureMaxPerTurn,
      minConfidence: config.minCaptureConfidence,
      directiveTriggers: config.directiveTriggers,
    })
    if (candidates.length === 0) return
    await ensureMemoryReady()
    const existing = new Set((await memoryStore.listEntries()).map((record) => record.meta.hash))
    let written = 0
    for (const candidate of candidates) {
      const hash = hashText(candidate.body)
      if (existing.has(hash)) continue
      existing.add(hash)
      const createdAt = now()
      await memoryStore.writeEntry({
        meta: {
          id: makeEntryId(createdAt, candidate.body),
          title: candidate.title,
          kind: candidate.kind,
          status: 'pending',
          created: createdAt.toISOString(),
          updated: createdAt.toISOString(),
          tags: candidate.tags,
          confidence: candidate.confidence,
          source: 'capture',
          hash,
          origin: sessionId,
          delivery: candidate.delivery ?? 'recall',
        },
        body: candidate.body,
      })
      written += 1
    }
    if (written > 0) debug('capture', { sessionId, turn: buffer.turn, written })
  }

  /** `agent/turn-stopping` serial listener body; never throws. */
  async function handleTurnStopping(payload) {
    try {
      if (!memoryOn || config.disabled || !config.capture) return
      const sessionId = payload?.agent?.session?.id
      if (typeof sessionId !== 'string') return
      const buffer = turnBuffers.get(sessionId)
      if (buffer === undefined) return
      turnBuffers.delete(sessionId)
      if (buffer.turn !== payload?.turn) return
      await captureBuffer(buffer, sessionId)
    } catch (error) {
      warn(`capture failed: ${String(error)}`)
    }
  }

  /**
   * Where each configured vault lives and how many notes it holds.
   * This is the discoverability answer to "库到底在哪".
   * The memory section is only reported while the memory feature is active:
   * with `memoryEnabled: false` the plugin is a knowledge-vault plugin, and a
   * "memory: inactive" line would only add noise to every status call.
   * @returns {Promise<object>} status view.
   */
  async function status() {
    const view = {
      disabled: config.disabled,
      configIssues: [...issues],
      knowledge: {
        enabled: config.knowledgeEnabled,
        configured: knowledgeOn,
        root: config.knowledgeRoot,
        contentDir: knowledgeStore === null ? '' : knowledgeStore.contentDir,
        indexFile: config.knowledgeRoot === '' ? '' : path.join(config.knowledgeRoot, '.inkvault', 'index.json'),
        notes: 0,
      },
    }
    if (memoryOn) {
      view.memory = {
        enabled: config.memoryEnabled,
        configured: memoryOn,
        root: config.memoryRoot,
        contentDir: memoryStore === null ? '' : memoryStore.contentDir,
        indexFile: config.memoryRoot === '' ? '' : path.join(config.memoryRoot, '.inkvault', 'index.json'),
        notes: 0,
      }
    }
    for (const [key, store, ready] of [['memory', memoryStore, ensureMemoryReady], ['knowledge', knowledgeStore, ensureKnowledgeReady]]) {
      if (store === null || ready === null) continue
      try {
        await ready()
        view[key].notes = (await store.listEntries()).length
      } catch (error) {
        view[key].error = String(error)
      }
    }
    return view
  }

  return {
    config,
    issues,
    logger,
    now,
    debug,
    memoryOn,
    knowledgeOn,
    memoryStore,
    knowledgeStore,
    ensureMemoryReady,
    ensureKnowledgeReady,
    recallMessage,
    directiveContext,
    knowledgeHintContext,
    handlePreStep,
    handleSessionEvent,
    handleTurnStopping,
    status,
    turnBuffers,
    injectedTurns,
    /** Tools: keyword search over the memory vault. */
    async search(query, options = {}) {
      const store = requireMemory()
      await ensureMemoryReady()
      return store.search(query, options)
    },
    /** Tools: read one memory note by id. */
    async read(id) {
      const store = requireMemory()
      await ensureMemoryReady()
      return store.getEntry(id)
    },
    /** Tools: persist one memory note written by the model. */
    async remember(input) {
      const store = requireMemory()
      await ensureMemoryReady()
      const createdAt = input.now ?? now()
      return store.writeEntry({
        meta: {
          id: makeEntryId(createdAt, `${input.body}${Math.random()}`),
          title: typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : titleFromBody(input.body),
          kind: input.kind,
          status: 'active',
          created: createdAt.toISOString(),
          updated: createdAt.toISOString(),
          tags: Array.isArray(input.tags) ? input.tags : [],
          confidence: input.confidence,
          source: 'manual',
          hash: hashText(input.body),
          origin: input.origin ?? '',
          delivery: input.delivery ?? 'recall',
        },
        body: input.body,
      })
    },
    /** Tools: reversible archive of one memory note. */
    async forget(id, reason) {
      const store = requireMemory()
      await ensureMemoryReady()
      return store.archiveEntry(id, reason)
    },
    /** Tools: write one knowledge note into the chosen knowledge folder. */
    async noteSave(input) {
      const store = requireKnowledge()
      await ensureKnowledgeReady()
      const createdAt = input.now ?? now()
      const folder = normalizeFolder(input.folder)
      const meta = {
        id: makeEntryId(createdAt, `${input.body}${Math.random()}`),
        title: typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : titleFromBody(input.body),
        kind: input.kind,
        status: 'active',
        created: createdAt.toISOString(),
        updated: createdAt.toISOString(),
        tags: Array.isArray(input.tags) ? input.tags : [],
        confidence: 1,
        source: 'manual',
        hash: hashText(input.body),
        origin: input.origin ?? '',
      }
      const entry = { meta, body: input.body }
      if (folder !== '') entry.path = `${store.contentDir}/${folder}/${meta.id}.md`
      return store.writeEntry(entry)
    },
    /** Tools: keyword search over the knowledge folder. */
    async noteSearch(query, options = {}) {
      const store = requireKnowledge()
      await ensureKnowledgeReady()
      const results = await store.search(query, options)
      const tags = Array.isArray(options.tags) ? options.tags : []
      if (tags.length === 0) return results
      // Tag filtering is applied here as well as in the store so a search never
      // silently ignores the AND semantics the caller asked for.
      return results.filter((hit) => hasAllTags(hit?.entry ?? hit, tags))
    },
    /** Tools: read one knowledge note by id, with both link directions. */
    async noteRead(id) {
      const store = requireKnowledge()
      await ensureKnowledgeReady()
      const record = await store.getEntry(id)
      if (record === undefined) return undefined
      const links = Array.isArray(record.meta?.links) ? record.meta.links : []
      const backlinks = typeof store.backlinksOf === 'function' ? await store.backlinksOf(id) : []
      return { ...record, links, backlinks: Array.isArray(backlinks) ? backlinks : [] }
    },
    /**
     * Tools: list knowledge notes, newest-first or by title, with folder/tag filters.
     * Filtering is applied here as well as in the store so a list never silently
     * ignores a filter the store does not implement yet.
     */
    async noteList(options = {}) {
      const store = requireKnowledge()
      await ensureKnowledgeReady()
      const folder = normalizeFolder(options.folder ?? null)
      const tags = Array.isArray(options.tags) ? options.tags.map((tag) => String(tag).toLowerCase()) : []
      const recent = options.recent === true
      const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20
      const all = await store.listEntries({ folder: folder === '' ? undefined : folder, tags })
      const matched = []
      for (const record of all) {
        const recordFolder = folderOf(record, store.contentDir)
        if (folder !== '' && recordFolder !== folder) continue
        if (!hasAllTags(record, tags)) continue
        matched.push({
          id: record.meta.id,
          title: record.meta.title,
          kind: record.meta.kind,
          updated: record.meta.updated,
          tags: Array.isArray(record.meta?.tags) ? record.meta.tags : [],
          folder: recordFolder,
        })
      }
      matched.sort((a, b) => {
        if (recent && a.updated !== b.updated) return a.updated < b.updated ? 1 : -1
        if (a.title !== b.title) return a.title < b.title ? -1 : 1
        return a.id < b.id ? -1 : 1
      })
      return { notes: matched.slice(0, limit), total: matched.length }
    },
    /**
     * Tools: update one knowledge note in place.
     * Omitted fields keep their value, `created` is preserved by the store, and
     * `updated` is refreshed on every call.
     */
    async noteUpdate(patch) {
      const store = requireKnowledge()
      await ensureKnowledgeReady()
      const id = String(patch?.id ?? '').trim()
      const existing = await store.getEntry(id)
      if (existing === undefined) return undefined
      const body = patch.body === undefined ? existing.body : patch.body
      const meta = {
        ...existing.meta,
        id,
        title: patch.title === undefined ? existing.meta.title : patch.title,
        tags: patch.tags === undefined ? existing.meta.tags : patch.tags,
        hash: hashText(body),
      }
      return store.writeEntry({ meta, body, path: existing.path })
    },
    /** Tools: reversible archive of one knowledge note. */
    async noteForget(id, reason) {
      const store = requireKnowledge()
      await ensureKnowledgeReady()
      return store.archiveEntry(id, reason)
    },
  }
}

/**
 * Install the plugin on a context and return its runtime.
 * Split from {@link apply} so tests can drive the runtime directly while the
 * loader entry stays side-effect-only.
 * @param {object} ctx - plugin context.
 * @param {unknown} rawConfig - loader row config.
 * @returns {object} runtime.
 */
export function install(ctx, rawConfig) {
  const runtime = createRuntime(rawConfig, { logger: ctx.logger })
  for (const issue of runtime.issues) {
    try { ctx.logger?.warn?.(`inkvault: config: ${issue}`) } catch { /* ignore */ }
  }
  if (runtime.config.disabled) return runtime
  const logRoot = (label, root) => {
    try { ctx.logger?.info?.(`inkvault: ${label} vault = ${root === '' ? '(unset; feature inactive)' : root}`) } catch { /* ignore */ }
  }
  logRoot('memory', runtime.config.memoryRoot)
  logRoot('knowledge', runtime.config.knowledgeRoot)
  for (const [label, ready] of [['memory', runtime.ensureMemoryReady], ['knowledge', runtime.ensureKnowledgeReady]]) {
    if (ready === null) continue
    ctx.effect(async () => {
      try {
        await ready()
      } catch (error) {
        try { ctx.logger?.warn?.(`inkvault: ${label} vault init failed: ${String(error)}`) } catch { /* ignore */ }
      }
    })
  }
  registerTools(ctx, runtime)
  if (runtime.memoryOn) {
    ctx.on('session/event', (session, event) => runtime.handleSessionEvent(session, event))
    ctx.on('agent/pre-step', (payload, next) => runtime.handlePreStep(payload, next))
    ctx.on('agent/turn-stopping', (payload) => runtime.handleTurnStopping(payload))
    ctx.on('agent/disposed', ({ agent }) => {
      try { runtime.turnBuffers.delete(agent?.session?.id) } catch { /* ignore */ }
    })
  }
  // System-prompt lanes. Deliberately OUTSIDE the `memoryOn` gate: the knowledge
  // capability hint must reach the model in the 0.5.0 default posture, which is
  // exactly `memoryEnabled: false` — registering it inside the gate (as 0.4.0
  // did for the directive lane) would make it permanently invisible.
  if (runtime.memoryOn || runtime.knowledgeOn) {
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const push = (block) => {
        if (block === null || block === undefined) return
        if (assembly === null || typeof assembly !== 'object') return
        if (!Array.isArray(assembly.contexts)) assembly.contexts = []
        assembly.contexts.push(block)
      }
      // Both lanes push on EVERY pass: skipping one would itself change the
      // rendered snapshot and make the Host append an extra copy — see
      // src/prompt.js. Directive first (user-declared rules), hint second.
      try {
        push(await runtime.directiveContext())
      } catch (error) {
        // Never throw out of assemble: the Host turns that into a failed request.
        try { ctx.logger?.warn?.(`inkvault: directive block skipped: ${String(error)}`) } catch { /* ignore */ }
      }
      try {
        push(runtime.knowledgeHintContext())
      } catch (error) {
        try { ctx.logger?.warn?.(`inkvault: knowledge hint skipped: ${String(error)}`) } catch { /* ignore */ }
      }
      return next()
    })
  }
  return runtime
}

/**
 * Loader entry point.
 * @param {object} ctx - plugin context.
 * @param {unknown} rawConfig - loader row config.
 */
export function apply(ctx, rawConfig) {
  install(ctx, rawConfig)
}

/** Re-exported for tests and future UI code. */
export { resolveConfig }
