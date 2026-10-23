/**
 * Model-facing tools: two feature sets plus a status tool.
 *
 * - memory: `inkvault_search` / `read` / `remember` / `forget`
 * - knowledge: `inkvault_note_save` / `note_search` / `note_read`
 * - `inkvault_status`: where each configured vault lives and how many notes it holds
 *
 * Definitions are passed to `ctx.tools.register` as plain objects with JSON
 * Schema contracts, so the plugin needs no `@deepseek-ai/*` import at runtime
 * (profile-linked bundles cannot resolve them). The host registry accepts only
 * this subset: `type` / `oneOf` / `properties` / `required` /
 * `additionalProperties` / `items` / `enum` / `const` plus annotations.
 * `required` is an array of names on the object node, never a boolean on a
 * property.
 * @module dsh-inkvault/tools
 */
import { makeEntryId, ENTRY_DELIVERIES } from './frontmatter.js'
import { snippetOf } from './recall.js'

const KINDS = ['preference', 'fact', 'decision', 'project', 'reference', 'task']
const DELIVERIES = [...ENTRY_DELIVERIES]
const KNOWLEDGE_KINDS = ['reference', 'fact', 'decision', 'project', 'preference', 'task']
const STATUSES = ['active', 'pending', 'superseded', 'archived']

/** Render one text block array, the only content shape these tools produce. */
function text(value) {
  return [{ type: 'text', text: value }]
}

/** Object schema helper with an explicit required-name list. */
function objectSchema(properties, required) {
  return { type: 'object', additionalProperties: false, required, properties }
}

const ENTRY_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'kind', 'status', 'score', 'snippet'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    kind: { type: 'string', enum: KINDS },
    status: { type: 'string', enum: STATUSES },
    score: { type: 'number' },
    snippet: { type: 'string' },
  },
}

const SEARCH_OUTPUT_SCHEMA = objectSchema(
  { results: { type: 'array', items: ENTRY_SUMMARY_SCHEMA } },
  ['results'],
)

const READ_OUTPUT_SCHEMA = objectSchema(
  {
    id: { type: 'string' },
    title: { type: 'string' },
    kind: { type: 'string', enum: KINDS },
    status: { type: 'string', enum: STATUSES },
    updated: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    path: { type: 'string' },
    body: { type: 'string' },
  },
  ['id', 'title', 'kind', 'status', 'updated', 'tags', 'path', 'body'],
)

const SAVE_OUTPUT_SCHEMA = objectSchema(
  {
    id: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string', enum: STATUSES },
    path: { type: 'string' },
  },
  ['id', 'title', 'status', 'path'],
)

const VAULT_STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['enabled', 'configured', 'root', 'contentDir', 'indexFile', 'notes'],
  properties: {
    enabled: { type: 'boolean' },
    configured: { type: 'boolean' },
    root: { type: 'string' },
    contentDir: { type: 'string' },
    indexFile: { type: 'string' },
    notes: { type: 'integer' },
    error: { type: 'string' },
  },
}

const STATUS_OUTPUT_SCHEMA = objectSchema(
  {
    disabled: { type: 'boolean' },
    configIssues: { type: 'array', items: { type: 'string' } },
    memory: VAULT_STATUS_SCHEMA,
    knowledge: VAULT_STATUS_SCHEMA,
  },
  ['disabled', 'configIssues', 'memory', 'knowledge'],
)

/** Report an archive result or a missing note. */
function archivedText(value) {
  if (!value.archived) return `No memory note with id ${value.id}.`
  return `Archived ${value.id}. The file is preserved at ${value.trashPath} and can be restored.`
}

/** Format one vault status line for the model. */
function vaultLine(label, vault) {
  if (!vault.configured) {
    const reason = vault.root === ''
      ? `${label}Root is unset`
      : `${label}Enabled is false`
    return `- ${label}: inactive (${reason})`
  }
  const suffix = vault.error === undefined ? `${vault.notes} note(s)` : `error: ${vault.error}`
  return `- ${label}: active — root ${vault.root} — ${suffix}`
}

