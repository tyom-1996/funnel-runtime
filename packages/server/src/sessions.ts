import { randomUUID } from 'node:crypto';
import {
  getVariant,
  pickVariant,
  resolveFunnel,
  pruneAnswers,
  validateAnswer,
  normalizeAnswer,
  UtmSchema,
  type Answers,
  type SessionResponse,
  type Utm,
  type FunnelConfig,
} from '@funnel/shared';
import type { Db } from './db.js';
import { nowIso } from './db.js';
import { HttpError } from './errors.js';
import type { VersionService } from './versions.js';

export interface SessionRow {
  session_id: string;
  funnel_version: string;
  variant: string;
  variant_source: 'assigned' | 'override';
  current_step_id: string | null;
  answers_json: string;
  utm_json: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export class SessionService {
  constructor(
    private db: Db,
    private versions: VersionService,
    private random: () => number = Math.random,
  ) {}

  /**
   * New sessions are ALWAYS created on the active version and pinned to it.
   * The variant is assigned server-side (weighted), unless a valid override
   * for the configured query param is supplied.
   */
  create(input: { utm?: unknown; variantOverride?: string | null }): SessionResponse {
    const config = this.versions.getActive();
    const utm = UtmSchema.parse(input.utm ?? {});

    let variantId: string;
    let source: 'assigned' | 'override' = 'assigned';
    if (input.variantOverride && config.experiment.variants.some((v) => v.id === input.variantOverride)) {
      variantId = input.variantOverride;
      source = 'override';
    } else {
      variantId = pickVariant(config, this.random).id;
    }

    const id = randomUUID();
    const created = nowIso();
    const expires = new Date(Date.now() + config.settings.sessionTtlHours * 3600 * 1000).toISOString();
    const firstStep = resolveFunnel(config, variantId).steps[0]?.id ?? null;

    this.db
      .prepare(
        `INSERT INTO sessions(session_id, funnel_version, variant, variant_source, current_step_id, answers_json, utm_json, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
      )
      .run(id, config.version, variantId, source, firstStep, JSON.stringify(utm), created, created, expires);

    return this.get(id);
  }

  getRow(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id) as SessionRow | undefined;
  }

  /** Returns the session together with the config of ITS version (not the active one). */
  get(id: string): SessionResponse {
    const row = this.getRow(id);
    if (!row) throw new HttpError(404, 'Session not found');
    if (new Date(row.expires_at).getTime() < Date.now()) throw new HttpError(410, 'Session expired');
    const config = this.versions.get(row.funnel_version);
    return this.toResponse(row, config);
  }

  /**
   * Persist answers and current position. Answers are validated against the
   * session's own config version/variant. After merging, answers of steps
   * that became hidden are dropped, so a stale `office_days` can never leak
   * into progress or result computation after switching to `remote`.
   */
  update(id: string, patch: { answers?: Answers; currentStepId?: string | null }): SessionResponse {
    const row = this.getRow(id);
    if (!row) throw new HttpError(404, 'Session not found');
    if (new Date(row.expires_at).getTime() < Date.now()) throw new HttpError(410, 'Session expired');

    const config = this.versions.get(row.funnel_version);
    const funnel = resolveFunnel(config, row.variant);
    const stepsById = new Map(funnel.steps.map((s) => [s.id, s]));

    const current: Answers = JSON.parse(row.answers_json);
    if (patch.answers) {
      for (const [stepId, raw] of Object.entries(patch.answers)) {
        const step = stepsById.get(stepId);
        if (!step) throw new HttpError(400, `Unknown step "${stepId}" for this session`);
        const value = normalizeAnswer(step, raw);
        if (value === undefined || value === null) {
          delete current[stepId];
          continue;
        }
        const err = validateAnswer(step, value);
        if (err) throw new HttpError(400, `Invalid answer for "${stepId}": ${err.message}`, { stepId, rule: err.rule });
        current[stepId] = value;
      }
    }

    let currentStepId = row.current_step_id;
    if (patch.currentStepId !== undefined) {
      if (patch.currentStepId !== null && !stepsById.has(patch.currentStepId)) {
        throw new HttpError(400, `Unknown step "${patch.currentStepId}" for this session`);
      }
      currentStepId = patch.currentStepId;
    }

    const effective = pruneAnswers(funnel, current);
    this.db
      .prepare('UPDATE sessions SET answers_json = ?, current_step_id = ?, updated_at = ? WHERE session_id = ?')
      .run(JSON.stringify(config.settings.persistAnswers ? effective : {}), currentStepId, nowIso(), id);

    return this.get(id);
  }

  private toResponse(row: SessionRow, config: FunnelConfig): SessionResponse {
    getVariant(config, row.variant); // sanity: variant must exist in pinned version
    const funnel = resolveFunnel(config, row.variant);
    const stored: Answers = JSON.parse(row.answers_json);
    return {
      session: {
        id: row.session_id,
        funnelVersion: row.funnel_version,
        variant: row.variant,
        variantSource: row.variant_source,
        currentStepId: row.current_step_id,
        // the client receives only answers that are currently meaningful
        answers: pruneAnswers(funnel, stored),
        utm: JSON.parse(row.utm_json) as Utm,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      },
      funnel,
    };
  }
}
