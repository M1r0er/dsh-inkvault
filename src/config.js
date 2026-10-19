/**
 * Configuration for the dsh-inkvault plugin.
 *
 * Two independent features, each with its own explicitly chosen folder:
 * - knowledge: write notes from a DSH conversation into a chosen Obsidian folder;
 * - memory: use a chosen Obsidian folder as the agent's long-term memory.
 *
 * No default directory is created: an unset root keeps that feature inactive,
 * so installing the plugin never scatters files on the user's disk and the
 * vault location is always a deliberate choice. Query `inkvault_status` to see
 * the resolved locations.
 *
 * The plugin intentionally declares no schemastery `Config` export and no npm
 * dependencies: a profile-installed bundle is linked into the profile and must
 * resolve from the workspace, so `@deepseek-ai/*` imports are unavailable to
 * it. Values are validated here, with the profile patch passing a plain object.
 * @module dsh-inkvault/config
 */
import os from 'node:os'
import path from 'node:path'

/** Every supported option and its default value. */
export const DEFAULTS = Object.freeze({
  disabled: true,
  // Memory feature (agent long-term memory).
  memoryEnabled: true,
  memoryRoot: '',
  inject: true,
  capture: true,
  injectBudgetTokens: 800,
  maxRecallItems: 6,
  captureMaxPerTurn: 2,
  minCaptureConfidence: 0.6,
  // Knowledge feature (user knowledge written into an Obsidian folder).
  knowledgeEnabled: true,
  knowledgeRoot: '',
  // Diagnostics.
  debug: false,
})

const BOOLEAN_KEYS = ['disabled', 'memoryEnabled', 'inject', 'capture', 'knowledgeEnabled', 'debug']
const NUMBER_KEYS = {
  injectBudgetTokens: { min: 0, max: 20000, integer: true },
  maxRecallItems: { min: 0, max: 50, integer: true },
  captureMaxPerTurn: { min: 0, max: 10, integer: true },
  minCaptureConfidence: { min: 0, max: 1, integer: false },
}

/**
 * Expand `~` and resolve one configured vault directory.
 * An empty value means "not configured": the feature stays off instead of
 * inventing a folder. A relative value resolves against the user's home
 * directory and is reported.
 * @param {unknown} value - raw configured root.
 * @param {string} label - option name, used in diagnostics.
 * @param {string[]} issues - mutable issue accumulator.
 * @returns {string} absolute root, or '' when unset.
 */
export function resolveVaultRoot(value, label, issues = []) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    issues.push(`${label} must be a string path; feature disabled`)
    return ''
  }
  let expanded = value.trim()
  if (expanded === '') return ''
  if (expanded === '~') expanded = os.homedir()
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) expanded = path.join(os.homedir(), expanded.slice(2))
  if (!path.isAbsolute(expanded)) {
    issues.push(`${label} "${value}" is relative; resolved against the home directory`)
    expanded = path.join(os.homedir(), expanded)
  }
  return path.resolve(expanded)
}

/**
 * Validate and normalize a raw plugin config object.
 * Unknown keys and wrong types fall back to defaults and produce an issue
 * instead of throwing, so a bad profile patch never prevents the plugin from
 * loading. A feature whose root stays unset is reported and stays inactive.
 * @param {unknown} raw - config value from the loader row.
 * @returns {{ config: typeof DEFAULTS, issues: string[] }} resolved config.
 */
export function resolveConfig(raw) {
  const issues = []
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    issues.push('config must be an object; using defaults')
  }
  const config = { ...DEFAULTS }
  for (const key of BOOLEAN_KEYS) {
    if (!(key in source)) continue
    if (typeof source[key] === 'boolean') config[key] = source[key]
    else issues.push(`${key} must be a boolean; using default ${DEFAULTS[key]}`)
  }
  for (const [key, rule] of Object.entries(NUMBER_KEYS)) {
    if (!(key in source)) continue
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)
      && value >= rule.min && value <= rule.max
      && (!rule.integer || Number.isInteger(value))) {
      config[key] = value
    } else {
      issues.push(`${key} must be ${rule.integer ? 'an integer' : 'a number'} in [${rule.min}, ${rule.max}]; using default ${DEFAULTS[key]}`)
    }
  }
  config.memoryRoot = resolveVaultRoot(source.memoryRoot, 'memoryRoot', issues)
  config.knowledgeRoot = resolveVaultRoot(source.knowledgeRoot, 'knowledgeRoot', issues)
  if (config.memoryEnabled && config.memoryRoot === '') {
    issues.push('memoryEnabled is true but memoryRoot is unset; memory feature stays inactive')
  }
  if (config.knowledgeEnabled && config.knowledgeRoot === '') {
    issues.push('knowledgeEnabled is true but knowledgeRoot is unset; knowledge feature stays inactive')
  }
  for (const key of Object.keys(source)) {
    if (!(key in DEFAULTS)) issues.push(`unknown option "${key}" ignored`)
  }
  return { config, issues }
}

/**
 * Whether the memory feature can run: enabled and pointed at a folder.
 * @param {typeof DEFAULTS} config - resolved config.
 * @returns {boolean} active flag.
 */
export function memoryActive(config) {
  return config.memoryEnabled && config.memoryRoot !== ''
}

/**
 * Whether the knowledge feature can run: enabled and pointed at a folder.
 * @param {typeof DEFAULTS} config - resolved config.
 * @returns {boolean} active flag.
 */
export function knowledgeActive(config) {
  return config.knowledgeEnabled && config.knowledgeRoot !== ''
}
