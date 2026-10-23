/**
 * Integration tests for the plugin wiring: fake Cordis context, real stores on
 * temporary folders. Exercises both features (memory + knowledge), their
 * independent switches, and all tool schemas.
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

/** Create a temporary workspace with separate memory and knowledge folders. */
async function temporaryVault(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkvault-plugin-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return {
    root,
    memoryRoot: path.join(root, 'memory-vault'),
    knowledgeRoot: path.join(root, 'knowledge-vault'),
  }
}

/** Install the plugin against a temporary pair of vaults. */
function installWith(folders, overrides = {}) {
  const { ctx, handlers, tools } = fakeContext()
  const runtime = install(ctx, {
    disabled: false,
    memoryRoot: folders.memoryRoot,
    knowledgeRoot: folders.knowledgeRoot,
    ...overrides,
  })
  return { ctx, handlers, tools, runtime }
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

test('registers memory, knowledge and status tools for a fully configured install', async (t) => {
  const folders = await temporaryVault(t)
  const { tools } = installWith(folders)
  assert.deepEqual(
    [...tools.keys()].sort(),
    [
      'inkvault_forget', 'inkvault_note_read', 'inkvault_note_save', 'inkvault_note_search',
      'inkvault_read', 'inkvault_remember', 'inkvault_search', 'inkvault_status',
    ],
  )
})

test('captures a preference at turn end, then recalls it at the next turn', async (t) => {
  const folders = await temporaryVault(t)
  const { handlers, runtime } = installWith(folders)
  await runtime.ensureMemoryReady()
  const session = { id: 'session-1' }

  await emitTurn(handlers, session, 1, '我更喜欢用中文回答，请记住这一点。')
  await emit(handlers, 'agent/turn-stopping', { agent: { session }, turn: 1 })

  const memoryFiles = (await fs.readdir(path.join(folders.memoryRoot, 'memory'))).filter((name) => name.endsWith('.md'))
  assert.equal(memoryFiles.length, 1, 'one candidate note was written')
  const note = await fs.readFile(path.join(folders.memoryRoot, 'memory', memoryFiles[0]), 'utf8')
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
  const folders = await temporaryVault(t)
  const { handlers, runtime } = installWith(folders)
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

test('knowledge notes land in the chosen folder and round-trip through the tools', async (t) => {
  const folders = await temporaryVault(t)
  const { tools } = installWith(folders)
  const exec = { agent: { session: { id: 'knowledge-session' } } }

  const saved = await tools.get('inkvault_note_save').execute(
    { text: 'Obsidian 的双链用 [[笔记名]] 表示。', kind: 'reference', tags: ['obsidian'] },
    exec,
  )
  const notePath = path.join(folders.knowledgeRoot, 'notes', `${saved.id}.md`)
  const onDisk = await fs.readFile(notePath, 'utf8')
  assert.match(onDisk, /Obsidian 的双链/)
  assert.match(onDisk, /source: manual/)

  const found = await tools.get('inkvault_note_search').execute({ query: '双链 Obsidian' }, exec)
  assert.ok(found.results.some((entry) => entry.id === saved.id))

  const read = await tools.get('inkvault_note_read').execute({ id: saved.id }, exec)
  assert.match(read.body, /双链/)
  assert.equal(read.path, `notes/${saved.id}.md`)

  // The memory vault is a different folder and stayed untouched by knowledge writes.
  assert.deepEqual(await fs.readdir(path.join(folders.memoryRoot, 'memory')), [])
})

test('feature switches are independent: memory off keeps knowledge tools only', async (t) => {
  const folders = await temporaryVault(t)
  const { tools, handlers } = installWith(folders, { memoryEnabled: false })
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['inkvault_note_read', 'inkvault_note_save', 'inkvault_note_search', 'inkvault_status'],
  )
  const session = { id: 'session-3' }
  await emitTurn(handlers, session, 1, '我更喜欢用中文回答。')
  await emit(handlers, 'agent/turn-stopping', { agent: { session }, turn: 1 })
  await assert.rejects(fs.readdir(path.join(folders.memoryRoot, 'memory')))
})

test('feature switches are independent: knowledge off keeps memory tools only', async (t) => {
  const folders = await temporaryVault(t)
  const { tools } = installWith(folders, { knowledgeEnabled: false })
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['inkvault_forget', 'inkvault_read', 'inkvault_remember', 'inkvault_search', 'inkvault_status'],
  )
})

test('disabled: true registers nothing (behavior back to the original state)', async (t) => {
  const folders = await temporaryVault(t)
  const { ctx, tools } = fakeContext()
  install(ctx, { disabled: true, memoryRoot: folders.memoryRoot, knowledgeRoot: folders.knowledgeRoot })
  assert.equal(tools.size, 0)
})

test('unset roots create no folders and leave only the status tool', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkvault-unset-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const { ctx, tools } = fakeContext()
  const runtime = install(ctx, { disabled: false, memoryRoot: '', knowledgeRoot: '' })
  assert.deepEqual([...tools.keys()], ['inkvault_status'])
  assert.equal(runtime.memoryOn, false)
  assert.equal(runtime.knowledgeOn, false)
  assert.ok(runtime.issues.some((issue) => issue.includes('memoryRoot is unset')))
  assert.ok(runtime.issues.some((issue) => issue.includes('knowledgeRoot is unset')))

  const status = await tools.get('inkvault_status').execute({}, {})
  assert.equal(status.memory.configured, false)
  assert.equal(status.memory.root, '')
  assert.equal(status.knowledge.configured, false)
  // Nothing was created anywhere on disk.
  assert.deepEqual(await fs.readdir(root), [])
})