/** The four memory-vault tools. */
export function memoryToolDefinitions(runtime) {
  return [
    {
      name: 'inkvault_search',
      description:
        'Search the agent\'s long-term memory vault (a chosen Obsidian folder). Returns ranked note summaries with ids; '
        + 'call inkvault_read for the full text of one note. Ranking is lexical, so short exact keywords work best.',
      parameters: objectSchema(
        {
          query: { type: 'string', description: 'Keywords or a short question, in the language of the stored notes.' },
          limit: { type: 'integer', description: 'Maximum number of results, 1-20. Defaults to 8.' },
          kinds: {
            type: 'array',
            items: { type: 'string', enum: KINDS },
            description: 'Restrict results to these note kinds; omit to search all kinds.',
          },
        },
        ['query'],
      ),
      output: {
        schema: SEARCH_OUTPUT_SCHEMA,
        render: (_args, value) => {
          if (value.results.length === 0) return text('No memory notes matched.')
          const lines = value.results.map((entry) => `${entry.id} [${entry.kind}/${entry.status}] ${entry.title} — ${entry.snippet}`)
          return text(`Found ${value.results.length} memory note(s):\n${lines.join('\n')}`)
        },
      },
      async execute(args, exec) {
        const limit = args.limit ?? 8
        if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be an integer between 1 and 20')
        runtime.debug('search', { query: args.query, limit })
        const hits = await runtime.search(String(args.query ?? ''), {
          limit,
          kinds: Array.isArray(args.kinds) && args.kinds.length > 0 ? args.kinds : null,
        })
        return {
          results: hits.map((hit) => ({
            id: hit.entry.meta.id,
            title: hit.entry.meta.title,
            kind: hit.entry.meta.kind,
            status: hit.entry.meta.status,
            score: Math.round(hit.score * 1000) / 1000,
            snippet: snippetOf(hit.entry.body),
          })),
        }
      },
    },
    {
      name: 'inkvault_read',
      description: 'Read one full memory note from the memory vault by its id.',
      parameters: objectSchema(
        { id: { type: 'string', description: 'Note id as returned by inkvault_search or inkvault_remember.' } },
        ['id'],
      ),
      output: {
        schema: READ_OUTPUT_SCHEMA,
        render: (_args, value) => text(
          `${value.id} · ${value.title}\nkind: ${value.kind} · status: ${value.status} · updated: ${value.updated}\n`
          + `tags: ${value.tags.join(', ') || '(none)'} · path: ${value.path}\n\n${value.body}`,
        ),
      },
      async execute(args) {
        runtime.debug('read', { id: args.id })
        const record = await runtime.read(String(args.id ?? ''))
        if (record === undefined) throw new Error(`memory note not found: ${args.id}`)
        return {
          id: record.meta.id,
          title: record.meta.title,
          kind: record.meta.kind,
          status: record.meta.status,
          updated: record.meta.updated,
          tags: record.meta.tags,
          path: record.path,
          body: record.body,
        }
      },
    },
    {
      name: 'inkvault_remember',
      description:
        'Save one durable note into the agent\'s memory vault. Use it when the user asks you to remember '
        + 'something or states a long-lived preference, fact, or decision. Do not store secrets, credentials, or one-off task state.',
      parameters: objectSchema(
        {
          text: { type: 'string', description: 'Note body: one self-contained fact, preference, or decision. Markdown allowed.' },
          title: { type: 'string', description: 'Short title for listings; defaults to the first line of text.' },
          kind: { type: 'string', enum: KINDS, description: 'Note kind; defaults to fact.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase tags for keyword search.' },
          confidence: { type: 'number', description: 'How certain the note is, 0-1; defaults to 0.9.' },
          delivery: {
            type: 'string',
            enum: DELIVERIES,
            description: 'recall = reference data recalled by keyword match; prompt = user-declared directive kept in the system prompt every turn. Defaults to recall.',
          },
        },
        ['text'],
      ),
      output: {
        schema: SAVE_OUTPUT_SCHEMA,
        render: (_args, value) => text(`Saved ${value.id} (${value.status}) at ${value.path}: ${value.title}`),
      },
      async execute(args, exec) {
        const body = String(args.text ?? '').trim()
        if (body === '') throw new Error('text must not be empty')
        const confidence = args.confidence ?? 0.9
        if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new Error('confidence must be between 0 and 1')
        const kind = args.kind ?? 'fact'
        if (!KINDS.includes(kind)) throw new Error(`kind must be one of: ${KINDS.join(', ')}`)
        const delivery = args.delivery ?? 'recall'
        if (!DELIVERIES.includes(delivery)) throw new Error(`delivery must be one of: ${DELIVERIES.join(', ')}`)
        const record = await runtime.remember({
          body,
          kind,
          title: args.title,
          tags: Array.isArray(args.tags) ? args.tags : [],
          confidence,
          delivery,
          origin: exec?.agent?.session?.id ?? '',
          now: runtime.now(),
        })
        return { id: record.meta.id, title: record.meta.title, status: record.meta.status, path: record.path }
      },
    },
    {
      name: 'inkvault_forget',
      description:
        'Archive one memory note by id. The note moves to the vault\'s .trash directory instead of being deleted, '
        + 'so the user can restore it.',
      parameters: objectSchema(
        {
          id: { type: 'string', description: 'Note id to archive.' },
          reason: { type: 'string', description: 'Optional short reason recorded in the vault journal.' },
        },
        ['id'],
      ),
      output: {
        schema: objectSchema(
          { id: { type: 'string' }, archived: { type: 'boolean' }, trashPath: { type: 'string' } },
          ['id', 'archived', 'trashPath'],
        ),
        render: (_args, value) => text(archivedText(value)),
      },
      async execute(args) {
        runtime.debug('forget', { id: args.id })
        const result = await runtime.forget(String(args.id ?? ''), String(args.reason ?? ''))
        return {
          id: String(args.id ?? ''),
          archived: result !== undefined,
          trashPath: result?.trashPath ?? '',
        }
      },
    },
  ]
}

