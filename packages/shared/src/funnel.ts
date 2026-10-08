import { allowedEventNames, versionKey, type FunnelConfig, type FunnelResult, type Step, type StepType, type Variant } from './schema.js';
import { evaluateCondition, type Answers } from './conditions.js';

/**
 * A config with one variant applied: ordered steps with overrides merged in,
 * results with overrides merged in. This is what the client renders.
 */
export interface ResolvedFunnel {
  funnelId: string;
  /** Canonical string version ("1", "3"). */
  version: string;
  title?: string;
  variant: string;
  experimentId: string;
  overrideQueryParam: string;
  session: FunnelConfig['session'];
  progress: FunnelConfig['progress'];
  privacy: FunnelConfig['events']['privacy'];
  steps: Step[];
  results: FunnelResult[];
  resultRules: FunnelConfig['resultRules'];
  defaultResultId: string;
  allowedEvents: string[];
}

export function variantIds(config: FunnelConfig): string[] {
  return Object.keys(config.experiment.variants);
}

export function getVariant(config: FunnelConfig, variantId: string): Variant {
  const v = config.experiment.variants[variantId];
  if (!v) throw new Error(`Variant "${variantId}" not found in experiment "${config.experiment.id}"`);
  return v;
}

/** Weighted random pick. `random` is injectable for deterministic tests. */
export function pickVariant(config: FunnelConfig, random: () => number = Math.random): string {
  const entries = Object.entries(config.experiment.variants);
  const total = entries.reduce((s, [, v]) => s + v.weight, 0);
  let r = random() * total;
  for (const [id, v] of entries) {
    r -= v.weight;
    if (r < 0) return id;
  }
  return entries[entries.length - 1]![0];
}

export function resolveFunnel(config: FunnelConfig, variantId: string): ResolvedFunnel {
  const variant = getVariant(config, variantId);

  const steps: Step[] = variant.stepSequence.map((id) => {
    const base = config.steps[id];
    if (!base) throw new Error(`stepSequence references unknown step "${id}"`);
    const override = variant.stepOverrides[id];
    return override ? ({ ...deepMerge(base, override), id: base.id, type: base.type } as Step) : base;
  });

  const star = variant.resultOverrides['*'];
  const results: FunnelResult[] = Object.values(config.results).map((r) => {
    const own = variant.resultOverrides[r.id];
    if (!star && !own) return r;
    return { ...deepMerge(deepMerge(r, star ?? {}), own ?? {}), id: r.id } as FunnelResult;
  });

  return {
    funnelId: config.funnelId,
    version: versionKey(config),
    title: config.title,
    variant: variantId,
    experimentId: config.experiment.id,
    overrideQueryParam: config.experiment.overrideQueryParam,
    session: config.session,
    progress: config.progress,
    privacy: config.events.privacy,
    steps,
    results,
    resultRules: config.resultRules,
    defaultResultId: config.defaultResultId,
    allowedEvents: allowedEventNames(config),
  };
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = isPlainObject(v) && isPlainObject(cur) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------- Visibility, pruning, progress ----------

/**
 * Steps visible for the given answers, in variant order. Visibility is
 * evaluated sequentially: a step's condition only sees answers of steps that
 * are themselves visible and precede it, so an answer to a hidden step can
 * never make another step appear.
 */
export function getVisibleSteps(funnel: ResolvedFunnel, answers: Answers): Step[] {
  const visible: Step[] = [];
  const effective: Answers = {};
  for (const step of funnel.steps) {
    if (step.visibleWhen && !evaluateCondition(step.visibleWhen, effective)) continue;
    visible.push(step);
    if (answers[step.id] !== undefined) effective[step.id] = answers[step.id];
  }
  return visible;
}

/**
 * Returns only answers that belong to currently visible steps.
 *
 * The "changed my mind" case: the user answered `office_days`, went back and
 * switched `work_mode` to `remote`. The stale `office_days` answer must not
 * influence progress or the result.
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
  /** 1-based position of the current step among counted steps (0 before the first counted step). */
  current: number;
  total: number;
  /** 0..1 */
  ratio: number;
}

