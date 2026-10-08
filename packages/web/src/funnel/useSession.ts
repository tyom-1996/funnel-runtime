import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionResponse, Utm } from '@funnel/shared';
import { api, ApiError } from '../api';
import { tracker } from './tracker';

const SESSION_KEY = 'funnel.sessionId';
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

function readUtm(params: URLSearchParams): Utm {
  const utm: Utm = {};
  for (const k of UTM_KEYS) {
    const v = params.get(k);
    if (v) utm[k] = v;
  }
  return utm;
}

export interface SessionState {
  data: SessionResponse | null;
  loading: boolean;
  error: string | null;
  /** Discard the current session and start a fresh one on the active version. */
  restart: () => Promise<void>;
  /** Replace local copy after a successful PATCH. */
  setData: (d: SessionResponse) => void;
}

/**
 * Only `session_id` lives in localStorage. Answers and position are stored
 * server-side in the session, so Back / refresh / reopening the tab restore
 * the exact same state and the exact same config version.
 */
export function useSession(): SessionState {
  const [data, setData] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const create = useCallback(async () => {
    const params = new URLSearchParams(window.location.search);
    const utm = readUtm(params);
    // forward the whole query string so the server can read whichever
    // override param the active config declares (`overrideQueryParam`)
    const qs = params.toString();
    const res = await fetch(`/api/sessions${qs ? `?${qs}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ utm }),
    });
    const json = await res.json();
    if (!res.ok) throw new ApiError(res.status, json?.error ?? 'Failed to create session');
    const created = json as SessionResponse;
    localStorage.setItem(SESSION_KEY, created.session.id);
    tracker.bind(created.session.id, created.funnel.allowedEvents);
    tracker.track('session_started', undefined, {
      variant_source: created.session.variantSource,
      experiment_id: created.funnel.experimentId,
    });
    return created;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams(window.location.search);
      const existingId = localStorage.getItem(SESSION_KEY);
      let next: SessionResponse | null = null;

      if (existingId) {
        try {
          next = await api.getSession(existingId);
          // Assumption: an explicit override that differs from the session's
          // variant means the tester wants a NEW session on that variant.
          const override = params.get(next.funnel.overrideQueryParam);
          if (override && override !== next.session.variant) next = null;
        } catch (e) {
          if (!(e instanceof ApiError && (e.status === 404 || e.status === 410))) throw e;
          next = null; // expired or unknown → start over
        }
      }
      if (!next) next = await create();
      else tracker.bind(next.session.id, next.funnel.allowedEvents);
      setData(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [create]);

  useEffect(() => {
    if (started.current) return; // StrictMode double-invoke guard
    started.current = true;
    void load();
  }, [load]);

  const restart = useCallback(async () => {
    localStorage.removeItem(SESSION_KEY);
    setData(null);
    await load();
  }, [load]);

  return { data, loading, error, restart, setData };
}
