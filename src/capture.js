/**
 * src/capture.js — 规则抽取「记忆候选」。
 *
 * 纯函数：不读写文件、不生成 id、不读时钟。调用方（turn/end 钩子）负责落盘与分配 id。
 * 所有规则中英双语、大小写不敏感；同一句命中多个规则时按 RULES 顺序取优先级最高的一个。
 */

/** 每轮默认最多产出的候选数（调用方可用 maxCandidates 覆盖）。 */
export const MAX_CANDIDATES_PER_TURN = 2;

/** 候选默认最低置信度（含等于）。 */
export const MIN_CONFIDENCE = 0.6;

/** 输入规范化上限：超出部分直接丢弃，避免一个超长回合拖垮规则匹配。 */
const MAX_TEXT_CHARS = 20000;

/** 句子的长度硬过滤（字符数）。 */
const MIN_SENTENCE_CHARS = 4;
const MAX_SENTENCE_CHARS = 500;

/** title = body 首行截断长度。 */
const MAX_TITLE_CHARS = 80;

/** 零宽字符 + 软连字符：不可见字符会破坏规则匹配，规范化时直接删除。 */
const ZERO_WIDTH_RE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

/** 句子边界：中文句末标点后直接切；ASCII !?; 与英文句点要求后面是空白/结尾（避免切开 `v0.1`、URL）。 */
const SENTENCE_BOUNDARY_RE = /(?<=[。！？；…])|(?<=[!?;])(?=\s|$)|\n+|(?<=\.)(?=\s|$)/;

/** 显式「记住」意图。detectRememberIntent 与 explicit 规则共用同一组触发词。 */
const EXPLICIT_TRIGGERS = [
  /记住/,
  /记一下/,
  /请记/,
  /帮我记/,
  /\bremember\s+that\b/i,
  /\bnote\s+that\b/i,
];

