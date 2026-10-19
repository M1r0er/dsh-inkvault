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
import { extractCandidates, textOfContent } from './src/capture.js'
import { VaultStore } from './src/store.js'
import { registerTools } from './src/tools.js'

/** Loader plugin name. */
export const name = 'inkvault'

/** The plugin registers tools and listens to events; it needs the tool registry. */
export const inject = ['tools']

const MAX_TRACKED_INJECTIONS = 1000
const MAX_BUFFERED_TURNS = 50

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
  const knowledgeStore = knowledgeOn ? new VaultStore({ root: config.knowledgeRoot, contentDir: 'notes', now }) : null
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
   * @returns {Promise<object>} status view.
   */
  async function status() {
    const view = {
      disabled: config.disabled,
      configIssues: [...issues],
      memory: {
        enabled: config.memoryEnabled,
        configured: memoryOn,
        root: config.memoryRoot,
        contentDir: memoryStore === null ? '' : memoryStore.contentDir,
        indexFile: config.memoryRoot === '' ? '' : path.join(config.memoryRoot, '.inkvault', 'index.json'),
        notes: 0,
      },
      knowledge: {
        enabled: config.knowledgeEnabled,
        configured: knowledgeOn,
        root: config.knowledgeRoot,
        contentDir: knowledgeStore === null ? '' : knowledgeStore.contentDir,
        indexFile: config.knowledgeRoot === '' ? '' : path.join(config.knowledgeRoot, '.inkvault', 'index.json'),
        notes: 0,
      },
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
      return store.writeEntry({
        meta: {
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
        },
        body: input.body,
      })
    },
    /** Tools: keyword search over the knowledge folder. */
    async noteSearch(query, options = {}) {
      const store = requireKnowledge()
      await ensureKnowledgeReady()
      return store.search(query, options)
    },
    /** Tools: read one knowledge note by id. */
    async noteRead(id) {
      const store = requireKnowledge()
      await ensureKnowledgeReady()
      return store.getEntry(id)
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
