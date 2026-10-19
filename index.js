/**
 * dsh-inkvault — local Markdown memory vault for DeepSeek Harness.
 *
 * Architecture (v0.1.0):
 * - `agent/pre-step` waterfall  → recall once per turn (step 0) and append a
 *   user message explicitly marked as untrusted data.
 * - `agent/turn-stopping` serial → score the finished turn's user text with
 *   rule-based extraction and persist pending candidate notes.
 * - `session/event` emit feed    → keep a per-session buffer of this turn's
 *   user/assistant text for capture; `turn/end` clears it.
 * - four explicit tools          → search / read / remember / forget.
 *
 * The plugin appends no session events of its own: a new event type cannot be
 * marked `ignorable` from `Session.append`, so persisted notes live in the
 * Markdown vault and the index is derived data.
 * @module dsh-inkvault
 */
import { resolveConfig, resolveMemoryRoot } from './src/config.js'
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
  const store = new VaultStore({ root: resolveMemoryRoot(config.memoryRoot), now })
  let readyPromise
  const turnBuffers = new Map()
  const injectedTurns = new Set()

  /** Memoized lazy vault initialization; failures stay retryable. */
  function ensureReady() {
    if (readyPromise === undefined) {
      readyPromise = store.init().catch((error) => {
        readyPromise = undefined
        throw error
      })
    }
    return readyPromise
  }

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
      const oldest = injectedTurns.values().next().value
      injectedTurns.delete(oldest)
    }
  }

  /**
   * Compute the recall message for one pre-step, if the step needs one.
   * @param {{ agent?: object, messages?: unknown[], turn?: number, step?: number }} payload - pre-step payload.
   * @returns {Promise<object | undefined>} user message to append, if any.
   */
  async function recallMessage(payload) {
    if (config.disabled || !config.inject) return undefined
    if (payload?.step !== 0) return undefined
    const sessionId = payload?.agent?.session?.id ?? 'unknown'
    const turn = payload?.turn ?? -1
    const key = `${sessionId}:${turn}`
    if (injectedTurns.has(key)) return undefined
    const query = extractQueryText(payload.messages)
    if (query.length < 2) return undefined
    await ensureReady()
    const results = await store.search(query, {
      limit: Math.max(1, config.maxRecallItems * 2),
    })
    const built = buildInjectionText(results, {
      budgetTokens: config.injectBudgetTokens,
      maxItems: config.maxRecallItems,
    })
    if (built === null) return undefined
    markInjected(key)
    debug('recall', { sessionId, turn, count: built.count, tokens: built.text.length })
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
    if (config.disabled || !config.capture) return
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
    await ensureReady()
    const existing = new Set((await store.listEntries()).map((record) => record.meta.hash))
    let written = 0
    for (const candidate of candidates) {
      const hash = hashText(candidate.body)
      if (existing.has(hash)) continue
      existing.add(hash)
      const createdAt = now()
      const meta = {
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
      }
      await store.writeEntry({ meta, body: candidate.body })
      written += 1
    }
    if (written > 0) debug('capture', { sessionId, turn: buffer.turn, written })
  }

  /** `agent/turn-stopping` serial listener body; never throws. */
  async function handleTurnStopping(payload) {
    try {
      if (config.disabled || !config.capture) return
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

  return {
    config,
    issues,
    store,
    logger,
    now,
    debug,
    ensureReady,
    recallMessage,
    handlePreStep,
    handleSessionEvent,
    handleTurnStopping,
    turnBuffers,
    injectedTurns,
    /** Tools: keyword search over the vault. */
    async search(query, options = {}) {
      await ensureReady()
      return store.search(query, options)
    },
    /** Tools: read one note by id. */
    async read(id) {
      await ensureReady()
      return store.getEntry(id)
    },
    /** Tools: persist one note written by the model. */
    async remember(input) {
      await ensureReady()
      const createdAt = input.now ?? now()
      const meta = {
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
      }
      return store.writeEntry({ meta, body: input.body })
    },
    /** Tools: reversible archive. */
    async forget(id, reason) {
      await ensureReady()
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
  if (!runtime.config.disabled) {
    ctx.effect(async () => {
      try {
        await runtime.ensureReady()
      } catch (error) {
        try { ctx.logger?.warn?.(`inkvault: vault init failed: ${String(error)}`) } catch { /* ignore */ }
      }
    })
  }
  registerTools(ctx, runtime)
  ctx.on('session/event', (session, event) => runtime.handleSessionEvent(session, event))
  ctx.on('agent/pre-step', (payload, next) => runtime.handlePreStep(payload, next))
  ctx.on('agent/turn-stopping', (payload) => runtime.handleTurnStopping(payload))
  ctx.on('agent/disposed', ({ agent }) => {
    try { runtime.turnBuffers.delete(agent?.session?.id) } catch { /* ignore */ }
  })
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
