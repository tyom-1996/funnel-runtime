import { z } from 'zod';

/**
 * Funnel config schema — follows the format of the provided funnel-v1.json /
 * funnel-v3.json exactly. Everything the frontend renders is described here;
 * the frontend has no knowledge of concrete steps.
 *
 * Unknown keys are kept (`passthrough`) so a newer config with extra fields
 * keeps working on an older runtime.
 */

// ---------- Conditions ----------

const operators = ['eq', 'neq', 'in', 'contains', 'gte', 'gt', 'lte', 'lt'] as const;
export type Operator = (typeof operators)[number];

export type Condition =
  | { answer: string; operator: Operator; value?: unknown }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ answer: z.string().min(1), operator: z.enum(operators), value: z.unknown() }).strict(),
    z.object({ all: z.array(ConditionSchema) }).strict(),
    z.object({ any: z.array(ConditionSchema) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
  ]),
);

// ---------- Steps ----------

export const StepTypeSchema = z.enum(['info', 'single-select', 'multi-select', 'number', 'result']);
export type StepType = z.infer<typeof StepTypeSchema>;

export const StepContentSchema = z
  .object({
    eyebrow: z.string().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    helperText: z.string().optional(),
    primaryActionLabel: z.string().optional(),
    // result step
    loadingTitle: z.string().optional(),
    errorTitle: z.string().optional(),
    retryLabel: z.string().optional(),
  })
  .passthrough();
export type StepContent = z.infer<typeof StepContentSchema>;

export const OptionSchema = z
  .object({
    value: z.string().min(1),
    label: z.string(),
    description: z.string().optional(),
  })
  .passthrough();
export type Option = z.infer<typeof OptionSchema>;

export const StepInputSchema = z
  .object({
    name: z.string().optional(),
    /** number: bounds and granularity (`step: 1` → whole numbers) */
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    unit: z.string().optional(),
    placeholder: z.string().optional(),
    /** select types */
    options: z.array(OptionSchema).optional(),
  })
  .passthrough();
export type StepInput = z.infer<typeof StepInputSchema>;

export const ValidationSchema = z
  .object({
    required: z.boolean().optional(),
    minSelections: z.number().int().optional(),
    maxSelections: z.number().int().optional(),
    /** Error texts come from the config, keyed by rule name (required, min, max, step, minSelections, maxSelections, option). */
    messages: z.record(z.string()).optional(),
  })
  .passthrough();
export type Validation = z.infer<typeof ValidationSchema>;

export const StepSchema = z
  .object({
    id: z.string().min(1),
    type: StepTypeSchema,
    content: StepContentSchema.default({}),
    input: StepInputSchema.optional(),
    validation: ValidationSchema.optional(),
    visibleWhen: ConditionSchema.optional(),
    resultSource: z.string().optional(),
  })
  .passthrough();
export type Step = z.infer<typeof StepSchema>;

// ---------- Results ----------

export const CtaSchema = z
  .object({
    label: z.string(),
    /** `expand_recommendation` reveals the recommendation list; a `url` opens a link. */
    action: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();
export type Cta = z.infer<typeof CtaSchema>;

export const ResultSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    summary: z.string().optional(),
    recommendations: z.array(z.string()).optional(),
    cta: CtaSchema,
  })
  .passthrough();
export type FunnelResult = z.infer<typeof ResultSchema>;

export const ResultRuleSchema = z
  .object({
    resultId: z.string().min(1),
    when: ConditionSchema,
  })
  .passthrough();
export type ResultRule = z.infer<typeof ResultRuleSchema>;

// ---------- Experiment ----------

/** Per-variant partial step: anything but id/type, deep-merged onto the base step. */
export const StepOverrideSchema = z
  .object({
    content: StepContentSchema.partial().optional(),
    input: StepInputSchema.partial().optional(),
    validation: ValidationSchema.partial().optional(),
    visibleWhen: ConditionSchema.optional(),
  })
  .passthrough();
export type StepOverride = z.infer<typeof StepOverrideSchema>;

export const ResultOverrideSchema = z
  .object({
    title: z.string().optional(),
    summary: z.string().optional(),
    recommendations: z.array(z.string()).optional(),
    cta: CtaSchema.partial().optional(),
  })
  .passthrough();
export type ResultOverride = z.infer<typeof ResultOverrideSchema>;

export const VariantSchema = z
  .object({
    weight: z.number().nonnegative(),
    /** Ordered list of step ids. Steps not listed are not shown in this variant. */
    stepSequence: z.array(z.string().min(1)).min(1),
    stepOverrides: z.record(StepOverrideSchema).default({}),
    /** Keyed by result id; `*` applies to every result. */
    resultOverrides: z.record(ResultOverrideSchema).default({}),
  })
  .passthrough();
export type Variant = z.infer<typeof VariantSchema>;

export const ExperimentSchema = z
  .object({
    id: z.string().min(1),
    assignment: z.string().default('server'),
    sticky: z.boolean().default(true),
    overrideQueryParam: z.string().default('variant'),
    variants: z.record(VariantSchema),
  })
  .passthrough();
export type Experiment = z.infer<typeof ExperimentSchema>;

// ---------- Session / progress / events ----------