/** The three knowledge-vault tools. */
export function knowledgeToolDefinitions(runtime) {
  return [
    {
      name: 'inkvault_note_save',
      description:
        'Save a knowledge note into the user\'s chosen Obsidian knowledge folder. Use it when the user says to store, '
        + 'keep, or organize something they explained (a concept, how-to, decision, or reference). It only writes inside the configured folder.',
      parameters: objectSchema(
        {
          text: { type: 'string', description: 'Note body in Markdown: the knowledge to keep.' },
          title: { type: 'string', description: 'Short note title; defaults to the first line of text.' },
          kind: { type: 'string', enum: KNOWLEDGE_KINDS, description: 'Note kind; defaults to reference.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase tags.' },
        },
        ['text'],
      ),
      output: {
        schema: SAVE_OUTPUT_SCHEMA,
        render: (_args, value) => text(`Saved knowledge note ${value.id} at ${value.path}: ${value.title}`),
      },
      async execute(args, exec) {
        const body = String(args.text ?? '').trim()
        if (body === '') throw new Error('text must not be empty')
        const kind = args.kind ?? 'reference'
        if (!KNOWLEDGE_KINDS.includes(kind)) throw new Error(`kind must be one of: ${KNOWLEDGE_KINDS.join(', ')}`)
        const record = await runtime.noteSave({
          body,
          kind,
          title: args.title,
          tags: Array.isArray(args.tags) ? args.tags : [],
          origin: exec?.agent?.session?.id ?? '',
          now: runtime.now(),
        })
        return { id: record.meta.id, title: record.meta.title, status: record.meta.status, path: record.path }
      },
    },
    {
      name: 'inkvault_note_search',
      description: 'Search the knowledge notes stored in the configured Obsidian folder.',
      parameters: objectSchema(
        {
          query: { type: 'string', description: 'Keywords or a short question.' },
          limit: { type: 'integer', description: 'Maximum number of results, 1-20. Defaults to 8.' },
        },
        ['query'],
      ),
      output: {
        schema: SEARCH_OUTPUT_SCHEMA,
        render: (_args, value) => {
          if (value.results.length === 0) return text('No knowledge notes matched.')
          const lines = value.results.map((entry) => `${entry.id} [${entry.kind}] ${entry.title} — ${entry.snippet}`)
          return text(`Found ${value.results.length} knowledge note(s):\n${lines.join('\n')}`)
        },
      },
      async execute(args) {
        const limit = args.limit ?? 8
        if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be an integer between 1 and 20')
        const hits = await runtime.noteSearch(String(args.query ?? ''), { limit })
        return {
          results: hits.map((hit) => ({
            id: hit.entry.meta.id,
            title: hit.entry.meta.title,
            kind: hit.entry.meta.kind,
            status: hit.entry.meta.status,
            score: Math.round(hit.score * 1000) / 1000,
            snippet: snippetOf(hit.entry.body),
          })),
        }
      },
    },
    {
      name: 'inkvault_note_read',
      description: 'Read one full knowledge note from the configured folder by its id.',
      parameters: objectSchema(
        { id: { type: 'string', description: 'Note id as returned by inkvault_note_save or inkvault_note_search.' } },
        ['id'],
      ),
      output: {
        schema: READ_OUTPUT_SCHEMA,
        render: (_args, value) => text(`${value.id} · ${value.title}\nkind: ${value.kind} · updated: ${value.updated}\n`
          + `tags: ${value.tags.join(', ') || '(none)'} · path: ${value.path}\n\n${value.body}`),
      },
      async execute(args) {
        const record = await runtime.noteRead(String(args.id ?? ''))
        if (record === undefined) throw new Error(`knowledge note not found: ${args.id}`)
        return {
          id: record.meta.id,
          title: record.meta.title,
          kind: record.meta.kind,
          status: record.meta.status,
          updated: record.meta.updated,
          tags: record.meta.tags,
          path: record.path,
          body: record.body,
        }
      },
    },
  ]
}

