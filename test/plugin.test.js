/**
 * Integration tests for the plugin wiring: fake Cordis context, real store on a
 * temporary vault. These tests exercise the pre-step / session-event /
 * turn-stopping contract and all four tools without a live Host.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { install, resolveConfig } from '../index.js'
import { toolDefinitions } from '../src/tools.js'

/** Minimal Cordis-like context capturing registrations. */
function fakeContext() {
  const handlers = new Map()
  const tools = new Map()
  const ctx = {
    logger: { warn() {}, info() {}, debug() {} },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const current = handlers.get(event) ?? []
        handlers.set(event, current.filter((entry) => entry !== handler))
      }
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  return { ctx, handlers, tools }
}

/** Run every listener registered for one event in order and collect results. */
async function emit(handlers, event, ...args) {
  const results = []
  for (const handler of handlers.get(event) ?? []) results.push(await handler(...args))
  return results
}

/** Create a temporary vault root cleaned up after the test. */
async function temporaryVault(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkvault-plugin-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

/** A user content message with the required identity fields. */
function userMessage(id, text, sourceKind = 'test') {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: sourceKind } }
}

/** Append one completed turn's events (turn/start, user message, assistant reply). */
async function emitTurn(handlers, session, turn, userText) {
  await emit(handlers, 'session/event', session, { type: 'turn/start', data: { turn } })
  await emit(handlers, 'session/event', session, { type: 'user/message', data: userMessage(`u${turn}`, userText) })
  await emit(handlers, 'session/event', session, {
    type: 'assistant/message',
    data: {
      message: {
        id: `a${turn}`,
        role: 'assistant',
        content: [{ type: 'text', text: '好的，已记下。' }],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    },
  })
}

test('registers exactly the four vault tools', async (t) => {
  const root = await temporaryVault(t)
  const { ctx, tools } = fakeContext()
  const runtime = install(ctx, { disabled: false, memoryRoot: root })
  await runtime.ensureReady()
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['inkvault_forget', 'inkvault_read', 'inkvault_remember', 'inkvault_search'],
  )
})

test('captures a preference at turn end, then recalls it at the next turn', async (t) => {
  const root = await temporaryVault(t)
  const { ctx, handlers } = fakeContext()
  const runtime = install(ctx, { disabled: false, memoryRoot: root })
  await runtime.ensureReady()
  const session = { id: 'session-1' }

  await emitTurn(handlers, session, 1, '我更喜欢用中文回答，请记住这一点。')
  await emit(handlers, 'agent/turn-stopping', { agent: { session }, turn: 1 })

  const memoryFiles = (await fs.readdir(path.join(root, 'memory'))).filter((name) => name.endsWith('.md'))
  assert.equal(memoryFiles.length, 1, 'one candidate note was written')
  const note = await fs.readFile(path.join(root, 'memory', memoryFiles[0]), 'utf8')
  assert.match(note, /^---\n/)
  assert.match(note, /status: pending/)
  assert.match(note, /kind: preference/)
  assert.match(note, /source: capture/)

  const proposed = userMessage('u2', '中文回答')
  const [decision] = await emit(
    handlers,
    'agent/pre-step',
    { agent: { session }, messages: [proposed], turn: 2, step: 0 },
    async () => ({ kind: 'enter', messages: [proposed] }),
  )
  assert.equal(decision.kind, 'enter')
  const injected = decision.messages.at(-1)
  assert.equal(injected.source.kind, 'inkvault-recall')
  assert.match(injected.content[0].text, /<inkvault-memory trust="untrusted-data">/)
  assert.match(injected.content[0].text, /preference/i)
})

test('recalls at most once per turn and only at step 0', async (t) => {
  const root = await temporaryVault(t)
  const { ctx, handlers } = fakeContext()
  const runtime = install(ctx, { disabled: false, memoryRoot: root })
  await runtime.remember({ body: '用户偏好：回答保持简洁。', kind: 'preference', tags: ['preference'], confidence: 0.9, origin: '' })

  const session = { id: 'session-2' }
  const messages = [userMessage('u1', '回答简洁')]
  const next = async () => ({ kind: 'enter', messages })
  const [first] = await emit(handlers, 'agent/pre-step', { agent: { session }, messages, turn: 5, step: 0 }, next)
  const [second] = await emit(handlers, 'agent/pre-step', { agent: { session }, messages, turn: 5, step: 1 }, next)
  const [third] = await emit(handlers, 'agent/pre-step', { agent: { session }, messages, turn: 6, step: 0 }, next)
  assert.equal(first.messages.length, 2)
  assert.equal(second.messages.length, 1, 'later steps of the same turn are not re-injected')
  assert.equal(third.messages.length, 2, 'a new turn injects again')
})

