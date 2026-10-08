import { z } from 'zod';

/**
 * Funnel config schema.
 *
 * Everything the frontend renders is described here; the frontend has no
 * knowledge of concrete steps. The schema is intentionally permissive about
 * unknown keys (`passthrough`) so that newer configs with extra fields keep
 * working on an older runtime.
 */

// ---------- Conditions ----------

const leafOps = ['eq', 'in', 'contains', 'gte', 'gt', 'lte', 'lt', 'neq'] as const;
export type LeafOp = (typeof leafOps)[number];

export type Condition =
  | { op: LeafOp; field: string; value?: unknown }
  | { op: 'all'; conditions: Condition[] }
  | { op: 'any'; conditions: Condition[] }
  | { op: 'not'; condition: Condition };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(leafOps), field: z.string().min(1), value: z.unknown() }),
    z.object({ op: z.literal('all'), conditions: z.array(ConditionSchema) }),
    z.object({ op: z.literal('any'), conditions: z.array(ConditionSchema) }),
    z.object({ op: z.literal('not'), condition: ConditionSchema }),
  ]),
);

// ---------- Steps ----------

export const StepTypeSchema = z.enum(['info', 'single-select', 'multi-select', 'number', 'result']);
export type StepType = z.infer<typeof StepTypeSchema>;

export const OptionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string(),
    description: z.string().optional(),
  })
  .passthrough();
export type Option = z.infer<typeof OptionSchema>;

export const ValidationSchema = z
  .object({
    required: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    integer: z.boolean().optional(),
    minSelections: z.number().int().optional(),
    maxSelections: z.number().int().optional(),
    /** Error texts come from the config, keyed by rule name. */
    messages: z.record(z.string()).optional(),
  })
  .passthrough();
export type Validation = z.infer<typeof ValidationSchema>;

const BaseStep = z.object({
  id: z.string().min(1),
  type: StepTypeSchema,
  title: z.string().optional(),
  subtitle: z.string().optional(),
  body: z.string().optional(),
  /** Label of the primary button on this step. */
  ctaLabel: z.string().optional(),
  /** Hint under the input, placeholder for number input, unit label etc. */
  hint: z.string().optional(),
  placeholder: z.string().optional(),
  unit: z.string().optional(),
  options: z.array(OptionSchema).optional(),
  validation: ValidationSchema.optional(),
  visibleWhen: ConditionSchema.optional(),
});

export const StepSchema = BaseStep.passthrough();
export type Step = z.infer<typeof StepSchema>;

// ---------- Results ----------

export const ResultSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    body: z.string().optional(),
    /** Short bullet points shown on the result screen. */
    highlights: z.array(z.string()).optional(),
    /** Longer recommendation text, rendered collapsed; expanding emits `recommendation_expanded`. */
    details: z.array(z.string()).optional(),
    cta: z
      .object({
        label: z.string(),
        url: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type FunnelResult = z.infer<typeof ResultSchema>;

export const ResultRuleSchema = z
  .object({
    id: z.string().optional(),
    when: ConditionSchema,
    resultId: z.string().min(1),
  })
  .passthrough();
export type ResultRule = z.infer<typeof ResultRuleSchema>;

// ---------- Experiment ----------

/** Partial step used for per-variant overrides (anything but id/type). */
export const StepOverrideSchema = BaseStep.omit({ id: true, type: true }).partial().passthrough();
export type StepOverride = z.infer<typeof StepOverrideSchema>;

export const ResultOverrideSchema = ResultSchema.omit({ id: true }).deepPartial().passthrough();
export type ResultOverride = z.infer<typeof ResultOverrideSchema>;

export const VariantSchema = z
  .object({
    id: z.string().min(1),
    weight: z.number().nonnegative(),
    description: z.string().optional(),
    /** Ordered list of step ids. Steps not listed are not shown in this variant. */
    stepSequence: z.array(z.string().min(1)).optional(),
    /** Per-step overrides: texts, options, validation, visibility... */
    stepOverrides: z.record(StepOverrideSchema).optional(),
    /** Per-result overrides; `*` applies to every result. */
    resultOverrides: z.record(ResultOverrideSchema).optional(),
  })
  .passthrough();
export type Variant = z.infer<typeof VariantSchema>;

export const ExperimentSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().optional(),
    overrideQueryParam: z.string().default('variant'),
    variants: z.array(VariantSchema).min(1),
  })
  .passthrough();
