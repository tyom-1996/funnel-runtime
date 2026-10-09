import { useCallback, useEffect, useState } from 'react';
import type { AnalyticsFilters, AnalyticsResponse, FunnelMetrics } from '@funnel/shared';
import { api } from '../api';
import { useI18n } from '../i18n';

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);

export function DashboardPage() {
  const { t } = useI18n();
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
          <h1>{t.dashboard.title}</h1>
          <p className="sub">{t.dashboard.subtitle}</p>
        </div>
        <div className="filters">
          <label className="select">
            {t.dashboard.version}
            <select value={filters.version ?? ''} onChange={set('version')}>
              <option value="">{t.common.all}</option>
              {data?.versions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="select">
            {t.dashboard.variant}
            <select value={filters.variant ?? ''} onChange={set('variant')}>
              <option value="">{t.common.all}</option>
              {data?.variants.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="select">
            {t.dashboard.campaign}
            <select value={filters.utm_campaign ?? ''} onChange={set('utm_campaign')}>
              <option value="">{t.common.all}</option>
              {data?.campaigns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <button className="ghost" onClick={() => void load(filters)} disabled={loading}>
            {t.common.refresh}
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      {data && (
        <>
          <div className="kpis">
            <Kpi label={t.dashboard.kpiCtaPerStarted} value={pct(data.overview.ctaPerStarted)} sub={t.dashboard.kpiPrimary} primary />
            <Kpi label={t.dashboard.kpiStarted} value={data.overview.started} />
            <Kpi label={t.dashboard.kpiReached} value={data.overview.reachedResult} sub={t.dashboard.kpiOfStarted(pct(data.overview.completionRate))} />
            <Kpi label={t.dashboard.kpiCta} value={data.overview.ctaClicked} sub={t.dashboard.kpiCtr(pct(data.overview.ctaCtr))} />
            <Kpi label={t.dashboard.kpiEvents} value={data.overview.totalEvents} sub={t.dashboard.kpiDuplicates(data.overview.duplicateProtectedEvents)} />
          </div>

          <div className="card flush">
            <div className="card-head tabs-head">
              <div className="tabs" role="tablist" aria-label={t.dashboard.compareBy}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={compare === 'variant'}
                  className={compare === 'variant' ? 'tab active' : 'tab'}
                  onClick={() => setCompare('variant')}
                >
                  {t.dashboard.abTab}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={compare === 'version'}
                  className={compare === 'version' ? 'tab active' : 'tab'}
                  onClick={() => setCompare('version')}
                >
                  {t.dashboard.versionsTab}
                </button>
              </div>
              <p className="muted small">
                {compare === 'variant' ? t.dashboard.abHint : t.dashboard.versionsHint}
              </p>
            </div>
            <div className="table-wrap" role="tabpanel">
              {compare === 'variant' ? (
                <CompareTable rows={data.byVariant.map((r) => ({ key: r.variant, ...r }))} keyLabel={t.dashboard.variant} />
              ) : (
                <CompareTable rows={data.byVersion.map((r) => ({ key: r.version, ...r }))} keyLabel={t.dashboard.version} prefix="v" />
              )}
            </div>
          </div>

          <h2 className="section-title">{t.dashboard.stepsTitle}</h2>
          <p className="muted small">{t.dashboard.stepsHint}</p>
          {data.segments.length === 0 && (
            <div className="card empty">
              {t.dashboard.emptyBefore} <code>npm run seed</code> {t.dashboard.emptyAfter}
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
  const { t } = useI18n();
  const best = rows.reduce((m, r) => Math.max(m, r.ctaPerStarted), 0);
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{keyLabel}</th>
          <th className="num">{t.dashboard.colStarted}</th>
          <th className="num">{t.dashboard.colResult}</th>
          <th className="num">{t.dashboard.colCompletion}</th>
          <th className="num">{t.dashboard.colCta}</th>
          <th className="num">{t.dashboard.colCtaCtr}</th>
          <th className="num">{t.dashboard.colCtaPerStarted}</th>
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
              {t.common.noData}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function SegmentFunnel({ seg }: { seg: FunnelMetrics }) {
  const { t } = useI18n();
  const max = Math.max(1, seg.started);
  return (
    <div className="card flush">
      <div className="segment-head">
        <h3>
          <span className="pill brand">v{seg.version}</span>
          <span className="pill dot">{t.dashboard.segVariant(seg.variant)}</span>
        </h3>
        <div className="segment-stats">
          <span>
            <b>{seg.started}</b> {t.dashboard.segStarted}
          </span>
          <span>
            <b>{seg.reachedResult}</b> {t.dashboard.segReached} ({pct(seg.completionRate)})
          </span>
          <span>
            <b>{seg.ctaClicked}</b> {t.dashboard.segCta} ({pct(seg.ctaCtr)} {t.dashboard.ctr})
          </span>
        </div>
      </div>
      <div className="table-wrap">
      <table className="table funnel-table">
        <thead>
          <tr>
            <th>#</th>
            <th>{t.dashboard.colStep}</th>
            <th>{t.dashboard.colType}</th>
            <th className="num">{t.dashboard.colViewed}</th>
            <th className="num">{t.dashboard.colReach}</th>
            <th className="num">{t.dashboard.colConv}</th>
            <th className="num">{t.dashboard.colCompleted}</th>
            <th className="num">{t.dashboard.colDropped}</th>
            <th className="num">{t.dashboard.colDropRate}</th>
          </tr>
        </thead>
        <tbody>
          {seg.steps.map((s) => (
            <tr key={s.stepId} className={s.viewed === 0 ? 'muted' : ''}>
              <td>{s.index + 1}</td>
              <td>
                <div className="step-cell">
                  <div className="step-title">
                    {s.title} <span className="mono muted small">{s.stepId}</span>
                  </div>
                  <div className="bar-track" aria-hidden>
                    <div className="bar" style={{ width: `${(s.viewed / max) * 100}%` }} />
                  </div>
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
          {t.dashboard.unknownSteps(seg.unknownStepIds.join(', '))}
        </p>
      )}
    </div>
  );
}
