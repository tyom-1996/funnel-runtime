import { useCallback, useEffect, useState } from 'react';
import type { PublicationLogEntry, VersionSummary } from '@funnel/shared';
import { api, ApiError, adminToken } from '../api';
import { useI18n } from '../i18n';

export function AdminPage() {
  const { t, locale } = useI18n();
  const fmt = (iso: string) => fmtWith(iso, locale, 'full');
  const fmtDate = (iso: string) => fmtWith(iso, locale, 'date');
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [log, setLog] = useState<PublicationLogEntry[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadText, setUploadText] = useState('');
  const [preview, setPreview] = useState<{ version: string; config: unknown } | null>(null);
  const [token, setToken] = useState(adminToken.get());

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await api.adminVersions();
      setVersions(res.versions);
      setLog(res.log);
      setActive(res.activeVersion);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(label);
      await refresh();
    } catch (e) {
      const msg = e instanceof ApiError && e.details ? `${e.message}: ${JSON.stringify(e.details).slice(0, 400)}` : e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const upload = () =>
    run(t.admin.noticeUploaded, async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(uploadText);
      } catch {
        throw new Error(t.admin.notJson);
      }
      await api.adminUpload(parsed);
      setUploadText('');
    });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploadText(await file.text());
  };

  const previousVersion = (() => {
    const last = log.find((l) => l.toVersion === active && l.fromVersion);
    return last?.fromVersion ?? null;
  })();

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>{t.admin.title}</h1>
          <p className="sub">{t.admin.subtitle}</p>
        </div>
        <label className="token">
          {t.admin.token}
          <input
            type="password"
            value={token}
            placeholder={t.admin.tokenPlaceholder}
            onChange={(e) => {
              setToken(e.target.value);
              adminToken.set(e.target.value);
            }}
            onBlur={() => void refresh()}
          />
        </label>
      </div>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      <div className="status-strip">
        <div className="status-tile accent">
          <div className="label">{t.admin.activeVersion}</div>
          <div className="value">{active ? `v${active}` : '—'}</div>
        </div>
        <div className="status-tile">
          <div className="label">{t.admin.versionsStored}</div>
          <div className="value">{versions.length}</div>
        </div>
        <div className="status-tile">
          <div className="label">{t.admin.sessionsTotal}</div>
          <div className="value">{versions.reduce((s, v) => s + v.sessionCount, 0)}</div>
        </div>
        <div className="status-tile">
          <div className="label">{t.admin.lastChange}</div>
          <div className="value" style={{ fontSize: '1rem' }}>
            {log[0] ? (
              <>
                <span className={`pill ${log[0].action === 'rollback' ? 'warn' : 'ok'}`}>{t.admin.action[log[0].action] ?? log[0].action}</span>
                <span className="muted small">{fmt(log[0].createdAt)}</span>
              </>
            ) : (
              '—'
            )}
          </div>
        </div>
      </div>

      <div className="card flush">
        <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t.admin.colVersion}</th>
              <th>{t.admin.colTitle}</th>
              <th>{t.admin.colStatus}</th>
              <th className="num">{t.admin.colSteps}</th>
              <th className="num">{t.admin.colSessions}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version} className={v.isActive ? 'active-row' : ''}>
                <td>
                  <strong>v{v.version}</strong> {v.isActive && <span className="pill ok dot">{t.admin.active}</span>}
                </td>
                <td title={t.admin.created(fmt(v.createdAt))}>
                  <div>{v.title ?? '—'}</div>
                  <div className="mono muted small truncate" title={v.experimentId}>
                    {v.experimentId}
                  </div>
                </td>
                <td>
                  <span className={`pill ${v.status === 'published' ? 'brand' : 'muted'}`}>{t.admin.status[v.status] ?? v.status}</span>
                  {v.publishedAt && (
                    <div className="muted small" title={fmt(v.publishedAt)}>
                      {fmtDate(v.publishedAt)}
                    </div>
                  )}
                </td>
                <td className="num">{v.stepCount}</td>
                <td className="num">{v.sessionCount}</td>
                <td className="actions-cell">
                  <div>
                  <button
                    className="ghost small"
                    onClick={() => void api.adminVersion(v.version).then((r) => setPreview({ version: v.version, config: r.config }))}
                  >
                    {t.admin.json}
                  </button>
                  {!v.isActive && (
                    <button className="primary small" disabled={busy} onClick={() => void run(t.admin.noticePublished(v.version), () => api.adminPublish(v.version))}>
                      {t.admin.publish}
                    </button>
                  )}
                  </div>
                </td>
              </tr>
            ))}
            {versions.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  {t.admin.noVersions}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
        <div className="row gap wrap" style={{ padding: '14px 20px' }}>
          <button
            className="danger"
            disabled={busy || !previousVersion}
            title={previousVersion ? t.admin.rollBackTo(previousVersion) : t.admin.noRollback}
            onClick={() => void run(t.admin.noticeRolledBack(previousVersion ?? ''), () => api.adminRollback())}
          >
            {previousVersion ? t.admin.rollBackTo(previousVersion) : t.admin.rollBack}
          </button>
          <span className="muted small">
            {t.admin.publishHint}
          </span>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>{t.admin.uploadTitle}</h2>
          <p className="muted small">{t.admin.uploadHint}</p>
          <label className="file">
            <input type="file" accept="application/json,.json" onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
          <textarea
            rows={12}
            value={uploadText}
            onChange={(e) => setUploadText(e.target.value)}
            placeholder='{ "funnelId": "...", "version": 3, "status": "draft", ... }'
            spellCheck={false}
          />
          <button className="primary" disabled={busy || !uploadText.trim()} onClick={() => void upload()}>
            {t.admin.uploadButton}
          </button>
        </div>

        <div className="card">
          <h2>{t.admin.logTitle}</h2>
          {log.length === 0 && <p className="muted">{t.admin.logEmpty}</p>}
          <ul className="log">
            {log.map((l) => (
              <li key={l.id} className={l.action}>
                <span className={`pill ${l.action === 'rollback' ? 'warn' : 'ok'}`}>{t.admin.action[l.action] ?? l.action}</span>
                <span className="mono">{l.fromVersion ? `v${l.fromVersion}` : '∅'}</span>
                <span className="arrow">→</span>
                <span className="mono">
                  <strong>v{l.toVersion}</strong>
                </span>
                <time>{fmt(l.createdAt)}</time>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {preview && (
        <div className="card">
          <div className="card-head">
            <h2>{t.admin.configOf(preview.version)}</h2>
            <button className="ghost small" onClick={() => setPreview(null)}>
              {t.common.close}
            </button>
          </div>
          <pre className="json">{JSON.stringify(preview.config, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function fmtWith(iso: string, locale: string, kind: 'full' | 'date') {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return kind === 'full' ? d.toLocaleString(locale) : d.toLocaleDateString(locale);
}