export function computeProgress(funnel: ResolvedFunnel, answers: Answers, currentStepId: string): Progress {
  const exclude = new Set<StepType>(funnel.progress.excludeTypes);
  const visible = funnel.progress.countVisibleOnly ? getVisibleSteps(funnel, answers) : funnel.steps;
  const counted = visible.filter((s) => !exclude.has(s.type));
  const total = counted.length;

  const idx = visible.findIndex((s) => s.id === currentStepId);
  if (idx === -1 || total === 0) return { current: 0, total, ratio: 0 };

  let current = 0;
  for (let i = 0; i <= idx; i++) if (!exclude.has(visible[i]!.type)) current++;
  if (exclude.has(visible[idx]!.type)) {
    // excluded step (intro / result): position = number of counted steps already behind us
    const allBehind = counted.every((c) => visible.indexOf(c) < idx);
    current = allBehind ? total : current;
  }
  return { current, total, ratio: current / total };
}

/** Index of the step among visible steps and the visible count — used for step_viewed properties. */
export function visiblePosition(funnel: ResolvedFunnel, answers: Answers, stepId: string): { index: number; count: number } {
  const visible = getVisibleSteps(funnel, answers);
  return { index: visible.findIndex((s) => s.id === stepId), count: visible.length };
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

const DEFAULT_MESSAGES: Record<string, (s: Step) => string> = {
  required: () => 'This field is required',
  number: () => 'Please enter a valid number',
  min: (s) => `Value must be at least ${s.input?.min}`,
  max: (s) => `Value must be at most ${s.input?.max}`,
  step: (s) => (s.input?.step === 1 ? 'Use a whole number' : `Value must be a multiple of ${s.input?.step}`),
  minSelections: (s) => `Select at least ${s.validation?.minSelections} option(s)`,
  maxSelections: (s) => `Select at most ${s.validation?.maxSelections} option(s)`,
  option: () => 'Unknown option',
};

/**
 * Validates a single answer against the step. Bounds come from `input`
 * (min/max/step), selection limits from `validation`, texts from
 * `validation.messages`.
 */
export function validateAnswer(step: Step, value: unknown): ValidationError | null {
  if (step.type === 'info' || step.type === 'result') return null;
  const v = step.validation ?? {};
  const input = step.input ?? {};
  const msg = (rule: string): ValidationError => ({
    rule,
    message: v.messages?.[rule] ?? DEFAULT_MESSAGES[rule]?.(step) ?? 'Invalid value',
  });
  const isEmpty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
  if (isEmpty) return v.required ? msg('required') : null;

  if (step.type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (typeof value === 'boolean' || !Number.isFinite(n)) return msg('number');
    if (input.min !== undefined && n < input.min) return msg('min');
    if (input.max !== undefined && n > input.max) return msg('max');
    if (input.step !== undefined) {
      const base = input.min ?? 0;
      const k = (n - base) / input.step;
      if (Math.abs(k - Math.round(k)) > 1e-9) return msg('step');
    }
    return null;
  }

  const optionValues = new Set((input.options ?? []).map((o) => o.value));

  if (step.type === 'single-select') {
    return typeof value === 'string' && optionValues.has(value) ? null : msg('option');
  }

  // multi-select
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string' || !optionValues.has(x))) return msg('option');
  if (v.minSelections !== undefined && value.length < v.minSelections) return msg('minSelections');
  if (v.maxSelections !== undefined && value.length > v.maxSelections) return msg('maxSelections');
  return null;
}

/** Coerce raw user input to the canonical stored shape for the step type. */
export function normalizeAnswer(step: Step, value: unknown): unknown {
  if (step.type === 'number') {
    if (value === '' || value === null || value === undefined) return undefined;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

/** Non-identifying description of an answer — the only thing analytics gets (`privacy.allowAnswerKinds`). */
export function answerKind(step: Step): string {
  return step.type;
}

// ---------- Result ----------

/** First matching rule wins; otherwise `defaultResultId`. Only answers of visible steps count. */
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