test('status reports where each vault is', async (t) => {
  const folders = await temporaryVault(t)
  const { tools } = installWith(folders)
  await tools.get('inkvault_remember').execute({ text: '状态检查用记忆。' }, {})
  await tools.get('inkvault_note_save').execute({ text: '状态检查用知识。' }, {})
  const status = await tools.get('inkvault_status').execute({}, {})
  assert.equal(status.memory.configured, true)
  assert.equal(status.memory.root, folders.memoryRoot)
  assert.equal(status.memory.notes, 1)
  assert.equal(status.knowledge.configured, true)
  assert.equal(status.knowledge.root, folders.knowledgeRoot)
  assert.equal(status.knowledge.notes, 1)
  assert.match(status.memory.indexFile, /\.inkvault[\\/]index\.json$/)
})

test('memory tools round-trip: remember, search, read, forget', async (t) => {
  const folders = await temporaryVault(t)
  const { tools } = installWith(folders)
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

test('config validation: no invented default folders, bad values fall back with issues', () => {
  const { config, issues } = resolveConfig({ injectBudgetTokens: 'lots', captureMaxPerTurn: 99, mystery: true })
  assert.equal(config.injectBudgetTokens, 800)
  assert.equal(config.captureMaxPerTurn, 2)
  assert.equal(config.disabled, true)
  assert.equal(config.memoryRoot, '')
  assert.equal(config.knowledgeRoot, '')
  assert.ok(issues.some((issue) => issue.includes('injectBudgetTokens')))
  assert.ok(issues.some((issue) => issue.includes('mystery')))
  assert.ok(issues.some((issue) => issue.includes('memoryRoot is unset')))
})

test('directive lane: an active prompt entry reaches assembly.contexts on every pass', async (t) => {
  const folders = await temporaryVault(t)
  const { handlers, tools } = installWith(folders)
  const exec = { agent: { session: { id: 'directive-session' } } }

  await tools.get('inkvault_remember').execute(
    { text: '始终用中文回答。', title: '语言约定', delivery: 'prompt' },
    exec,
  )
  await tools.get('inkvault_remember').execute(
    { text: '项目使用 pnpm。', title: '包管理器' },
    exec,
  )

  // Two independent passes: the block must be re-pushed each time, never
  // skipped, or the Host records a changed snapshot and appends an extra copy.
  for (let pass = 0; pass < 2; pass += 1) {
    const assembly = { contexts: [] }
    let sawNext = false
    const [result] = await emit(handlers, 'system-prompt/assemble', assembly, {}, async () => {
      sawNext = true
      return 'assembled'
    })
    assert.equal(sawNext, true, 'the listener must always call next()')
    assert.equal(result, 'assembled')
    assert.equal(assembly.contexts.length, 1)
    assert.equal(assembly.contexts[0].name, 'inkvault:directives')
    assert.match(assembly.contexts[0].text, /inkvault-directive/)
    assert.match(assembly.contexts[0].text, /始终用中文回答/)
    // The recall-lane note stays out of the directive block.
    assert.doesNotMatch(assembly.contexts[0].text, /pnpm/)
  }
})

test('directive lane: pending or recall-only entries never enter the system prompt', async (t) => {
  const folders = await temporaryVault(t)
  const { handlers, runtime } = installWith(folders)
  await runtime.ensureMemoryReady()
  const session = { id: 'pending-session' }

  // Capture writes status=pending, so even a strong directive stays out.
  await emitTurn(handlers, session, 1, '记住，以后都用中文回答。')
  await emit(handlers, 'agent/turn-stopping', { agent: { session }, turn: 1 })

  const assembly = { contexts: [] }
  await emit(handlers, 'system-prompt/assemble', assembly, {}, async () => 'assembled')
  assert.equal(assembly.contexts.length, 0, 'a pending directive must not be injected')
})

test('directive lane: disabled by config and inert without a memory root', async (t) => {
  const folders = await temporaryVault(t)
  const exec = { agent: { session: { id: 'off-session' } } }

  const withDirectivesOff = installWith(folders, { directives: false })
  await withDirectivesOff.tools.get('inkvault_remember').execute(
    { text: '始终用中文回答。', delivery: 'prompt' },
    exec,
  )
  const offAssembly = { contexts: [] }
  await emit(withDirectivesOff.handlers, 'system-prompt/assemble', offAssembly, {}, async () => 'ok')
  assert.equal(offAssembly.contexts.length, 0)

  // No memory root: the listener is still registered but produces nothing.
  const { ctx } = fakeContext()
  install(ctx, { disabled: false, memoryRoot: '', knowledgeRoot: folders.knowledgeRoot })
  const bareAssembly = { contexts: [] }
  const handlers = new Map()
  const bare = fakeContext()
  install(bare.ctx, { disabled: false, memoryRoot: '', knowledgeRoot: folders.knowledgeRoot })
  await emit(bare.handlers, 'system-prompt/assemble', bareAssembly, {}, async () => 'ok')
  assert.equal(bareAssembly.contexts.length, 0)
})

test('directive lane: an oversized block is skipped with a warning, never truncated', async (t) => {
  const folders = await temporaryVault(t)
  const warnings = []
  const { ctx, handlers, tools } = fakeContext()
  ctx.logger.warn = (message) => warnings.push(String(message))
  install(ctx, { disabled: false, memoryRoot: folders.memoryRoot, knowledgeRoot: folders.knowledgeRoot, maxDirectiveChars: 200 })
  const exec = { agent: { session: { id: 'big-session' } } }
  await tools.get('inkvault_remember').execute(
    { text: `始终用中文回答。${'补'.repeat(400)}`, delivery: 'prompt' },
    exec,
  )
  const assembly = { contexts: [] }
  await emit(handlers, 'system-prompt/assemble', assembly, {}, async () => 'ok')
  assert.equal(assembly.contexts.length, 0, 'oversized directive is refused, not cut')
  assert.ok(warnings.some((line) => line.includes('maxDirectiveChars')), 'the skip is logged')
})

test('directive lane: a throwing listener never fails the assemble pass', async (t) => {
  const folders = await temporaryVault(t)
  const { ctx, handlers, tools } = fakeContext()
  install(ctx, { disabled: false, memoryRoot: folders.memoryRoot, knowledgeRoot: folders.knowledgeRoot })
  const exec = { agent: { session: { id: 'throw-session' } } }
  await tools.get('inkvault_remember').execute({ text: '规则', delivery: 'prompt' }, exec)

  // Simulate a store failure mid-pass.
  const runtime = install(ctx, { disabled: false, memoryRoot: folders.memoryRoot, knowledgeRoot: folders.knowledgeRoot })
  runtime.memoryStore.listEntries = async () => { throw new Error('disk gone') }
  const assembly = { contexts: [] }
  const [result] = await emit(handlers, 'system-prompt/assemble', assembly, {}, async () => 'still-assembled')
  assert.equal(result, 'still-assembled')
})

test('inkvault_remember accepts delivery and rejects unknown values', async (t) => {
  const folders = await temporaryVault(t)
  const { tools, runtime } = installWith(folders)
  const exec = { agent: { session: { id: 'delivery-session' } } }
  const definition = tools.get('inkvault_remember')
  assert.deepEqual(definition.parameters.properties.delivery.enum, ['recall', 'prompt'])

  const saved = await definition.execute({ text: '规则正文', delivery: 'prompt' }, exec)
  const entry = await runtime.read(saved.id)
  assert.equal(entry.meta.delivery, 'prompt')

  const fallback = await definition.execute({ text: '普通正文' }, exec)
  const fallbackEntry = await runtime.read(fallback.id)
  assert.equal(fallbackEntry.meta.delivery, 'recall')

  await assert.rejects(
    () => definition.execute({ text: 'x', delivery: 'bogus' }, exec),
    /delivery must be one of/,
  )
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

test('every tool schema stays inside the host-supported JSON Schema subset', async (t) => {
  const folders = await temporaryVault(t)
  const { runtime } = installWith(folders)
  const definitions = toolDefinitions(runtime)
  assert.equal(definitions.length, 8)
  for (const definition of definitions) {
    assert.equal(typeof definition.name, 'string')
    assert.equal(typeof definition.description, 'string')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assertSupportedSubset(definition.parameters, `${definition.name}.parameters`)
    assertSupportedSubset(definition.output.schema, `${definition.name}.output.schema`)
  }
})
