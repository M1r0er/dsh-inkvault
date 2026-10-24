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
    // 0.5.0 ships `memoryEnabled: false`; the memory lane is a fallback, so the
    // tests that exercise it opt in explicitly and the ones that assert the
    // shipped posture opt out.
    memoryEnabled: true,
    memoryRoot: folders.memoryRoot,
    knowledgeRoot: folders.knowledgeRoot,
    ...overrides,
  })
  return { ctx, handlers, tools, runtime }
}

/** Blocks pushed by the directive lane (the hint lane shares the same pass). */
function directiveBlocks(assembly) {
  return assembly.contexts.filter((block) => block.name === 'inkvault:directives')
}

/** Blocks pushed by the knowledge capability-hint lane. */
function hintBlocks(assembly) {
  return assembly.contexts.filter((block) => block.name === 'inkvault:knowledge-hint')
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
      'inkvault_forget', 'inkvault_note_forget', 'inkvault_note_list', 'inkvault_note_read',
      'inkvault_note_save', 'inkvault_note_search', 'inkvault_note_update',
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

test('knowledge full chain: save into a folder, list it, update it, read links, forget it', async (t) => {
  const folders = await temporaryVault(t)
  const { tools } = installWith(folders)
  const exec = { agent: { session: { id: 'chain-session' } } }

  const saved = await tools.get('inkvault_note_save').execute(
    { text: '插件上架社区市场的索引流程。', title: '市场索引流程', kind: 'reference', tags: ['dsh', 'plugin'], folder: 'dsh-plugin' },
    exec,
  )
  assert.equal(saved.path, `notes/dsh-plugin/${saved.id}.md`)
  assert.ok(await fs.stat(path.join(folders.knowledgeRoot, 'notes', 'dsh-plugin', `${saved.id}.md`)))

  // list: the note written a moment ago is visible again (the 0.4.0 gap).
  const listed = await tools.get('inkvault_note_list').execute({}, exec)
  assert.equal(listed.total, 1)
  assert.deepEqual(listed.notes[0], {
    id: saved.id,
    title: '市场索引流程',
    kind: 'reference',
    updated: listed.notes[0].updated,
    tags: ['dsh', 'plugin'],
    folder: 'dsh-plugin',
  })

  const byFolder = await tools.get('inkvault_note_list').execute({ folder: 'dsh-plugin' }, exec)
  assert.equal(byFolder.notes.length, 1)
  const otherFolder = await tools.get('inkvault_note_list').execute({ folder: 'notes' }, exec)
  assert.equal(otherFolder.notes.length, 0)

  const byTag = await tools.get('inkvault_note_list').execute({ tags: ['dsh', 'plugin'] }, exec)
  assert.equal(byTag.notes.length, 1)
  const missingTag = await tools.get('inkvault_note_list').execute({ tags: ['dsh', 'absent'] }, exec)
  assert.equal(missingTag.notes.length, 0, 'tags are AND-combined')

  // update: title changes, body and kind survive, updated is refreshed.
  const before = listed.notes[0].updated
  const updated = await tools.get('inkvault_note_update').execute({ id: saved.id, title: '市场索引流程 v2' }, exec)
  assert.equal(updated.title, '市场索引流程 v2')
  assert.equal(updated.path, saved.path, 'an update never moves the file')
  assert.ok(updated.updated >= before)

  const read = await tools.get('inkvault_note_read').execute({ id: saved.id }, exec)
  assert.match(read.body, /索引流程/)
  assert.ok(Array.isArray(read.links), 'links is always an array')
  assert.ok(Array.isArray(read.backlinks), 'backlinks is always an array')

  // forget: the file leaves notes/ for .trash/ and can be restored.
  const forgotten = await tools.get('inkvault_note_forget').execute({ id: saved.id, reason: 'test' }, exec)
  assert.equal(forgotten.id, saved.id)
  assert.match(forgotten.trashPath, /^\.trash\//)
  assert.ok(await fs.stat(path.join(folders.knowledgeRoot, forgotten.trashPath)))
  const afterForget = await tools.get('inkvault_note_list').execute({}, exec)
  assert.equal(afterForget.total, 0)

  await assert.rejects(
    () => tools.get('inkvault_note_forget').execute({ id: saved.id }, exec),
    /knowledge note not found/,
  )
  await assert.rejects(
    () => tools.get('inkvault_note_update').execute({ id: 'm-20260101-abcdef', title: 'x' }, exec),
    /knowledge note not found/,
  )
})

test('note_save rejects a folder that would escape the knowledge folder', async (t) => {
  const folders = await temporaryVault(t)
  const { tools } = installWith(folders)
  const exec = { agent: { session: { id: 'folder-session' } } }
  for (const folder of ['../escape', 'a/../../b', 'bad name', '/absolute']) {
    await assert.rejects(
      () => tools.get('inkvault_note_save').execute({ text: 'x', folder }, exec),
      /folder/,
      `folder ${JSON.stringify(folder)} must be rejected`,
    )
  }
})

test('note_search exposes kinds and tags filters', async (t) => {
  const folders = await temporaryVault(t)
  const { tools } = installWith(folders)
  const exec = { agent: { session: { id: 'search-session' } } }
  await tools.get('inkvault_note_save').execute({ text: 'pnpm 工作区约定。', kind: 'decision', tags: ['tooling'] }, exec)
  await tools.get('inkvault_note_save').execute({ text: 'pnpm 使用手册。', kind: 'reference', tags: ['tooling', 'pnpm'] }, exec)

  const search = tools.get('inkvault_note_search')
  assert.deepEqual(search.parameters.properties.kinds.items.enum, [
    'reference', 'fact', 'decision', 'project', 'preference', 'task',
  ])

  const all = await search.execute({ query: 'pnpm' }, exec)
  assert.equal(all.results.length, 2)

  const decisions = await search.execute({ query: 'pnpm', kinds: ['decision'] }, exec)
  assert.equal(decisions.results.length, 1)
  assert.equal(decisions.results[0].kind, 'decision')

  const tagged = await search.execute({ query: 'pnpm', tags: ['tooling', 'pnpm'] }, exec)
  assert.equal(tagged.results.length, 1, 'tags are AND-combined')
})

test('note_save keeps its description short enough to stay a prompt-cost tool', async (t) => {
  const folders = await temporaryVault(t)
  const { tools } = installWith(folders, { memoryEnabled: false })
  const description = tools.get('inkvault_note_save').description
  assert.ok(description.length <= 350, `note_save description is ${description.length} chars, budget 350`)
  assert.match(description, /store, keep/i, 'the "user says store/keep" anchor must survive')
})

test('note_list validates its limit and defaults to 20', async (t) => {
  const folders = await temporaryVault(t)
  const { tools } = installWith(folders)
  const exec = { agent: { session: { id: 'limit-session' } } }
  const list = tools.get('inkvault_note_list')
  await assert.rejects(() => list.execute({ limit: 0 }, exec), /limit must be an integer/)
  await assert.rejects(() => list.execute({ limit: 51 }, exec), /limit must be an integer/)
  await assert.rejects(() => list.execute({ limit: 1.5 }, exec), /limit must be an integer/)
  const empty = await list.execute({}, exec)
  assert.deepEqual(empty, { notes: [], total: 0 })
})

test('feature switches are independent: memory off keeps knowledge tools only', async (t) => {
  const folders = await temporaryVault(t)
  const { tools, handlers } = installWith(folders, { memoryEnabled: false })
  assert.deepEqual(
    [...tools.keys()].sort(),
    [
      'inkvault_note_forget', 'inkvault_note_list', 'inkvault_note_read', 'inkvault_note_save',
      'inkvault_note_search', 'inkvault_note_update', 'inkvault_status',
    ],
  )
  assert.equal(tools.size, 7, 'the knowledge-only surface is exactly 7 tools')
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
  install(ctx, { disabled: true, memoryEnabled: true, memoryRoot: folders.memoryRoot, knowledgeRoot: folders.knowledgeRoot })
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
  assert.ok(runtime.issues.some((issue) => issue.includes('knowledgeRoot is unset')))
  // The memory lane ships disabled, so an unset memoryRoot is not an issue —
  // only an explicitly enabled lane with no folder is worth reporting.
  assert.equal(runtime.issues.some((issue) => issue.includes('memoryRoot is unset')), false)

  const status = await tools.get('inkvault_status').execute({}, {})
  assert.equal(status.memory, undefined, 'an inactive memory lane is not reported at all')
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
  assert.match(status.knowledge.indexFile, /\.inkvault[\\/]index\.json$/)
})

test('status omits the memory section when the memory feature is off', async (t) => {
  const folders = await temporaryVault(t)
  const { tools } = installWith(folders, { memoryEnabled: false })
  await tools.get('inkvault_note_save').execute({ text: '只有知识库。' }, {})
  const status = await tools.get('inkvault_status').execute({}, {})
  assert.equal(Object.hasOwn(status, 'memory'), false, 'no memory key at all')
  assert.equal(status.knowledge.configured, true)
  assert.equal(status.knowledge.notes, 1)

  const definition = tools.get('inkvault_status')
  const rendered = definition.output.render({}, status)
  assert.doesNotMatch(rendered[0].text, /memory/i)
  assert.match(rendered[0].text, /knowledge: active/)
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
  // 0.5.0 posture: the memory lane is off by default, so an unset memoryRoot is
  // expected rather than reported. The knowledge lane is on, so it IS reported.
  assert.equal(config.memoryEnabled, false)
  assert.equal(issues.some((issue) => issue.includes('memoryRoot is unset')), false)
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
    // Two lanes ride the same assemble pass: the standing directives and the
    // knowledge capability hint. Directives come first, so contexts[0] is stable.
    assert.deepEqual(assembly.contexts.map((block) => block.name), ['inkvault:directives', 'inkvault:knowledge-hint'])
    assert.equal(assembly.contexts[0].name, 'inkvault:directives')
    assert.match(assembly.contexts[0].text, /inkvault-directive/)
    assert.match(assembly.contexts[0].text, /始终用中文回答/)
    // The recall-lane note stays out of the directive block.
    assert.doesNotMatch(assembly.contexts[0].text, /pnpm/)
  }
})

test('knowledge hint: reaches the system prompt with the memory lane off', async (t) => {
  const folders = await temporaryVault(t)
  // 0.5.0 posture: knowledge on, memory off, hint on by default.
  const { handlers } = installWith(folders, { memoryEnabled: false })

  for (let pass = 0; pass < 2; pass += 1) {
    const assembly = { contexts: [] }
    const [result] = await emit(handlers, 'system-prompt/assemble', assembly, {}, async () => 'assembled')
    assert.equal(result, 'assembled')
    const hints = hintBlocks(assembly)
    assert.equal(hints.length, 1, 'exactly one hint block per pass')
    assert.equal(hints[0].text, hints[0].text.trim())
    assert.match(hints[0].text, /Obsidian/)
    assert.match(hints[0].text, /inkvault_note_save/)
    assert.match(hints[0].text, /inkvault_note_search/)
    // The text must be byte-identical across passes or the Host appends a new
    // snapshot on every step and the prompt cache never hits.
    assert.equal(hints[0].text, assembly.contexts[0].text)
  }
})

test('knowledge hint: stable text, no turn counter, no timestamp', async (t) => {
  const folders = await temporaryVault(t)
  const { handlers } = installWith(folders, { memoryEnabled: false })
  const texts = []
  for (let pass = 0; pass < 3; pass += 1) {
    const assembly = { contexts: [] }
    await emit(handlers, 'system-prompt/assemble', assembly, {}, async () => 'ok')
    texts.push(hintBlocks(assembly)[0].text)
  }
  assert.equal(new Set(texts).size, 1, 'the hint text never changes between passes')
  assert.ok(texts[0].length <= 200, `hint stays inside its 200-character budget, got ${texts[0].length}`)
  // The Host interpolates `{{variable}}`; a bare `{{` would throw and kill the turn.
  assert.doesNotMatch(texts[0], /\{\{/)
})

test('knowledge hint: honours the config switch and the knowledge lane', async (t) => {
  const folders = await temporaryVault(t)

  const offBySwitch = installWith(folders, { memoryEnabled: false, knowledgeHint: false })
  const offAssembly = { contexts: [] }
  await emit(offBySwitch.handlers, 'system-prompt/assemble', offAssembly, {}, async () => 'ok')
  assert.equal(hintBlocks(offAssembly).length, 0, 'knowledgeHint: false suppresses the block')

  const offByKnowledge = installWith(folders, { memoryEnabled: false, knowledgeEnabled: false })
  const noKnowledgeAssembly = { contexts: [] }
  await emit(offByKnowledge.handlers, 'system-prompt/assemble', noKnowledgeAssembly, {}, async () => 'ok')
  assert.equal(hintBlocks(noKnowledgeAssembly).length, 0, 'an inactive knowledge lane injects nothing')

  // No knowledge root: enabled but unusable, so the hint must not promise it.
  const bare = fakeContext()
  install(bare.ctx, { disabled: false, memoryEnabled: false, knowledgeRoot: '' })
  const bareAssembly = { contexts: [] }
  await emit(bare.handlers, 'system-prompt/assemble', bareAssembly, {}, async () => 'ok')
  assert.equal(hintBlocks(bareAssembly).length, 0, 'no knowledge folder means no hint')
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
  assert.equal(directiveBlocks(assembly).length, 0, 'a pending directive must not be injected')
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
  assert.equal(directiveBlocks(offAssembly).length, 0)

  // No memory root: the directive lane is inert, but the knowledge hint still
  // rides the same pass — the two lanes are independent.
  const bare = fakeContext()
  install(bare.ctx, { disabled: false, memoryRoot: '', knowledgeRoot: folders.knowledgeRoot })
  const bareAssembly = { contexts: [] }
  await emit(bare.handlers, 'system-prompt/assemble', bareAssembly, {}, async () => 'ok')
  assert.equal(directiveBlocks(bareAssembly).length, 0)
  assert.equal(hintBlocks(bareAssembly).length, 1, 'the hint does not depend on the memory lane')
})

test('directive lane: an oversized block is skipped with a warning, never truncated', async (t) => {
  const folders = await temporaryVault(t)
  const warnings = []
  const { ctx, handlers, tools } = fakeContext()
  ctx.logger.warn = (message) => warnings.push(String(message))
  install(ctx, { disabled: false, memoryEnabled: true, memoryRoot: folders.memoryRoot, knowledgeRoot: folders.knowledgeRoot, maxDirectiveChars: 200 })
  const exec = { agent: { session: { id: 'big-session' } } }
  await tools.get('inkvault_remember').execute(
    { text: `始终用中文回答。${'补'.repeat(400)}`, delivery: 'prompt' },
    exec,
  )
  const assembly = { contexts: [] }
  await emit(handlers, 'system-prompt/assemble', assembly, {}, async () => 'ok')
  assert.equal(directiveBlocks(assembly).length, 0, 'oversized directive is refused, not cut')
  assert.ok(warnings.some((line) => line.includes('maxDirectiveChars')), 'the skip is logged')
})

test('directive lane: a throwing listener never fails the assemble pass', async (t) => {
  const folders = await temporaryVault(t)
  const { ctx, handlers, tools } = fakeContext()
  install(ctx, { disabled: false, memoryEnabled: true, memoryRoot: folders.memoryRoot, knowledgeRoot: folders.knowledgeRoot })
  const exec = { agent: { session: { id: 'throw-session' } } }
  await tools.get('inkvault_remember').execute({ text: '规则', delivery: 'prompt' }, exec)

  // Simulate a store failure mid-pass.
  const runtime = install(ctx, { disabled: false, memoryEnabled: true, memoryRoot: folders.memoryRoot, knowledgeRoot: folders.knowledgeRoot })
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
  assert.equal(definitions.length, 11)
  for (const definition of definitions) {
    assert.equal(typeof definition.name, 'string')
    assert.equal(typeof definition.description, 'string')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assertSupportedSubset(definition.parameters, `${definition.name}.parameters`)
    assertSupportedSubset(definition.output.schema, `${definition.name}.output.schema`)
  }
})

test('the knowledge-only tool surface stays inside the 2200-character schema budget', async (t) => {
  const folders = await temporaryVault(t)
  const { runtime } = installWith(folders, { memoryEnabled: false })
  const definitions = toolDefinitions(runtime)
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    [
      'inkvault_note_save', 'inkvault_note_search', 'inkvault_note_read',
      'inkvault_note_list', 'inkvault_note_update', 'inkvault_note_forget', 'inkvault_status',
    ],
  )
  const sizes = definitions.map((definition) => JSON.stringify(definition.parameters).length)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  assert.ok(total <= 2200, `schema budget exceeded: ${total} > 2200 (${definitions.map((d, i) => `${d.name}=${sizes[i]}`).join(' ')})`)
})
