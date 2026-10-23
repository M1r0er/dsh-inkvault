/**
 * src/prompt.js — 「指令层」投递：把 `delivery: prompt` 的记忆条目注入
 * `system-prompt/assemble` 的 `assembly.contexts`（通道 B）。
 *
 * 与 `recall.js` 的分工：
 * - recall（通道 A）是**命中才给**的词法召回，包成一条 user 消息，信任等级
 *   `untrusted-data`，正文压成一行 160 字符摘要；
 * - prompt（通道 B）是**每步都在**的常驻块，包成 assembly context，正文完整，
 *   信任等级 `user-declared`（用户自己声明的长期约定）。
 *
 * 三条硬约束（来自宿主实现与灵枢的实战教训）：
 * 1. 文本必须过 {@link escapePromptBraces}：宿主对每个 context 文本做严格
 *    `{{variable}}` 插值，裸 `{{` 会让该轮 assemble 抛错、请求整体失败。
 * 2. 超长必须**拒绝**而不是截断：截断的规则比没有规则更危险。
 * 3. 只有 `status === 'active'` 且 `delivery === 'prompt'` 的条目才进指令层；
 *    `pending` 一律留在 recall 通道，避免自动抽取的东西直接变成指令。
 * @module dsh-inkvault/prompt
 */

/** 指令层块的边界标签名，用于让模型分辨「这是常驻约定」而非普通上下文。 */
export const DIRECTIVE_TAG = 'inkvault-directive'

/** 指令层文本的默认字符上限（超出则整块拒绝，不截断）。 */
export const MAX_DIRECTIVE_CHARS = 4000

/**
 * 打断宿主 `{{variable}}` 插值的唯一扫描锚点。
 * 把每一对相邻的 `{` 拆成 `{ {`；`}}` 不参与匹配，无需处理。幂等。
 * @param {string} text - 待注入的文本。
 * @returns {string} 已打断的文本。
 */
export function escapePromptBraces(text) {
  return String(text ?? '').replace(/\{\{/g, '{ {')
}

/**
 * 把指令层正文包进显式边界与固定声明句。
 * 声明句本身不含用户内容，位置固定，因此不能靠改写正文来伪造边界。
 * @param {string} body - 已排好序的条目正文。
 * @returns {string} 完整块文本。
 */
export function renderDirectiveBlock(body) {
  return [
    `<${DIRECTIVE_TAG} trust="user-declared">`,
    '以下条目由用户在其本地 Markdown 记忆库中显式声明为「长期约定」，每次请求都会重述，',
    '应当作为本次工作的默认前提遵守。它们不是当前会话里的消息：',
    '若与用户当前消息冲突，以当前消息为准。',
    '',
    body,
    `</${DIRECTIVE_TAG}>`,
  ].join('\n')
}

/**
 * 按 vault 条目构建指令层文本。
 *
 * 只取 `status === 'active'` 且 `delivery === 'prompt'` 的条目；正文完整保留，
 * 不做摘要。渲染后超过 `maxChars` 时返回 `{ text: null, overflow }`，由调用方
 * 告警并跳过——不截断、不丢弃单条来凑长度，否则「哪些规则生效」会随条目顺序
 * 静默漂移。
 * @param {Array<{ meta: object, body: string }>} entries - vault 条目。
 * @param {{ maxChars?: number }} [options] - 字符上限。
 * @returns {{ text: string, count: number } | { text: null, count: number, overflow: number, maxChars: number } | null} 结果，无条目时为 null。
 */
export function buildDirectiveText(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return null
  const maxChars = typeof options.maxChars === 'number' && Number.isFinite(options.maxChars) && options.maxChars > 0
    ? Math.floor(options.maxChars)
    : MAX_DIRECTIVE_CHARS

  const sections = []
  for (const entry of entries) {
    const meta = entry !== null && typeof entry === 'object' ? entry.meta : undefined
    if (meta === null || typeof meta !== 'object') continue
    if (meta.status !== 'active') continue
    if (meta.delivery !== 'prompt') continue
    const title = String(meta.title ?? '').replace(/\s+/g, ' ').trim() || 'untitled'
    const body = String(entry.body ?? '').trim()
    const id = String(meta.id ?? '').trim()
    sections.push(id === '' ? `### ${title}\n${body}` : `### ${title} (${id})\n${body}`)
  }
  if (sections.length === 0) return null

  const rendered = renderDirectiveBlock(sections.join('\n\n'))
  if (rendered.length > maxChars) {
    return { text: null, count: sections.length, overflow: rendered.length, maxChars }
  }
  return { text: escapePromptBraces(rendered), count: sections.length }
}
