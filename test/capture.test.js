import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CANDIDATES_PER_TURN,
  MIN_CONFIDENCE,
  DEFAULT_DIRECTIVE_TRIGGERS,
  textOfContent,
  extractCandidates,
  detectRememberIntent,
  isStrongDirective,
  splitSentences,
} from '../src/capture.js';

const CANDIDATE_KEYS = ['body', 'confidence', 'delivery', 'kind', 'rule', 'status', 'tags', 'title'];

/** 抽取单个候选并断言只有一条，返回它。 */
function onlyCandidate(input) {
  const candidates = extractCandidates(input);
  assert.equal(candidates.length, 1, `期望恰好 1 条候选，实际 ${candidates.length}`);
  return candidates[0];
}

test('导出常量符合契约', () => {
  assert.equal(MAX_CANDIDATES_PER_TURN, 2);
  assert.equal(MIN_CONFIDENCE, 0.6);
});

test('textOfContent：只拼接 text 块，块间用换行', () => {
  assert.equal(
    textOfContent([
      { type: 'text', text: '第一块' },
      { type: 'image', source: { type: 'base64', data: 'x' } },
      { type: 'text', text: '第二块' },
    ]),
    '第一块\n第二块',
  );
  assert.equal(textOfContent([]), '');
  assert.equal(textOfContent('不是数组'), '');
  assert.equal(textOfContent([{ type: 'text' }, { type: 'text', text: 'ok' }, null, 42]), 'ok');
});

test('splitSentences：中英句末标点与换行切分，过滤 <3 字符碎片', () => {
  assert.deepEqual(splitSentences('你好。我在用中文！真的吗？'), ['你好。', '我在用中文！', '真的吗？']);
  assert.deepEqual(splitSentences('I prefer dark mode. I never use tabs.'), [
    'I prefer dark mode.',
    'I never use tabs.',
  ]);
  assert.deepEqual(splitSentences('第一行\n第二行'), ['第一行', '第二行']);
  assert.deepEqual(splitSentences('好。嗯。'), []);
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences(undefined), []);
  // splitSentences 不做长度上限：超长句交给 extractCandidates 的硬过滤
  assert.equal(splitSentences('a'.repeat(600)).length, 1);
});

test('detectRememberIntent：识别显式“记住 / remember”意图', () => {
  for (const text of ['请记住这个', '帮我记一下', '记住：用中文', 'remember that I like tea', 'Note that the repo uses ESM']) {
    assert.equal(detectRememberIntent(text), true, `应识别: ${text}`);
  }
  for (const text of ['我喜欢中文', '今天天气不错。', '', undefined, null]) {
    assert.equal(detectRememberIntent(text), false, `不应识别: ${String(text)}`);
  }
});

test('explicit 规则：命中“记住”，kind 由偏好词决定，confidence 0.95', () => {
  const candidate = onlyCandidate({ userText: '请记住：我喜欢用中文回答。' });
  assert.deepEqual(Object.keys(candidate).sort(), CANDIDATE_KEYS);
  assert.equal(candidate.rule, 'explicit');
  assert.equal(candidate.kind, 'preference'); // 含“我喜欢”
  assert.equal(candidate.status, 'pending');
  assert.equal(candidate.confidence, 0.95);
  assert.equal(candidate.body, '请记住：我喜欢用中文回答。');
  assert.equal(candidate.title, '请记住：我喜欢用中文回答。');
  assert.deepEqual(candidate.tags, ['preference', 'explicit']);

  // 不含偏好词 -> fact
  const fact = onlyCandidate({ userText: '记住：发布日定在周五。' });
  assert.equal(fact.rule, 'explicit');
  assert.equal(fact.kind, 'fact');
  assert.deepEqual(fact.tags, ['fact', 'explicit']);
});