/** 偏好类触发词。 */
const PREFERENCE_RE =
  /我喜欢|我更喜欢|我偏好|我习惯|我通常|我不喜欢|我讨厌|别用|不要用|\bI\s+prefer\b|\bI\s+always\b|\bI\s+never\b|\bI\s+don['’]?t\s+like\b/i;

/** 决定类触发词。 */
const DECISION_RE =
  /决定|采用|定了|就用|选择用|结论是|\bwe\s+decided\b|\blet['’]?s\s+go\s+with\b|\bwe['’]?ll\s+use\b|\bwe\s+will\s+use\b/i;

/** 个人事实类触发词。中文模式允许「我的…是」「我在…工作/住」之间插入少量文字。 */
const PERSONAL_FACT_RE =
  /我叫|我的[^，。；！？,;!?\n]{0,16}是|我在[^，。；！？,;!?\n]{0,16}工作|我在[^，。；！？,;!?\n]{0,16}住|\bmy\s+name\s+is\b|\bI\s+work\s+at\b|\bI\s+live\s+in\b/i;

/** 项目/仓库约定类触发词。 */
const PROJECT_CONVENTION_RE =
  /这个项目|本项目|我们的项目|仓库约定|\bin\s+this\s+project\b|\bthis\s+repo(?:sitory)?\b|convention/i;

/**
 * 「陈述词」——用于把纯疑问句和带陈述成分的问句区分开（契约：纯疑问句跳过）。
 * 只放第一人称/断言性成分，不放 `convention`、`repo` 这类纯名词。
 */
const DECLARATIVE_CUES = [
  /我|咱/,
  /(?:^|[，,。；;：:\s])(?:是|叫|用|决定|采用|定了|结论|记住|记得|通常|从不|别|不要)/,
  /\b(?:i|we|my|our|me|prefer|like|dislike|decided|always|never|use|uses|work|live|name|remember|note)\b/i,
];

/**
 * 规则表，顺序即优先级（explicit 最高）。
 * kind 可以是固定值，也可以由命中句内容决定（explicit 依赖偏好词判定 preference/fact）。
 */
const RULES = [
  {
    rule: 'explicit',
    confidence: 0.95,
    test: (sentence) => EXPLICIT_TRIGGERS.some((re) => re.test(sentence)),
    kind: (sentence) => (PREFERENCE_RE.test(sentence) ? 'preference' : 'fact'),
  },
  {
    rule: 'preference',
    confidence: 0.8,
    test: (sentence) => PREFERENCE_RE.test(sentence),
    kind: () => 'preference',
  },
  {
    rule: 'decision',
    confidence: 0.75,
    test: (sentence) => DECISION_RE.test(sentence),
    kind: () => 'decision',
  },
  {
    rule: 'personal-fact',
    confidence: 0.7,
    test: (sentence) => PERSONAL_FACT_RE.test(sentence),
    kind: () => 'fact',
  },
  {
    rule: 'project-convention',
    confidence: 0.6,
    test: (sentence) => PROJECT_CONVENTION_RE.test(sentence),
    kind: () => 'project',
  },
];

/** 按码点计长度（CJK/emoji 都算 1 个字符）。 */
function charLength(text) {
  return Array.from(text).length;
}

/** 按码点截断，避免切断代理对。 */
function truncateChars(text, maxChars) {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('');
}

/** 文本规范化：统一换行、删零宽字符、折叠空白（保留换行作为句子边界）、限长。 */
function normalizeText(text) {
  if (typeof text !== 'string') return '';
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(ZERO_WIDTH_RE, '')
    .replace(/[^\S\n]+/g, ' ') // 水平空白（含制表符/全角空格）折叠成单个空格
    .replace(/ *\n */g, '\n') // 去掉换行两侧的空格
    .replace(/\n{2,}/g, '\n') // 空行折叠成一个换行
    .trim();
  return truncateChars(normalized, MAX_TEXT_CHARS);
}

/** content blocks -> 纯文本：只取 { type: 'text' } 的 text，块间用 '\n' 连接。 */
export function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/** 显式「记住 / remember」意图检测。 */
export function detectRememberIntent(text) {
  const normalized = normalizeText(text);
  if (normalized.length === 0) return false;
  return EXPLICIT_TRIGGERS.some((re) => re.test(normalized));
}

/** 中/英句末标点与换行切句；trim 后过滤掉短于 3 个字符的碎片。 */
export function splitSentences(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text
    .split(SENTENCE_BOUNDARY_RE)
    .map((sentence) => sentence.trim())
    .filter((sentence) => charLength(sentence) >= 3);
}

/** 纯疑问句：以 ?/？ 结尾且不含陈述词。 */
function isPureQuestion(sentence) {
  if (!/[?？]\s*$/.test(sentence)) return false;
  return !DECLARATIVE_CUES.some((re) => re.test(sentence));
}

/** maxCandidates 规整：非负整数生效，其余回落到默认值。 */
function normalizeCandidateCap(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return MAX_CANDIDATES_PER_TURN;
}

/**
 * 从一轮用户文本中抽取记忆候选。
 *
 * input: { userText, assistantText?, turn?, now?, maxCandidates?, minConfidence? }
 *   assistantText / turn / now 仅为接口一致性保留：助手文本不参与抽取，本函数不读时钟、不生成 id。
 *
 * -> Candidate[]，按 confidence 降序，最多 maxCandidates 条。
 *    Candidate: { kind, status, confidence, title, body, tags, rule }
 */
export function extractCandidates(input) {
  if (!input || typeof input !== 'object') return [];

  const userText = normalizeText(input.userText);
  if (userText.length === 0) return [];

  const maxCandidates = normalizeCandidateCap(input.maxCandidates);
  if (maxCandidates === 0) return [];

  const minConfidence =
    typeof input.minConfidence === 'number' && Number.isFinite(input.minConfidence)
      ? input.minConfidence
      : MIN_CONFIDENCE;

  const seenBodies = new Set();
  const candidates = [];

  for (const sentence of splitSentences(userText)) {
    const length = charLength(sentence);
    if (length < MIN_SENTENCE_CHARS || length > MAX_SENTENCE_CHARS) continue;
    if (isPureQuestion(sentence)) continue;

    const matched = RULES.find((rule) => rule.test(sentence));
    if (!matched) continue;

    const body = truncateChars(sentence, MAX_SENTENCE_CHARS);
    if (seenBodies.has(body)) continue; // 候选 body 不得重复
    seenBodies.add(body);

    const kind = matched.kind(body);
    const title = truncateChars(body.split('\n')[0].trim(), MAX_TITLE_CHARS);
    candidates.push({
      kind,
      status: 'pending',
      confidence: matched.confidence,
      title,
      body,
      tags: [...new Set([kind, matched.rule])], // 含 kind 与规则名，去重
      rule: matched.rule,
    });
  }

  return candidates
    .filter((candidate) => candidate.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence) // Array#sort 稳定：同置信度保持文本顺序
    .slice(0, maxCandidates);
}
