import type { FunnelConfig, FunnelResult, Step, StepType, Variant } from './schema.js';
import { evaluateCondition, type Answers } from './conditions.js';

/**
 * A config with one variant applied: ordered steps with overrides merged in,
 * results with overrides merged in. This is what the client renders.
 */
export interface ResolvedFunnel {
  funnelId: string;
  version: string;
  name?: string;
  variant: string;
  experimentId: string;
  overrideQueryParam: string;
  settings: FunnelConfig['settings'];
  steps: Step[];
  results: FunnelResult[];
  resultRules: FunnelConfig['resultRules'];
  defaultResultId: string;
  allowedEvents: string[];
}

export function getVariant(config: FunnelConfig, variantId: string): Variant {
  const v = config.experiment.variants.find((x) => x.id === variantId);
  if (!v) throw new Error(`Variant "${variantId}" not found in experiment "${config.experiment.id}"`);
  return v;
}

/**
 * Weighted random pick. `random` is injectable for deterministic tests.
 */
export function pickVariant(config: FunnelConfig, random: () => number = Math.random): Variant {
  const variants = config.experiment.variants;
  const total = variants.reduce((s, v) => s + v.weight, 0);
  let r = random() * total;
  for (const v of variants) {
    r -= v.weight;
    if (r < 0) return v;
  }
  return variants[variants.length - 1]!;
}

