import { resolveFunnel, type AnalyticsFilters, type AnalyticsResponse, type FunnelMetrics, type StepMetric } from '@funnel/shared';
import type { Db } from './db.js';
import type { VersionService } from './versions.js';

interface Triple {
  session_id: string;
  funnel_version: string;
  variant: string;
  event_type: string;
  step_id: string | null;
}

/**
 * All metrics are computed on UNIQUE SESSIONS.
 *
 * The raw query collapses events to distinct (session, version, variant,
 * event_type, step_id) rows, so repeated views, back-and-forth navigation and
 * duplicate deliveries cannot inflate anything. Ordering of arrival is
 * irrelevant: we only ask "did this session ever have event X on step Y".
 *
 * Drop-off is attributed to the furthest step (by position in the variant's
 * step sequence, not by time) a session has viewed without reaching the result.
 */
export class AnalyticsService {
  constructor(
    private db: Db,
    private versions: VersionService,
  ) {}

  compute(filters: AnalyticsFilters): AnalyticsResponse {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filters.version) {
      where.push('funnel_version = @version');
      params.version = filters.version;
    }
    if (filters.variant) {
      where.push('variant = @variant');
      params.variant = filters.variant;
    }
    if (filters.utm_campaign) {
      where.push('utm_campaign = @utm_campaign');
      params.utm_campaign = filters.utm_campaign;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const triples = this.db
      .prepare(
        `SELECT session_id, funnel_version, variant, event_type, step_id
         FROM events ${whereSql}
         GROUP BY session_id, funnel_version, variant, event_type, step_id`,
      )
      .all(params) as Triple[];

    // group by segment → session → facts
    type SessionFacts = { viewed: Set<string>; completed: Set<string>; resultViewed: boolean; ctaClicked: boolean };
    const segments = new Map<string, { version: string; variant: string; sessions: Map<string, SessionFacts> }>();

    for (const t of triples) {
      const key = `${t.funnel_version}\u0000${t.variant}`;
      let seg = segments.get(key);
      if (!seg) {
        seg = { version: t.funnel_version, variant: t.variant, sessions: new Map() };
        segments.set(key, seg);
      }
      let s = seg.sessions.get(t.session_id);
      if (!s) {
        s = { viewed: new Set(), completed: new Set(), resultViewed: false, ctaClicked: false };
        seg.sessions.set(t.session_id, s);
      }
      switch (t.event_type) {
        case 'step_viewed':
          if (t.step_id) s.viewed.add(t.step_id);
          break;
        case 'step_completed':
          if (t.step_id) s.completed.add(t.step_id);
          break;
        case 'result_viewed':
          s.resultViewed = true;
          if (t.step_id) s.viewed.add(t.step_id);
          break;
        case 'cta_clicked':
          s.ctaClicked = true;
          break;
        default:
          break;
      }
    }

    const segmentMetrics: FunnelMetrics[] = [];
    for (const seg of segments.values()) {
      segmentMetrics.push(this.segmentMetrics(seg.version, seg.variant, seg.sessions));
    }
    segmentMetrics.sort((a, b) => a.version.localeCompare(b.version) || a.variant.localeCompare(b.variant));

    const overviewSessions = new Map<string, { result: boolean; cta: boolean }>();
    for (const seg of segments.values()) {
      for (const [id, f] of seg.sessions) {
        const prev = overviewSessions.get(id) ?? { result: false, cta: false };
        overviewSessions.set(id, { result: prev.result || f.resultViewed, cta: prev.cta || f.ctaClicked });
      }
    }
    const started = overviewSessions.size;
    const reachedResult = [...overviewSessions.values()].filter((f) => f.result).length;
    const ctaClicked = [...overviewSessions.values()].filter((f) => f.cta).length;

    const totals = this.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number };
    const dupes = this.db.prepare(`SELECT value FROM ingest_stats WHERE key = 'duplicate'`).get() as { value: number } | undefined;

    const campaigns = (this.db.prepare('SELECT DISTINCT utm_campaign AS c FROM events WHERE utm_campaign IS NOT NULL ORDER BY 1').all() as Array<{ c: string }>).map((r) => r.c);
    const versions = (this.db.prepare('SELECT DISTINCT funnel_version AS v FROM events ORDER BY 1').all() as Array<{ v: string }>).map((r) => r.v);
    const variants = (this.db.prepare('SELECT DISTINCT variant AS v FROM events ORDER BY 1').all() as Array<{ v: string }>).map((r) => r.v);