test('explicit 规则：英文 remember that / note that', () => {
  const preferred = onlyCandidate({ userText: 'Remember that I prefer dark mode.' });
  assert.equal(preferred.rule, 'explicit');
  assert.equal(preferred.kind, 'preference');
  assert.equal(preferred.confidence, 0.95);

  const noted = onlyCandidate({ userText: 'Note that the repo uses ESM.' });
  assert.equal(noted.rule, 'explicit');
  assert.equal(noted.kind, 'fact');
});

test('preference 规则：中文触发词与 0.8 置信度', () => {
  const candidate = onlyCandidate({ userText: '我更喜欢深色模式。' });
  assert.equal(candidate.rule, 'preference');
  assert.equal(candidate.kind, 'preference');
  assert.equal(candidate.confidence, 0.8);
  assert.equal(candidate.status, 'pending');
  assert.deepEqual(candidate.tags, ['preference']); // kind 与规则名相同，去重
});

test('preference 规则：英文触发词', () => {
  const candidates = extractCandidates({ userText: 'I prefer dark mode. I never use tabs.' });
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((c) => c.body), ['I prefer dark mode.', 'I never use tabs.']);
  assert.deepEqual(candidates.map((c) => c.rule), ['preference', 'preference']);

  const dontLike = onlyCandidate({ userText: "I don't like tabs in YAML." });
  assert.equal(dontLike.rule, 'preference');
  assert.equal(dontLike.confidence, 0.8);
});

test('decision 规则：中英文命中，confidence 0.75', () => {
  const zh = onlyCandidate({ userText: '我们决定采用 BM25 做检索。' });
  assert.equal(zh.rule, 'decision');
  assert.equal(zh.kind, 'decision');
  assert.equal(zh.confidence, 0.75);
  assert.deepEqual(zh.tags, ['decision']);

  const en = onlyCandidate({ userText: 'We decided to use ESM modules.' });
  assert.equal(en.rule, 'decision');
  assert.equal(en.confidence, 0.75);
});

test('personal-fact 规则：中英文命中，confidence 0.7', () => {
  const zh = onlyCandidate({ userText: '我叫李雷。' });
  assert.equal(zh.rule, 'personal-fact');
  assert.equal(zh.kind, 'fact');
  assert.equal(zh.confidence, 0.7);
  assert.deepEqual(zh.tags, ['fact', 'personal-fact']);

  const en = onlyCandidate({ userText: 'I live in Shanghai now.' });
  assert.equal(en.rule, 'personal-fact');
  assert.equal(en.kind, 'fact');

  const work = onlyCandidate({ userText: 'I work at Acme.' });
  assert.equal(work.rule, 'personal-fact');
});

test('project-convention 规则：中英文命中，confidence 0.6 且默认通过阈值', () => {
  const zh = onlyCandidate({ userText: '这个项目约定所有注释写英文。' });
  assert.equal(zh.rule, 'project-convention');
  assert.equal(zh.kind, 'project');
  assert.equal(zh.confidence, 0.6);
  assert.deepEqual(zh.tags, ['project', 'project-convention']);

  const en = onlyCandidate({ userText: 'In this project we use tabs.' });
  assert.equal(en.rule, 'project-convention');
  assert.equal(en.confidence, 0.6);
});

test('无命中、空输入、非对象输入均返回空数组', () => {
  assert.deepEqual(extractCandidates({ userText: '今天天气不错。' }), []);
  assert.deepEqual(extractCandidates({ userText: '' }), []);
  assert.deepEqual(extractCandidates({ userText: '   ' }), []);
  assert.deepEqual(extractCandidates({}), []);
  assert.deepEqual(extractCandidates(undefined), []);
  assert.deepEqual(extractCandidates(null), []);
  assert.deepEqual(extractCandidates('字符串不是 input'), []);
});

test('assistantText 不参与抽取（仅保留参数）', () => {
  assert.deepEqual(
    extractCandidates({
      userText: '今天天气不错。',
      assistantText: '我喜欢中文。我们决定采用 ESM。',
      turn: 7,
      now: () => new Date('2026-10-19T00:00:00.000Z'),
    }),
    [],
  );
});