export const SessionSettingsSchema = z
  .object({
    ttlHours: z.number().positive().default(72),
    persistAnswers: z.boolean().default(true),
    pinVersion: z.boolean().default(true),
    pinExperimentVariant: z.boolean().default(true),
  })
  .passthrough()
  .default({});

export const ProgressSettingsSchema = z
  .object({
    countVisibleOnly: z.boolean().default(true),
    excludeTypes: z.array(StepTypeSchema).default(['info', 'result']),
  })
  .passthrough()
  .default({});

export const AllowedEventSchema = z
  .object({
    name: z.string().min(1),
    trigger: z.string().optional(),
    properties: z.array(z.string()).default([]),
  })
  .passthrough();
export type AllowedEvent = z.infer<typeof AllowedEventSchema>;

export const EventsConfigSchema = z
  .object({
    baseProperties: z.array(z.string()).default([]),
    allowed: z.array(AllowedEventSchema).min(1),
    privacy: z
      .object({
        storeRawAnswers: z.boolean().default(false),
        allowAnswerKinds: z.boolean().default(true),
      })
      .passthrough()
      .default({}),
  })
  .passthrough();
export type EventsConfig = z.infer<typeof EventsConfigSchema>;

// ---------- Root ----------

export const FunnelConfigSchema = z
  .object({
    schemaVersion: z.string().optional(),
    funnelId: z.string().min(1),
    /** Number or string. Versions are NOT assumed to be sequential (v2 may never exist). */
    version: z.union([z.number().int().nonnegative(), z.string().min(1)]),
    status: z.enum(['draft', 'published', 'archived']).optional(),
    locale: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    releaseNote: z.string().optional(),
    session: SessionSettingsSchema,
    progress: ProgressSettingsSchema,
    experiment: ExperimentSchema,
    steps: z.record(StepSchema),
    resultRules: z.array(ResultRuleSchema).default([]),
    defaultResultId: z.string().min(1),
    results: z.record(ResultSchema),
    events: EventsConfigSchema,
  })
  .passthrough()
  .superRefine((cfg, ctx) => {
    const stepIds = new Set(Object.keys(cfg.steps));
    const resultIds = new Set(Object.keys(cfg.results));

    for (const [key, step] of Object.entries(cfg.steps)) {
      if (step.id !== key) ctx.addIssue({ code: 'custom', path: ['steps', key, 'id'], message: `Step key "${key}" does not match id "${step.id}"` });
    }
    for (const [key, r] of Object.entries(cfg.results)) {
      if (r.id !== key) ctx.addIssue({ code: 'custom', path: ['results', key, 'id'], message: `Result key "${key}" does not match id "${r.id}"` });
    }
    if (!resultIds.has(cfg.defaultResultId)) {
      ctx.addIssue({ code: 'custom', path: ['defaultResultId'], message: `Unknown result "${cfg.defaultResultId}"` });
    }
    cfg.resultRules.forEach((rule, i) => {
      if (!resultIds.has(rule.resultId)) {
        ctx.addIssue({ code: 'custom', path: ['resultRules', i, 'resultId'], message: `Unknown result "${rule.resultId}"` });
      }
    });
    const variantEntries = Object.entries(cfg.experiment.variants);
    if (variantEntries.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['experiment', 'variants'], message: 'At least one variant is required' });
    }
    for (const [vid, v] of variantEntries) {
      v.stepSequence.forEach((id, si) => {
        if (!stepIds.has(id)) {
          ctx.addIssue({ code: 'custom', path: ['experiment', 'variants', vid, 'stepSequence', si], message: `Unknown step "${id}"` });
        }
      });
      for (const id of Object.keys(v.stepOverrides)) {
        if (!stepIds.has(id)) ctx.addIssue({ code: 'custom', path: ['experiment', 'variants', vid, 'stepOverrides', id], message: `Unknown step "${id}"` });
      }
      for (const id of Object.keys(v.resultOverrides)) {
        if (id !== '*' && !resultIds.has(id)) {
          ctx.addIssue({ code: 'custom', path: ['experiment', 'variants', vid, 'resultOverrides', id], message: `Unknown result "${id}"` });
        }
      }
      if (!v.stepSequence.some((id) => cfg.steps[id]?.type === 'result')) {
        ctx.addIssue({ code: 'custom', path: ['experiment', 'variants', vid, 'stepSequence'], message: 'Variant must end with a "result" step' });
      }
    }
    const totalWeight = variantEntries.reduce((s, [, v]) => s + v.weight, 0);
    if (variantEntries.length > 0 && totalWeight <= 0) {
      ctx.addIssue({ code: 'custom', path: ['experiment', 'variants'], message: 'Variant weights must sum to a positive number' });
    }
  });

export type FunnelConfig = z.infer<typeof FunnelConfigSchema>;

export function parseFunnelConfig(input: unknown): FunnelConfig {
  return FunnelConfigSchema.parse(input);
}

export function safeParseFunnelConfig(input: unknown) {
  return FunnelConfigSchema.safeParse(input);
}

/** Canonical string form of the version (DB key, URLs, analytics). */
export function versionKey(config: Pick<FunnelConfig, 'version'>): string {
  return String(config.version);
}

export function allowedEventNames(config: Pick<FunnelConfig, 'events'>): string[] {
  return config.events.allowed.map((e) => e.name);
}
