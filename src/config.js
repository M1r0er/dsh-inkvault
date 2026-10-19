/**
 * Configuration for the dsh-inkvault plugin.
 *
 * The plugin intentionally declares no schemastery `Config` export and no npm
 * dependencies: a profile-installed bundle is linked into the profile and must
 * resolve from the workspace, so `@deepseek-ai/*` imports are unavailable to
 * it. Values are therefore validated here, with the profile patch passing a
 * plain object.
 * @module dsh-inkvault/config
 */
import os from 'node:os'
import path from 'node:path'

/** Default automatic-behavior switch: on install the plugin stays quiet. */
export const DEFAULT_MEMORY_ROOT = path.join(os.homedir(), 'InkVault', 'Memory')

/** Every supported option and its default value. */
export const DEFAULTS = Object.freeze({
  disabled: true,
  memoryRoot: '',
  inject: true,
  capture: true,
  injectBudgetTokens: 800,
  maxRecallItems: 6,
  captureMaxPerTurn: 2,
  minCaptureConfidence: 0.6,
  debug: false,
})

const BOOLEAN_KEYS = ['disabled', 'inject', 'capture', 'debug']
const NUMBER_KEYS = {
  injectBudgetTokens: { min: 0, max: 20000, integer: true },
  maxRecallItems: { min: 0, max: 50, integer: true },
  captureMaxPerTurn: { min: 0, max: 10, integer: true },
  minCaptureConfidence: { min: 0, max: 1, integer: false },
}

/**
 * Expand `~` and resolve a configured vault directory.
 * A relative value resolves against the user's home directory and is reported,
 * so the same profile behaves identically regardless of session working
 * directory.
 * @param {string} value - raw `memoryRoot` value; empty selects the default.
 * @param {string[]} issues - mutable issue accumulator.
 * @returns {string} absolute vault root.
 */
export function resolveMemoryRoot(value, issues = []) {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_MEMORY_ROOT
  let expanded = value.trim()
  if (expanded === '~') expanded = os.homedir()
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) expanded = path.join(os.homedir(), expanded.slice(2))
  if (!path.isAbsolute(expanded)) {
    issues.push(`memoryRoot "${value}" is relative; resolved against the home directory`)
    expanded = path.join(os.homedir(), expanded)
  }
  return path.resolve(expanded)
}

/**
 * Validate and normalize a raw plugin config object.
 * Unknown keys and wrong types fall back to defaults and produce an issue
 * instead of throwing, so a bad profile patch never prevents the plugin from
 * loading.
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
  config.memoryRoot = resolveMemoryRoot(source.memoryRoot, issues)
  for (const key of Object.keys(source)) {
    if (!(key in DEFAULTS)) issues.push(`unknown option "${key}" ignored`)
  }
  return { config, issues }
}