/** The vault-location tool: always answers "where is my library?". */
export function statusToolDefinition(runtime) {
  return {
    name: 'inkvault_status',
    description:
      'Report where the configured Ink Vault folders are (memory vault and knowledge folder), whether each feature is '
      + 'active, and how many notes each holds. Use it when the user asks where their notes went or how Ink Vault is configured.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: {
      schema: STATUS_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const lines = [
          `Ink Vault status (disabled=${value.disabled})`,
          vaultLine('memory', value.memory),
          vaultLine('knowledge', value.knowledge),
        ]
        if (!value.memory.configured || !value.knowledge.configured) {
          lines.push('Configure memoryRoot / knowledgeRoot in the profile cordis.patch.yml (choose folders inside your Obsidian vault).')
        }
        if (value.configIssues.length > 0) lines.push(`config issues: ${value.configIssues.join('; ')}`)
        return text(lines.join('\n'))
      },
    },
    async execute() {
      return runtime.status()
    },
  }
}

/** Every tool definition the current configuration activates. */
export function toolDefinitions(runtime) {
  const definitions = []
  if (runtime.memoryOn) definitions.push(...memoryToolDefinitions(runtime))
  if (runtime.knowledgeOn) definitions.push(...knowledgeToolDefinitions(runtime))
  definitions.push(statusToolDefinition(runtime))
  return definitions
}

/**
 * Register the activated tools on a context, each owned by its own effect.
 * @param {object} ctx - plugin context exposing `tools` and `effect`.
 * @param {object} runtime - runtime returned by `createRuntime`.
 * @returns {() => void} combined disposer.
 */
export function registerTools(ctx, runtime) {
  const disposers = []
  for (const definition of toolDefinitions(runtime)) {
    disposers.push(ctx.effect(() => ctx.tools.register(definition)))
  }
  return () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* teardown is best-effort */ }
    }
  }
}

/** Generate the id of a note created from the model side. */
export function newRememberId(now, body) {
  return makeEntryId(now, body)
}