    return {
      filters,
      overview: {
        started,
        reachedResult,
        ctaClicked,
        completionRate: ratio(reachedResult, started),
        ctaCtr: ratio(ctaClicked, reachedResult),
        ctaPerStarted: ratio(ctaClicked, started),
        totalEvents: totals.c,
        duplicateProtectedEvents: dupes?.value ?? 0,
      },
      segments: segmentMetrics,
      byVersion: rollup(segmentMetrics, (m) => m.version).map(({ key, ...rest }) => ({ version: key, ...rest })),
      byVariant: rollup(segmentMetrics, (m) => m.variant).map(({ key, ...rest }) => ({ variant: key, ...rest })),
      campaigns,
      versions,
      variants,
    };
  }

  private segmentMetrics(
    version: string,
    variant: string,
    sessions: Map<string, { viewed: Set<string>; completed: Set<string>; resultViewed: boolean; ctaClicked: boolean }>,
  ): FunnelMetrics {
    let sequence: Array<{ id: string; title: string; type: string }> = [];
    try {
      const funnel = resolveFunnel(this.versions.get(version), variant);
      sequence = funnel.steps.map((s) => ({ id: s.id, title: s.title ?? s.id, type: s.type }));
    } catch {
      // version/variant unknown to this deployment: fall back to step ids seen in data
      const ids = new Set<string>();
      for (const s of sessions.values()) for (const id of s.viewed) ids.add(id);
      sequence = [...ids].map((id) => ({ id, title: id, type: 'unknown' }));
    }
    const index = new Map(sequence.map((s, i) => [s.id, i]));

    const started = sessions.size;
    let reachedResult = 0;
    let ctaClicked = 0;
    const viewed = new Array<number>(sequence.length).fill(0);
    const completed = new Array<number>(sequence.length).fill(0);
    const dropped = new Array<number>(sequence.length).fill(0);
    const unknown = new Set<string>();

    for (const f of sessions.values()) {
      if (f.resultViewed) reachedResult++;
      if (f.ctaClicked) ctaClicked++;
      let furthest = -1;
      for (const id of f.viewed) {
        const i = index.get(id);
        if (i === undefined) {
          unknown.add(id);
          continue;
        }
        viewed[i]!++;
        if (i > furthest) furthest = i;
      }
      for (const id of f.completed) {
        const i = index.get(id);
        if (i !== undefined) completed[i]!++;
      }
      if (!f.resultViewed && furthest >= 0) dropped[furthest]!++;
    }

    const steps: StepMetric[] = sequence.map((s, i) => {
      // previous step that was actually shown to someone (conditional steps may have 0 views)
      let prev: number | null = null;
      for (let j = i - 1; j >= 0; j--) {
        if (viewed[j]! > 0) {
          prev = viewed[j]!;
          break;
        }
      }
      return {
        stepId: s.id,
        title: s.title,
        type: s.type,
        index: i,
        viewed: viewed[i]!,
        completed: completed[i]!,
        droppedHere: dropped[i]!,
        conversionFromPrev: prev === null ? null : viewed[i]! / prev,
        reachRate: ratio(viewed[i]!, started),
        dropRate: ratio(dropped[i]!, viewed[i]!),
      };
    });

    return {
      version,
      variant,
      started,
      reachedResult,
      ctaClicked,
      completionRate: ratio(reachedResult, started),
      ctaCtr: ratio(ctaClicked, reachedResult),
      ctaPerStarted: ratio(ctaClicked, started),
      steps,
      unknownStepIds: [...unknown].sort(),
    };
  }
}

function ratio(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

function rollup(metrics: FunnelMetrics[], keyFn: (m: FunnelMetrics) => string) {
  const map = new Map<string, { key: string; started: number; reachedResult: number; ctaClicked: number }>();
  for (const m of metrics) {
    const k = keyFn(m);
    const cur = map.get(k) ?? { key: k, started: 0, reachedResult: 0, ctaClicked: 0 };
    cur.started += m.started;
    cur.reachedResult += m.reachedResult;
    cur.ctaClicked += m.ctaClicked;
    map.set(k, cur);
  }
  return [...map.values()].map((r) => ({
    ...r,
    completionRate: ratio(r.reachedResult, r.started),
    ctaCtr: ratio(r.ctaClicked, r.reachedResult),
    ctaPerStarted: ratio(r.ctaClicked, r.started),
  }));
}