export function resolveFunnel(config: FunnelConfig, variantId: string): ResolvedFunnel {
  const variant = getVariant(config, variantId);
  const byId = new Map(config.steps.map((s) => [s.id, s]));

  const order = variant.stepSequence ?? config.steps.map((s) => s.id);
  const steps: Step[] = order.map((id) => {
    const base = byId.get(id);
    if (!base) throw new Error(`stepSequence references unknown step "${id}"`);
    const override = variant.stepOverrides?.[id];
    return override ? ({ ...base, ...override, id: base.id, type: base.type } as Step) : base;
  });

  const star = variant.resultOverrides?.['*'];
  const results: FunnelResult[] = config.results.map((r) => {
    const own = variant.resultOverrides?.[r.id];
    if (!star && !own) return r;
    return deepMerge(deepMerge(r, star ?? {}), own ?? {}) as FunnelResult;
  });

  return {
    funnelId: config.funnelId,
    version: config.version,
    name: config.name,
    variant: variant.id,
    experimentId: config.experiment.id,
    overrideQueryParam: config.experiment.overrideQueryParam,
    settings: config.settings,
    steps,
    results,
    resultRules: config.resultRules,
    defaultResultId: config.defaultResultId,
    allowedEvents: config.events.allowed,
  };
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    if (isPlainObject(v) && isPlainObject(cur)) {
      out[k] = deepMerge(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------- Visibility, pruning, progress ----------

/**
 * Steps visible for the given answers, in variant order. Visibility is
 * evaluated sequentially: a step's condition only sees answers of steps
 * that are themselves visible and precede it, so an answer to a hidden
 * step can never make another step appear.
 */
export function getVisibleSteps(funnel: ResolvedFunnel, answers: Answers): Step[] {
  const visible: Step[] = [];
  const effective: Answers = {};
  for (const step of funnel.steps) {
    if (step.visibleWhen && !evaluateCondition(step.visibleWhen, effective)) continue;
    visible.push(step);
    if (step.id in answers && answers[step.id] !== undefined) effective[step.id] = answers[step.id];
  }
  return visible;
}

/**
 * Returns only answers that belong to currently visible steps.
 *
 * This is the "changed my mind" case: the user answered `office_days`,
 * went back and switched `work_mode` to `remote`. The stale `office_days`
 * answer is still stored but must not influence progress or the result.
 */
export function pruneAnswers(funnel: ResolvedFunnel, answers: Answers): Answers {
  const visibleIds = new Set(getVisibleSteps(funnel, answers).map((s) => s.id));
  const out: Answers = {};
  for (const [k, v] of Object.entries(answers)) {
    if (visibleIds.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}

export interface Progress {
  /** 1-based index of the current step among counted steps, 0 for excluded steps before the first. */
  current: number;
  total: number;
  /** 0..1 */
  ratio: number;
}

export function computeProgress(funnel: ResolvedFunnel, answers: Answers, currentStepId: string): Progress {
  const exclude = new Set<StepType>(funnel.settings.progress.excludeTypes);
  const visible = getVisibleSteps(funnel, answers);
  const counted = visible.filter((s) => !exclude.has(s.type));
  const total = counted.length;

  const currentIdxVisible = visible.findIndex((s) => s.id === currentStepId);
  if (currentIdxVisible === -1) return { current: 0, total, ratio: 0 };

  // number of counted steps strictly before the current one, plus current if it is counted
  let current = 0;
  for (let i = 0; i <= currentIdxVisible; i++) {
    const s = visible[i]!;
    if (!exclude.has(s.type)) current++;
  }
  const currentStep = visible[currentIdxVisible]!;
  if (exclude.has(currentStep.type)) {
    // e.g. result screen: all counted steps are behind us; intro: none
    const isAfterAll = counted.every((c) => visible.indexOf(c) < currentIdxVisible);
    return { current: isAfterAll ? total : current, total, ratio: total === 0 ? 0 : (isAfterAll ? total : current) / total };
  }
  return { current, total, ratio: total === 0 ? 0 : current / total };
}

export function getNextStep(funnel: ResolvedFunnel, answers: Answers, currentStepId: string): Step | null {
  const visible = getVisibleSteps(funnel, answers);
  const idx = visible.findIndex((s) => s.id === currentStepId);
  if (idx === -1) return visible[0] ?? null;
  return visible[idx + 1] ?? null;
}

export function getPrevStep(funnel: ResolvedFunnel, answers: Answers, currentStepId: string): Step | null {
  const visible = getVisibleSteps(funnel, answers);
  const idx = visible.findIndex((s) => s.id === currentStepId);
  if (idx <= 0) return null;
  return visible[idx - 1] ?? null;
}

// ---------- Validation ----------

export interface ValidationError {
  rule: string;
  message: string;
}

const DEFAULT_MESSAGES: Record<string, (v: Record<string, unknown>) => string> = {
  required: () => 'This field is required',
  min: (v) => `Value must be at least ${v.min}`,
  max: (v) => `Value must be at most ${v.max}`,
  integer: () => 'Value must be a whole number',
  number: () => 'Please enter a valid number',
  minSelections: (v) => `Select at least ${v.minSelections} option(s)`,
  maxSelections: (v) => `Select at most ${v.maxSelections} option(s)`,
  option: () => 'Unknown option',
};

export function validateAnswer(step: Step, value: unknown): ValidationError | null {
  const v = step.validation ?? {};
  const msg = (rule: string) => ({
    rule,
    message: v.messages?.[rule] ?? DEFAULT_MESSAGES[rule]?.(v as Record<string, unknown>) ?? 'Invalid value',
  });
  const isEmpty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

  if (step.type === 'info' || step.type === 'result') return null;

  if (isEmpty) return v.required ? msg('required') : null;

  if (step.type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (typeof value === 'boolean' || Number.isNaN(n) || !Number.isFinite(n)) return msg('number');
    if (v.integer && !Number.isInteger(n)) return msg('integer');
    if (v.min !== undefined && n < v.min) return msg('min');
    if (v.max !== undefined && n > v.max) return msg('max');
    return null;
  }

  const optionIds = new Set((step.options ?? []).map((o) => o.id));

  if (step.type === 'single-select') {
    if (typeof value !== 'string' || !optionIds.has(value)) return msg('option');
    return null;
  }

  if (step.type === 'multi-select') {
    if (!Array.isArray(value) || value.some((x) => typeof x !== 'string' || !optionIds.has(x))) return msg('option');
    if (v.minSelections !== undefined && value.length < v.minSelections) return msg('minSelections');
    if (v.maxSelections !== undefined && value.length > v.maxSelections) return msg('maxSelections');
    return null;
  }

  return null;
}

/** Coerce a raw user input to the canonical stored shape for the step type. */
export function normalizeAnswer(step: Step, value: unknown): unknown {
  if (step.type === 'number') {
    if (value === '' || value === null || value === undefined) return undefined;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

/** Non-identifying description of the answer, safe to put into analytics. */
export function answerKind(step: Step): string {
  return step.type;
}

// ---------- Result ----------

/**
 * First matching rule wins; otherwise `defaultResultId`. Only answers of
 * visible steps are considered.
 */
export function evaluateResult(funnel: ResolvedFunnel, answers: Answers): FunnelResult {
  const effective = pruneAnswers(funnel, answers);
  let resultId = funnel.defaultResultId;
  for (const rule of funnel.resultRules) {
    if (evaluateCondition(rule.when, effective)) {
      resultId = rule.resultId;
      break;
    }
  }
  const result = funnel.results.find((r) => r.id === resultId) ?? funnel.results.find((r) => r.id === funnel.defaultResultId);
  if (!result) throw new Error(`Result "${resultId}" not found`);
  return result;
}

/**
 * Is every visible, answerable step before `stepId` answered and valid?
 * Used by the server to refuse jumping to the result without answers.
 */
export function isReachable(funnel: ResolvedFunnel, answers: Answers, stepId: string): boolean {
  const visible = getVisibleSteps(funnel, answers);
  for (const s of visible) {
    if (s.id === stepId) return true;
    if (s.type === 'info') continue;
    if (validateAnswer(s, answers[s.id]) !== null) return false;
  }
  return false;
}
