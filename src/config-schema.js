/**
 * Loader-visible Config schema for the DSH Settings surface.
 *
 * The Host projects this schema into an editable form (Settings / Plugin page),
 * so users pick the two vault folders there instead of editing
 * `cordis.patch.yml` by hand. `src/config.js` still normalizes the value at
 * runtime for defense in depth and for the unconfigured-root warnings.
 * @module dsh-inkvault/config-schema
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_DIRECTIVE_TRIGGERS } from './capture.js'

/** Editable plugin configuration; descriptions are shown in the settings form. */
export const Config = z.object({
  disabled: z.boolean().default(true)
    .description('总开关：true 时不注册任何工具与钩子，插件行为回到原状。'),

  memoryEnabled: z.boolean().default(true)
    .description('记忆库功能开关：DSH 的长期记忆。'),
  memoryRoot: z.string().default('')
    .description('记忆库文件夹（必填才启用）。建议指向 Obsidian 库内的子目录，例如 ~/Documents/Obsidian Vault/InkVault。'),
  inject: z.boolean().default(true)
    .description('每回合第一步自动召回相关记忆并注入。'),
  capture: z.boolean().default(true)
    .description('回合结束时自动沉淀记忆候选。'),
  injectBudgetTokens: z.number().default(800)
    .description('单次注入的 token 预算。'),
  maxRecallItems: z.number().default(6)
    .description('单次最多注入的记忆条数。'),
  captureMaxPerTurn: z.number().default(2)
    .description('每回合最多沉淀的记忆候选数。'),
  minCaptureConfidence: z.number().default(0.6)
    .description('低于该置信度的候选会被丢弃（0-1）。'),
  directives: z.boolean().default(true)
    .description('指令层开关：把 `delivery: prompt` 且 status=active 的记忆条目每轮注入系统提示词。'),
  maxDirectiveChars: z.number().default(4000)
    .description('指令层文本的字符上限；超出则整块跳过并告警，不截断。'),
  directiveTriggers: z.array(z.string()).default([...DEFAULT_DIRECTIVE_TRIGGERS])
    .description('「强声明」短语列表：一句话同时命中「记住」和这里任一短语时，才自动升级为指令层。纯文本子串匹配、大小写不敏感；留空数组即关闭自动升级（仍可手动写 delivery: prompt）。'),

  knowledgeEnabled: z.boolean().default(true)
    .description('知识库功能开关：在对话中把知识写进 Obsidian。'),
  knowledgeRoot: z.string().default('')
    .description('知识库文件夹（必填才启用）。建议指向 Obsidian 库内的子目录，例如 ~/Documents/Obsidian Vault/Knowledge。'),

  debug: z.boolean().default(false)
    .description('输出召回/沉淀调试日志。'),
})

export default Config
