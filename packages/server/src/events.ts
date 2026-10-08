import { IncomingEventSchema, type EventResult, type EventsBatchResponse, type Utm } from '@funnel/shared';
import type { Db } from './db.js';
import { nowIso } from './db.js';
import type { SessionRow } from './sessions.js';
import type { VersionService } from './versions.js';

const MAX_BATCH = 500;
const MAX_PROPERTIES_BYTES = 4096;

/**
 * Batch, idempotent event ingestion.
 *
 * - each event is validated independently; a bad one is `rejected`, the rest go through
 * - `event_id` is the primary key; `INSERT OR IGNORE` makes retries safe → `duplicate`
 * - version / variant / utm are copied from the session, not taken from the client
 * - server_timestamp is set here
 * - allowed event types come from the config version the session is pinned to
 * - raw answer values are stripped unless the config says `storeRawAnswers: true`
 */
export class EventService {
  private insert;
  private bump;

  constructor(
    private db: Db,
    private versions: VersionService,
  ) {
    this.insert = db.prepare(
      `INSERT OR IGNORE INTO events
        (event_id, session_id, event_type, step_id, funnel_version, variant, client_timestamp, server_timestamp,
         utm_source, utm_medium, utm_campaign, properties_json)
       VALUES (@event_id, @session_id, @event_type, @step_id, @funnel_version, @variant, @client_timestamp, @server_timestamp,
         @utm_source, @utm_medium, @utm_campaign, @properties_json)`,
    );
    this.bump = db.prepare('UPDATE ingest_stats SET value = value + ? WHERE key = ?');
  }

  ingest(batch: unknown): EventsBatchResponse {
    if (!Array.isArray(batch)) {
      return { results: [{ event_id: null, status: 'rejected', reason: 'Body must be an array of events' }], summary: { accepted: 0, duplicate: 0, rejected: 1 } };
    }
    if (batch.length > MAX_BATCH) {
      return {
        results: [{ event_id: null, status: 'rejected', reason: `Batch too large (max ${MAX_BATCH})` }],
        summary: { accepted: 0, duplicate: 0, rejected: 1 },
      };
    }

    const sessionCache = new Map<string, SessionRow | null>();
    const getSession = (id: string): SessionRow | null => {
      if (!sessionCache.has(id)) {
        const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id) as SessionRow | undefined;
        sessionCache.set(id, row ?? null);
      }
      return sessionCache.get(id)!;
    };

    const serverTs = nowIso();
    const results: EventResult[] = [];
    const summary: EventsBatchResponse['summary'] = { accepted: 0, duplicate: 0, rejected: 0 };

    const tx = this.db.transaction(() => {
      // de-duplicate within the batch as well, so results are consistent
      const seenInBatch = new Set<string>();

      for (const raw of batch) {
        const parsed = IncomingEventSchema.safeParse(raw);
        if (!parsed.success) {
          const id = typeof (raw as { event_id?: unknown })?.event_id === 'string' ? (raw as { event_id: string }).event_id : null;
          results.push({ event_id: id, status: 'rejected', reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
          summary.rejected++;
          continue;
        }
        const ev = parsed.data;

        const session = getSession(ev.session_id);
        if (!session) {
          results.push({ event_id: ev.event_id, status: 'rejected', reason: 'Unknown session' });
          summary.rejected++;
          continue;
        }

        const config = this.versions.get(session.funnel_version);
        if (!config.events.allowed.includes(ev.event_type)) {
          results.push({ event_id: ev.event_id, status: 'rejected', reason: `Event type "${ev.event_type}" is not allowed in version ${session.funnel_version}` });
          summary.rejected++;
          continue;
        }

        let properties: Record<string, unknown> = ev.properties ?? {};
        if (!config.settings.storeRawAnswers) properties = stripRawAnswers(properties);
        const propertiesJson = JSON.stringify(properties);
        if (propertiesJson.length > MAX_PROPERTIES_BYTES) {
          results.push({ event_id: ev.event_id, status: 'rejected', reason: 'properties too large' });
          summary.rejected++;
          continue;
        }

        if (seenInBatch.has(ev.event_id)) {
          results.push({ event_id: ev.event_id, status: 'duplicate' });
          summary.duplicate++;
          continue;
        }
        seenInBatch.add(ev.event_id);

        const utm = JSON.parse(session.utm_json) as Utm;
        const info = this.insert.run({
          event_id: ev.event_id,
          session_id: ev.session_id,
          event_type: ev.event_type,
          step_id: ev.step_id ?? null,
          funnel_version: session.funnel_version,
          variant: session.variant,
          client_timestamp: ev.client_timestamp,
          server_timestamp: serverTs,
          utm_source: utm.utm_source ?? null,
          utm_medium: utm.utm_medium ?? null,
          utm_campaign: utm.utm_campaign ?? null,
          properties_json: propertiesJson,
        });

        if (info.changes === 0) {
          results.push({ event_id: ev.event_id, status: 'duplicate' });
          summary.duplicate++;
        } else {
          results.push({ event_id: ev.event_id, status: 'accepted' });
          summary.accepted++;
        }
      }

      for (const k of ['accepted', 'duplicate', 'rejected'] as const) {
        if (summary[k] > 0) this.bump.run(summary[k], k);
      }
    });
    tx();

    return { results, summary };
  }
}

/** Keys that could carry user input. Only `answer_kind` style metadata survives. */
const RAW_ANSWER_KEYS = new Set(['answer', 'value', 'values', 'raw', 'answers', 'selected', 'input', 'text']);

function stripRawAnswers(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (RAW_ANSWER_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}