test('规则优先级：显式 > 偏好 > 决定，同句只取一条', () => {
  // explicit 压过 decision
  const explicit = onlyCandidate({ userText: '记住，我们决定用 BM25。' });
  assert.equal(explicit.rule, 'explicit');
  assert.equal(explicit.kind, 'fact');

  // preference 压过 decision（命中“我喜欢”与“决定/采用”）
  const preference = onlyCandidate({ userText: '我决定采用我喜欢的中文排版。' });
  assert.equal(preference.rule, 'preference');
  assert.equal(preference.confidence, 0.8);
});

test('候选 body 去重：重复句子只产出一条', () => {
  const candidates = extractCandidates({ userText: '我偏好中文。我偏好中文。' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].body, '我偏好中文。');
});

test('maxCandidates：默认 2，可覆盖；0 表示不产出', () => {
  const text = '我喜欢苹果。我喜欢香蕉。我喜欢橘子。';

  const byDefault = extractCandidates({ userText: text });
  assert.equal(byDefault.length, 2);
  assert.deepEqual(byDefault.map((c) => c.body), ['我喜欢苹果。', '我喜欢香蕉。']);

  assert.equal(extractCandidates({ userText: text, maxCandidates: 1 }).length, 1);
  assert.equal(extractCandidates({ userText: text, maxCandidates: 10 }).length, 3);
  assert.deepEqual(extractCandidates({ userText: text, maxCandidates: 0 }), []);
});

test('按 confidence 降序排序，再按 maxCandidates 截断', () => {
  const sorted = extractCandidates({ userText: '我叫李雷。我喜欢中文。' });
  assert.deepEqual(sorted.map((c) => c.rule), ['preference', 'personal-fact']);
  assert.deepEqual(sorted.map((c) => c.confidence), [0.8, 0.7]);

  // decision 0.75 + fact 0.7 入选，project 0.6 被截断
  const capped = extractCandidates({ userText: '我叫李雷。我们决定采用 ESM。这个项目约定用英文注释。' });
  assert.deepEqual(capped.map((c) => c.rule), ['decision', 'personal-fact']);
});

test('minConfidence：过滤低于阈值的候选（默认包含 0.6）', () => {
  assert.deepEqual(extractCandidates({ userText: '这个项目约定注释写英文。', minConfidence: 0.61 }), []);
  assert.equal(extractCandidates({ userText: '这个项目约定注释写英文。', minConfidence: 0.6 }).length, 1);
  assert.deepEqual(extractCandidates({ userText: '我喜欢中文。', minConfidence: 0.9 }), []);
  assert.equal(extractCandidates({ userText: '请记住：发布日定在周五。', minConfidence: 0.9 }).length, 1);
});

test('硬过滤：命中句 <4 字符或 >500 字符被跳过', () => {
  assert.deepEqual(extractCandidates({ userText: '别用。' }), []); // 3 字符
  const longSentence = `我喜欢${'啊'.repeat(600)}。`; // 604 字符
  assert.deepEqual(extractCandidates({ userText: longSentence }), []);
  // 4 字符可以保留
  assert.equal(extractCandidates({ userText: '别用吧。' }).length, 1);
});

test('硬过滤：纯疑问句跳过，带陈述词的疑问句按规则保留', () => {
  // 命中 project-convention 但没有陈述词 -> 纯疑问句 -> 跳过
  assert.deepEqual(extractCandidates({ userText: 'Any convention here?' }), []);
  assert.deepEqual(extractCandidates({ userText: '这个项目用 tabs 吗？' }), []);
  // 含第一人称陈述词 -> 不算纯疑问句（按契约字面行为保留）
  const kept = onlyCandidate({ userText: '我喜欢什么？' });
  assert.equal(kept.rule, 'preference');
});

