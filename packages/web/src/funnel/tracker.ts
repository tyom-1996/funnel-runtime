import { api } from '../api';

interface QueuedEvent {
  event_id: string;
  session_id: string;
  event_type: string;
  step_id?: string;
  client_timestamp: string;
  properties?: Record<string, unknown>;
}

const PENDING_KEY = 'funnel.pendingEvents';
const FLUSH_MS = 800;
const MAX_BATCH = 50;

/**
 * Client-side event queue.
 *
 * - every event gets a client-generated UUID once; retries reuse it, so the
 *   server can deduplicate safely
 * - events are batched (timer or size) and persisted in localStorage while
 *   unsent, so a refresh in the middle of a flush does not lose them
 * - the allowed event set comes from the session's config version; events
 *   outside it are dropped on the client (the server would reject them anyway)
 */
export class Tracker {
  private queue: QueuedEvent[] = [];
  private timer: number | null = null;
  private inflight = false;
  private allowed = new Set<string>();
  private sessionId: string | null = null;

  constructor() {
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      if (raw) this.queue = JSON.parse(raw);
    } catch {
      this.queue = [];
    }
    window.addEventListener('pagehide', () => void this.flush(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush(true);
    });
    if (this.queue.length) this.schedule();
  }

  bind(sessionId: string, allowedEvents: string[]) {
    this.sessionId = sessionId;
    this.allowed = new Set(allowedEvents);
  }

  track(eventType: string, stepId?: string, properties?: Record<string, unknown>) {
    if (!this.sessionId) return;
    if (!this.allowed.has(eventType)) return;
    this.queue.push({
      event_id: crypto.randomUUID(),
      session_id: this.sessionId,
      event_type: eventType,
      step_id: stepId,
      client_timestamp: new Date().toISOString(),
      properties,
    });
    this.persist();
    if (this.queue.length >= MAX_BATCH) void this.flush();
    else this.schedule();
  }

  private schedule() {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_MS);
  }

  private persist() {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify(this.queue));
    } catch {
      /* quota exceeded: keep in memory only */
    }
  }

  async flush(keepalive = false) {
    if (this.inflight || this.queue.length === 0) return;
    const batch = this.queue.slice(0, MAX_BATCH);
    this.inflight = true;
    try {
      const res = await api.sendEvents(batch, keepalive);
      // accepted, duplicate and rejected are all final: nothing to retry
      const done = new Set(res.results.map((r) => r.event_id));
      this.queue = this.queue.filter((e) => !done.has(e.event_id));
      this.persist();
    } catch {
      // network error / timeout: keep the batch (same event_ids) and retry later
      window.setTimeout(() => void this.flush(), 3000);
    } finally {
      this.inflight = false;
      if (this.queue.length) this.schedule();
    }
  }
}

export const tracker = new Tracker();
