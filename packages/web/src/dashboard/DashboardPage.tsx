import { useCallback, useEffect, useState } from 'react';
import type { AnalyticsFilters, AnalyticsResponse, FunnelMetrics } from '@funnel/shared';
import { api } from '../api';

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);

export function DashboardPage() {
  const [filters, setFilters] = useState<AnalyticsFilters>({});
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (f: AnalyticsFilters) => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.analytics(f));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filters);
  }, [filters, load]);

  const set = (k: keyof AnalyticsFilters) => (e: React.ChangeEvent<HTMLSelectElement>) =>
    setFilters((f) => ({ ...f, [k]: e.target.value || undefined }));

  return (
    <div className="page wide">
      <div className="row space-between wrap">
        <h1>Analytics</h1>
        <div className="row gap wrap">
          <label className="select">
            Version
            <select value={filters.version ?? ''} onChange={set('version')}>
              <option value="">all</option>
              {data?.versions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="select">
            Variant
            <select value={filters.variant ?? ''} onChange={set('variant')}>
              <option value="">all</option>
              {data?.variants.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="select">
            UTM campaign
            <select value={filters.utm_campaign ?? ''} onChange={set('utm_campaign')}>
              <option value="">all</option>
              {data?.campaigns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <button className="ghost" onClick={() => void load(filters)} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      {data && (
        <>
          <div className="kpis">
            <Kpi label="Sessions started" value={data.overview.started} />
            <Kpi label="Reached result" value={data.overview.reachedResult} sub={pct(data.overview.completionRate) + ' of started'} />
            <Kpi label="CTA clicked" value={data.overview.ctaClicked} sub={pct(data.overview.ctaCtr) + ' CTR of result viewers'} />
            <Kpi label="CTA / started" value={pct(data.overview.ctaPerStarted)} sub="primary A/B metric" />
            <Kpi label="Events stored" value={data.overview.totalEvents} sub={`${data.overview.duplicateProtectedEvents} duplicates ignored`} />
          </div>

          <div className="grid-2">
            <div className="card">
              <h2>A vs B</h2>
              <p className="muted small">All metrics are unique sessions. Primary metric: share of started sessions that clicked the CTA.</p>
              <CompareTable rows={data.byVariant.map((r) => ({ key: r.variant, ...r }))} keyLabel="Variant" />
            </div>
            <div className="card">
              <h2>Versions</h2>
              <p className="muted small">Sessions are pinned to the version they started on, so every version keeps its own numbers after publish/rollback.</p>
              <CompareTable rows={data.byVersion.map((r) => ({ key: r.version, ...r }))} keyLabel="Version" />
            </div>
          </div>

          <h2 style={{ marginTop: 24 }}>Step funnel by version × variant</h2>
          <p className="muted small">
            Step order differs between variants (and some steps exist only in some versions), so the funnel is shown per segment. Drop-off is attributed to the
            furthest step a session saw without reaching the result.
          </p>
          {data.segments.length === 0 && <div className="card muted">No events yet. Run <code>npm run seed</code> or walk through the funnel.</div>}
          {data.segments.map((seg) => (
            <SegmentFunnel key={`${seg.version}-${seg.variant}`} seg={seg} />
          ))}
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

function CompareTable({
  rows,
  keyLabel,
}: {
  rows: Array<{ key: string; started: number; reachedResult: number; ctaClicked: number; completionRate: number; ctaCtr: number; ctaPerStarted: number }>;
  keyLabel: string;
}) {
  const best = rows.reduce((m, r) => Math.max(m, r.ctaPerStarted), 0);
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{keyLabel}</th>
          <th>Started</th>
          <th>Result</th>
          <th>Completion</th>
          <th>CTA</th>
          <th>CTA CTR</th>
          <th>CTA / started</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>
              <strong>{r.key}</strong>
            </td>
            <td>{r.started}</td>
            <td>{r.reachedResult}</td>
            <td>{pct(r.completionRate)}</td>
            <td>{r.ctaClicked}</td>
            <td>{pct(r.ctaCtr)}</td>
            <td className={rows.length > 1 && r.ctaPerStarted === best && best > 0 ? 'best' : ''}>{pct(r.ctaPerStarted)}</td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={7} className="muted">
              no data
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function SegmentFunnel({ seg }: { seg: FunnelMetrics }) {
  const max = Math.max(1, seg.started);
  return (
    <div className="card">
      <div className="row space-between wrap">
        <h3>
          {seg.version} · variant {seg.variant}
        </h3>
        <div className="muted small">
          {seg.started} started · {seg.reachedResult} reached result ({pct(seg.completionRate)}) · {seg.ctaClicked} CTA ({pct(seg.ctaCtr)} CTR)
        </div>
      </div>
      <table className="table funnel-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Step</th>
            <th>Type</th>
            <th>Viewed</th>
            <th>Reach</th>
            <th>Conv. from prev</th>
            <th>Completed</th>
            <th>Dropped here</th>
            <th>Drop rate</th>
          </tr>
        </thead>
        <tbody>
          {seg.steps.map((s) => (
            <tr key={s.stepId} className={s.viewed === 0 ? 'muted' : ''}>
              <td>{s.index + 1}</td>
              <td>
                <div className="bar-wrap">
                  <div className="bar" style={{ width: `${(s.viewed / max) * 100}%` }} />
                  <span>
                    {s.title} <span className="mono muted small">{s.stepId}</span>
                  </span>
                </div>
              </td>
              <td className="mono small">{s.type}</td>
              <td>{s.viewed}</td>
              <td>{pct(s.reachRate)}</td>
              <td>{pct(s.conversionFromPrev)}</td>
              <td>{s.completed}</td>
              <td>{s.droppedHere}</td>
              <td className={s.dropRate > 0.3 ? 'warn-text' : ''}>{pct(s.dropRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {seg.unknownStepIds.length > 0 && (
        <p className="muted small">Events for steps not in this segment's config: {seg.unknownStepIds.join(', ')}</p>
      )}
    </div>
  );
}
