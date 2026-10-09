import { useCallback, useEffect, useState } from 'react';
import type { AnalyticsFilters, AnalyticsResponse, FunnelMetrics } from '@funnel/shared';
import { api } from '../api';

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);

export function DashboardPage() {
  const [filters, setFilters] = useState<AnalyticsFilters>({});
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [compare, setCompare] = useState<'variant' | 'version'>('variant');

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
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p className="sub">Every number is a count of unique sessions — repeat views, back navigation and duplicate events never inflate it.</p>
        </div>
        <div className="filters">
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
            <Kpi label="CTA / started" value={pct(data.overview.ctaPerStarted)} sub="primary A/B metric" primary />
            <Kpi label="Sessions started" value={data.overview.started} />
            <Kpi label="Reached result" value={data.overview.reachedResult} sub={pct(data.overview.completionRate) + ' of started'} />
            <Kpi label="CTA clicked" value={data.overview.ctaClicked} sub={pct(data.overview.ctaCtr) + ' CTR of result viewers'} />
            <Kpi label="Events stored" value={data.overview.totalEvents} sub={`${data.overview.duplicateProtectedEvents} duplicates ignored`} />
          </div>

          <div className="card flush">
            <div className="card-head tabs-head">
              <div className="tabs" role="tablist" aria-label="Compare by">
                <button
                  type="button"
                  role="tab"
                  aria-selected={compare === 'variant'}
                  className={compare === 'variant' ? 'tab active' : 'tab'}
                  onClick={() => setCompare('variant')}
                >
                  A vs B
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={compare === 'version'}
                  className={compare === 'version' ? 'tab active' : 'tab'}
                  onClick={() => setCompare('version')}
                >
                  Versions
                </button>
              </div>
              <p className="muted small">
                {compare === 'variant'
                  ? 'Primary metric: share of started sessions that clicked the CTA.'
                  : 'Sessions are pinned to their version, so each keeps its own numbers after publish/rollback.'}
              </p>
            </div>
            <div className="table-wrap" role="tabpanel">
              {compare === 'variant' ? (
                <CompareTable rows={data.byVariant.map((r) => ({ key: r.variant, ...r }))} keyLabel="Variant" />
              ) : (
                <CompareTable rows={data.byVersion.map((r) => ({ key: r.version, ...r }))} keyLabel="Version" prefix="v" />
              )}
            </div>
          </div>

          <h2 className="section-title">Step funnel by version × variant</h2>
          <p className="muted small">
            Step order differs between variants (and some steps exist only in some versions), so the funnel is shown per segment. Drop-off is attributed to the
            furthest step a session saw without reaching the result.
          </p>
          {data.segments.length === 0 && (
            <div className="card empty">
              No events yet. Run <code>npm run seed</code> or walk through the funnel.
            </div>
          )}
          {data.segments.map((seg) => (
            <SegmentFunnel key={`${seg.version}-${seg.variant}`} seg={seg} />
          ))}
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, primary }: { label: string; value: number | string; sub?: string; primary?: boolean }) {
  return (
    <div className={primary ? 'kpi primary-kpi' : 'kpi'}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

function CompareTable({
  rows,
  keyLabel,
  prefix = '',
}: {
  rows: Array<{ key: string; started: number; reachedResult: number; ctaClicked: number; completionRate: number; ctaCtr: number; ctaPerStarted: number }>;
  keyLabel: string;
  prefix?: string;
}) {
  const best = rows.reduce((m, r) => Math.max(m, r.ctaPerStarted), 0);
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{keyLabel}</th>
          <th className="num">Started</th>
          <th className="num">Result</th>
          <th className="num">Completion</th>
          <th className="num">CTA</th>
          <th className="num">CTA CTR</th>
          <th className="num">CTA / started</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>
              <strong>
                {prefix}
                {r.key}
              </strong>
            </td>
            <td className="num">{r.started}</td>
            <td className="num">{r.reachedResult}</td>
            <td className="num">{pct(r.completionRate)}</td>
            <td className="num">{r.ctaClicked}</td>
            <td className="num">{pct(r.ctaCtr)}</td>
            <td className={`num ${rows.length > 1 && r.ctaPerStarted === best && best > 0 ? 'best' : ''}`}>{pct(r.ctaPerStarted)}</td>
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
    <div className="card flush">
      <div className="segment-head">
        <h3>
          <span className="pill brand">v{seg.version}</span>
          <span className="pill dot">variant {seg.variant}</span>
        </h3>
        <div className="segment-stats">
          <span>
            <b>{seg.started}</b> started
          </span>
          <span>
            <b>{seg.reachedResult}</b> reached result ({pct(seg.completionRate)})
          </span>
          <span>
            <b>{seg.ctaClicked}</b> CTA ({pct(seg.ctaCtr)} CTR)
          </span>
        </div>
      </div>
      <div className="table-wrap">
      <table className="table funnel-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Step</th>
            <th>Type</th>
            <th className="num">Viewed</th>
            <th className="num">Reach</th>
            <th className="num">Conv. from prev</th>
            <th className="num">Completed</th>
            <th className="num">Dropped here</th>
            <th className="num">Drop rate</th>
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
              <td className="mono small muted">{s.type}</td>
              <td className="num">{s.viewed}</td>
              <td className="num">{pct(s.reachRate)}</td>
              <td className="num">{pct(s.conversionFromPrev)}</td>
              <td className="num">{s.completed}</td>
              <td className="num">{s.droppedHere}</td>
              <td className={`num ${s.dropRate > 0.3 ? 'warn-text' : ''}`}>{pct(s.dropRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {seg.unknownStepIds.length > 0 && (
        <p className="muted small" style={{ padding: '10px 20px' }}>
          Events for steps not in this segment's config: {seg.unknownStepIds.join(', ')}
        </p>
      )}
    </div>
  );
}