test('文本规范化：删零宽字符、折叠空白、限制 20000 字符', () => {
  const zeroWidth = onlyCandidate({ userText: '请记住\u200B：我\u200B喜欢\u200B中文' });
  assert.equal(zeroWidth.body, '请记住：我喜欢中文');
  assert.equal(zeroWidth.body.includes('\u200B'), false);

  const spaced = onlyCandidate({ userText: '请记住   我\t喜欢\n\n中文。' });
  assert.equal(spaced.body, '请记住 我 喜欢');
  assert.equal(spaced.body.includes('\t'), false);
  assert.equal(spaced.body.includes('  '), false);

  // 超过 20000 字符后的内容被丢弃：末尾的偏好句不应被抽取
  const truncated = `${'今天天气不错。'.repeat(4000)}我喜欢中文。`;
  assert.deepEqual(extractCandidates({ userText: truncated }), []);
});

test('title 为 body 首行截 80 字符', () => {
  const body = `我喜欢${'A'.repeat(200)}。`;
  const candidate = onlyCandidate({ userText: body });
  assert.equal(candidate.body, body);
  assert.equal(candidate.title.length, 80);
  assert.equal(candidate.title, body.slice(0, 80));
});

test('纯函数：相同输入产生完全相同结果，不生成 id/时间戳', () => {
  const input = { userText: '请记住：我喜欢中文。我叫李雷。', turn: 1 };
  assert.deepEqual(extractCandidates(input), extractCandidates(input));
  for (const candidate of extractCandidates(input)) {
    assert.equal('id' in candidate, false);
    assert.equal('created' in candidate, false);
  }
});

test('强声明短语可自定义：配置项整体替换默认值', () => {
  // 默认短语命中 -> prompt
  assert.equal(onlyCandidate({ userText: '记住：以后都用 pnpm。' }).delivery, 'prompt');
  // 默认短语不命中 -> recall
  assert.equal(onlyCandidate({ userText: '记住：发布日定在周五。' }).delivery, 'recall');

  // 自定义列表里没有「以后都」，所以默认短语失效
  assert.equal(
    onlyCandidate({ userText: '记住：以后都用 pnpm。', directiveTriggers: ['打 tag 才算完成'] }).delivery,
    'recall',
  );
  // 自定义列表命中的短语才升级
  assert.equal(
    onlyCandidate({ userText: '记住：打 tag 才算完成。', directiveTriggers: ['打 tag 才算完成'] }).delivery,
    'prompt',
  );
});

test('强声明短语：空数组关闭自动升级，垃圾值回落默认值', () => {
  const sentence = '记住：以后都用 pnpm。';
  // 合法空数组 = 关闭自动升级（仍可手动声明 delivery: prompt）
  assert.equal(onlyCandidate({ userText: sentence, directiveTriggers: [] }).delivery, 'recall');
  // 非数组 -> 回落默认值
  assert.equal(onlyCandidate({ userText: sentence, directiveTriggers: '不是数组' }).delivery, 'prompt');
  // 全是垃圾项 -> 等价于空列表（关闭升级），而不是崩掉
  assert.equal(onlyCandidate({ userText: sentence, directiveTriggers: [123, null, '  '] }).delivery, 'recall');
});

test('isStrongDirective：大小写不敏感、按字面匹配、去重去空白', () => {
  assert.equal(isStrongDirective('记住 From Now On 用 pnpm'), true);
  assert.equal(isStrongDirective('记住用 pnpm'), false);
  assert.equal(isStrongDirective(''), false);
  assert.equal(isStrongDirective(undefined), false);
  // 短语按字面量匹配，正则元字符不生效（用户填 `.*` 不会变成通配符）
  assert.equal(isStrongDirective('记住 .* 规则', ['.*']), true);
  assert.equal(isStrongDirective('记住 abc 规则', ['.*']), false);
  // 空白与重复项被忽略
  assert.equal(isStrongDirective('记住 打 tag', ['  ', '打 tag', '打 tag']), true);
  // 默认值里既有中文也有英文短语
  assert.ok(DEFAULT_DIRECTIVE_TRIGGERS.includes('以后都'));
  assert.ok(DEFAULT_DIRECTIVE_TRIGGERS.includes('from now on'));
});