test('disabled: true keeps tools but performs no recall or capture', async (t) => {
  const root = await temporaryVault(t)
  const { ctx, handlers, tools } = fakeContext()
  const runtime = install(ctx, { disabled: true, memoryRoot: root })
  assert.equal(tools.size, 4)

  const session = { id: 'session-3' }
  await emitTurn(handlers, session, 1, '我更喜欢用中文回答。')
  await emit(handlers, 'agent/turn-stopping', { agent: { session }, turn: 1 })
  await assert.rejects(fs.readdir(path.join(root, 'memory')))

  const messages = [userMessage('u1', '中文回答')]
  const [decision] = await emit(
    handlers,
    'agent/pre-step',
    { agent: { session }, messages, turn: 2, step: 0 },
    async () => ({ kind: 'enter', messages }),
  )
  assert.equal(decision.messages.length, 1)
  // Explicit tools still work while automatic behavior is off.
  const remembered = await tools.get('inkvault_remember').execute({ text: '用户的时区是 Asia/Shanghai' }, { agent: { session } })
  assert.match(remembered.id, /^m-\d{8}-[a-z0-9]{6}$/)
  await runtime.ensureReady()
})

test('tools round-trip: remember, search, read, forget', async (t) => {
  const root = await temporaryVault(t)
  const { ctx, tools } = fakeContext()
  install(ctx, { disabled: false, memoryRoot: root })
  const exec = { agent: { session: { id: 'tool-session' } } }

  const remembered = await tools.get('inkvault_remember').execute(
    { text: '项目使用 pnpm 作为包管理器。', kind: 'project', tags: ['tooling'] },
    exec,
  )
  assert.equal(remembered.status, 'active')

  const found = await tools.get('inkvault_search').execute({ query: 'pnpm 包管理器' }, exec)
  assert.ok(found.results.some((entry) => entry.id === remembered.id))

  const read = await tools.get('inkvault_read').execute({ id: remembered.id }, exec)
  assert.match(read.body, /pnpm/)
  assert.equal(read.path, `memory/${remembered.id}.md`)

  const forgotten = await tools.get('inkvault_forget').execute({ id: remembered.id, reason: 'test' }, exec)
  assert.equal(forgotten.archived, true)
  assert.match(forgotten.trashPath, /^\.trash\//)
  const readAfter = await tools.get('inkvault_read').execute({ id: remembered.id }, exec).then(
    () => undefined,
    (error) => error,
  )
  assert.ok(readAfter instanceof Error)
})

test('config validation falls back to defaults with issues', () => {
  const { config, issues } = resolveConfig({ injectBudgetTokens: 'lots', captureMaxPerTurn: 99, mystery: true })
  assert.equal(config.injectBudgetTokens, 800)
  assert.equal(config.captureMaxPerTurn, 2)
  assert.equal(config.disabled, true)
  assert.ok(issues.some((issue) => issue.includes('injectBudgetTokens')))
  assert.ok(issues.some((issue) => issue.includes('mystery')))
})

// The host registry accepts only this JSON Schema subset (`dsh-tools`
// `assertSupportedJsonSchema`). `required` is an array of property names on the
// object node; a boolean `required` on a property would reject the whole tool.
const SUPPORTED_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])
const SUPPORTED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/** Walk one schema and assert only the host-supported subset is used. */
function assertSupportedSubset(schema, where) {
  assert.ok(schema !== null && typeof schema === 'object' && !Array.isArray(schema), `${where}: must be a schema object`)
  for (const key of Object.keys(schema)) {
    assert.ok(SUPPORTED_KEYWORDS.has(key), `${where}: keyword "${key}" is not supported`)
  }
  for (const annotation of ['description', 'title']) {
    if (annotation in schema) assert.equal(typeof schema[annotation], 'string', `${where}.${annotation} must be a string`)
  }
  if ('enum' in schema) {
    assert.ok(Array.isArray(schema.enum) && schema.enum.length > 0, `${where}.enum must be a non-empty array`)
  }
  if ('oneOf' in schema) {
    assert.ok(!('type' in schema), `${where}: type and oneOf are mutually exclusive`)
    for (const [index, branch] of schema.oneOf.entries()) assertSupportedSubset(branch, `${where}.oneOf[${index}]`)
  }
  if (!('type' in schema)) return
  assert.ok(SUPPORTED_TYPES.has(schema.type), `${where}: unsupported type ${JSON.stringify(schema.type)}`)
  if (schema.type === 'object') {
    if ('required' in schema) {
      assert.ok(Array.isArray(schema.required), `${where}.required must be an array`)
      for (const name of schema.required) {
        assert.equal(typeof name, 'string', `${where}.required entries must be strings`)
        assert.ok(Object.hasOwn(schema.properties ?? {}, name), `${where}.required names unknown property "${name}"`)
      }
    }
    if ('additionalProperties' in schema) {
      assert.equal(typeof schema.additionalProperties, 'boolean', `${where}.additionalProperties must be boolean`)
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      assertSupportedSubset(child, `${where}.properties.${name}`)
    }
  }
  if (schema.type === 'array') assertSupportedSubset(schema.items, `${where}.items`)
}

test('every registered tool schema stays inside the host-supported JSON Schema subset', async (t) => {
  const root = await temporaryVault(t)
  const { ctx } = fakeContext()
  const runtime = install(ctx, { disabled: true, memoryRoot: root })
  const definitions = toolDefinitions(runtime)
  assert.equal(definitions.length, 4)
  for (const definition of definitions) {
    assert.equal(typeof definition.name, 'string')
    assert.equal(typeof definition.description, 'string')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assertSupportedSubset(definition.parameters, `${definition.name}.parameters`)
    assertSupportedSubset(definition.output.schema, `${definition.name}.output.schema`)
  }
})