export type Experiment = z.infer<typeof ExperimentSchema>;

// ---------- Settings / events ----------

export const SettingsSchema = z
  .object({
    persistAnswers: z.boolean().default(true),
    sessionTtlHours: z.number().positive().default(72),
    storeRawAnswers: z.boolean().default(false),
    progress: z
      .object({
        excludeTypes: z.array(StepTypeSchema).default(['info', 'result']),
      })
      .passthrough()
      .default({}),
  })
  .passthrough()
  .default({});
export type Settings = z.infer<typeof SettingsSchema>;

export const EventsConfigSchema = z
  .object({
    allowed: z.array(z.string().min(1)).min(1),
  })
  .passthrough();

// ---------- Root ----------

export const FunnelConfigSchema = z
  .object({
    funnelId: z.string().min(1),
    /** Opaque version label; versions are NOT assumed to be sequential. */
    version: z.string().min(1),
    status: z.enum(['draft', 'published', 'archived']).optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    settings: SettingsSchema,
    experiment: ExperimentSchema,
    steps: z.array(StepSchema).min(1),
    results: z.array(ResultSchema).min(1),
    resultRules: z.array(ResultRuleSchema).default([]),
    defaultResultId: z.string().min(1),
    events: EventsConfigSchema,
  })
  .passthrough()
  .superRefine((cfg, ctx) => {
    const stepIds = new Set(cfg.steps.map((s) => s.id));
    const resultIds = new Set(cfg.results.map((r) => r.id));

    if (!resultIds.has(cfg.defaultResultId)) {
      ctx.addIssue({ code: 'custom', path: ['defaultResultId'], message: `Unknown result "${cfg.defaultResultId}"` });
    }
    cfg.resultRules.forEach((rule, i) => {
      if (!resultIds.has(rule.resultId)) {
        ctx.addIssue({ code: 'custom', path: ['resultRules', i, 'resultId'], message: `Unknown result "${rule.resultId}"` });
      }
    });
    cfg.experiment.variants.forEach((v, vi) => {
      v.stepSequence?.forEach((id, si) => {
        if (!stepIds.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['experiment', 'variants', vi, 'stepSequence', si],
            message: `Unknown step "${id}"`,
          });
        }
      });
      for (const id of Object.keys(v.stepOverrides ?? {})) {
        if (!stepIds.has(id)) {
          ctx.addIssue({ code: 'custom', path: ['experiment', 'variants', vi, 'stepOverrides', id], message: `Unknown step "${id}"` });
        }
      }
      for (const id of Object.keys(v.resultOverrides ?? {})) {
        if (id !== '*' && !resultIds.has(id)) {
          ctx.addIssue({ code: 'custom', path: ['experiment', 'variants', vi, 'resultOverrides', id], message: `Unknown result "${id}"` });
        }
      }
    });
    const totalWeight = cfg.experiment.variants.reduce((s, v) => s + v.weight, 0);
    if (totalWeight <= 0) {
      ctx.addIssue({ code: 'custom', path: ['experiment', 'variants'], message: 'Variant weights must sum to a positive number' });
    }
    if (cfg.steps.filter((s) => s.type === 'result').length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['steps'], message: 'Config must contain exactly one step of type "result"' });
    }
  });

export type FunnelConfig = z.infer<typeof FunnelConfigSchema>;

export function parseFunnelConfig(input: unknown): FunnelConfig {
  return FunnelConfigSchema.parse(input);
}

export function safeParseFunnelConfig(input: unknown) {
  return FunnelConfigSchema.safeParse(input);
}
