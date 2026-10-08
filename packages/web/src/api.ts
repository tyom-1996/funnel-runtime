import type { AnalyticsFilters, AnalyticsResponse, EventsBatchResponse, PublicationLogEntry, SessionResponse, Utm, VersionSummary } from '@funnel/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const ADMIN_TOKEN_KEY = 'funnel.adminToken';
export const adminToken = {
  get: () => localStorage.getItem(ADMIN_TOKEN_KEY) ?? '',
  set: (t: string) => (t ? localStorage.setItem(ADMIN_TOKEN_KEY, t) : localStorage.removeItem(ADMIN_TOKEN_KEY)),
};

async function http<T>(method: string, url: string, body?: unknown, opts: { admin?: boolean; keepalive?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.admin) {
    const t = adminToken.get();
    if (t) headers['x-admin-token'] = t;
  }
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), keepalive: opts.keepalive });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok && res.status !== 207) throw new ApiError(res.status, json?.error ?? res.statusText, json?.details);
  return json as T;
}

export const api = {
  createSession: (utm: Utm, variantOverride: string | null, overrideParam: string) => {
    const qs = variantOverride ? `?${encodeURIComponent(overrideParam)}=${encodeURIComponent(variantOverride)}` : '';
    return http<SessionResponse>('POST', `/api/sessions${qs}`, { utm, variantOverride });
  },
  getSession: (id: string) => http<SessionResponse>('GET', `/api/sessions/${id}`),
  updateSession: (id: string, patch: { answers?: Record<string, unknown>; currentStepId?: string | null }) =>
    http<SessionResponse>('PATCH', `/api/sessions/${id}`, patch),
  sendEvents: (events: unknown[], keepalive = false) => http<EventsBatchResponse>('POST', '/api/events', events, { keepalive }),

  activeVersion: () => http<{ version: string | null }>('GET', '/api/versions/active'),

  adminVersions: () =>
    http<{ activeVersion: string | null; versions: VersionSummary[]; log: PublicationLogEntry[] }>('GET', '/api/admin/versions', undefined, { admin: true }),
  adminVersion: (v: string) => http<{ summary: VersionSummary; config: unknown }>('GET', `/api/admin/versions/${v}`, undefined, { admin: true }),
  adminUpload: (config: unknown) => http<VersionSummary>('POST', '/api/admin/versions', config, { admin: true }),
  adminPublish: (v: string) => http<VersionSummary>('POST', `/api/admin/versions/${v}/publish`, {}, { admin: true }),
  adminRollback: (toVersion?: string) => http<VersionSummary>('POST', '/api/admin/rollback', { toVersion }, { admin: true }),

  analytics: (f: AnalyticsFilters) => {
    const qs = new URLSearchParams();
    if (f.version) qs.set('version', f.version);
    if (f.variant) qs.set('variant', f.variant);
    if (f.utm_campaign) qs.set('utm_campaign', f.utm_campaign);
    const s = qs.toString();
    return http<AnalyticsResponse>('GET', `/api/analytics${s ? `?${s}` : ''}`, undefined, { admin: true });
  },
};
