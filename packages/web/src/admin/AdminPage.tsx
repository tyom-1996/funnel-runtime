import { useCallback, useEffect, useState } from 'react';
import type { PublicationLogEntry, VersionSummary } from '@funnel/shared';
import { api, ApiError, adminToken } from '../api';

export function AdminPage() {
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
    run('Version uploaded as draft', async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(uploadText);
      } catch {
        throw new Error('Not valid JSON');
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
          <h1>Funnel versions</h1>
          <p className="sub">Publish a draft to switch new sessions instantly. Running sessions stay on the version they started with.</p>
        </div>
        <label className="token">
          Admin token
          <input
            type="password"
            value={token}
            placeholder="not required unless ADMIN_TOKEN is set"
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
          <div className="label">Active version</div>
          <div className="value">{active ? `v${active}` : '—'}</div>
        </div>
        <div className="status-tile">
          <div className="label">Versions stored</div>
          <div className="value">{versions.length}</div>
        </div>
        <div className="status-tile">
          <div className="label">Sessions total</div>
          <div className="value">{versions.reduce((s, v) => s + v.sessionCount, 0)}</div>
        </div>
        <div className="status-tile">
          <div className="label">Last change</div>
          <div className="value" style={{ fontSize: '1rem' }}>
            {log[0] ? (
              <>
                <span className={`pill ${log[0].action === 'rollback' ? 'warn' : 'ok'}`}>{log[0].action}</span>
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
              <th>Version</th>
              <th>Title / experiment</th>
              <th>Status</th>
              <th className="num">Steps</th>
              <th className="num">Sessions</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version} className={v.isActive ? 'active-row' : ''}>
                <td>
                  <strong>v{v.version}</strong> {v.isActive && <span className="pill ok dot">active</span>}
                </td>
                <td title={`Created ${fmt(v.createdAt)}`}>
                  <div>{v.title ?? '—'}</div>
                  <div className="mono muted small truncate" title={v.experimentId}>
                    {v.experimentId}
                  </div>
                </td>
                <td>
                  <span className={`pill ${v.status === 'published' ? 'brand' : 'muted'}`}>{v.status}</span>
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
                    JSON
                  </button>
                  {!v.isActive && (
                    <button className="primary small" disabled={busy} onClick={() => void run(`Published v${v.version}`, () => api.adminPublish(v.version))}>
                      Publish
                    </button>
                  )}
                  </div>
                </td>
              </tr>
            ))}
            {versions.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No versions yet. Upload one below.
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
            title={previousVersion ? `Roll back to v${previousVersion}` : 'No previous publication to roll back to'}
            onClick={() => void run(`Rolled back to v${previousVersion}`, () => api.adminRollback())}
          >
            Roll back{previousVersion ? ` to v${previousVersion}` : ''}
          </button>
          <span className="muted small">
            Publishing switches new sessions immediately. Existing sessions stay pinned to the version they started on.
          </span>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Upload a version</h2>
          <p className="muted small">Paste a funnel JSON or pick a file. It is validated against the schema and stored as a draft until you publish it.</p>
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
            Upload as draft
          </button>
        </div>

        <div className="card">
          <h2>Publication log</h2>
          {log.length === 0 && <p className="muted">Nothing published yet.</p>}
          <ul className="log">
            {log.map((l) => (
              <li key={l.id} className={l.action}>
                <span className={`pill ${l.action === 'rollback' ? 'warn' : 'ok'}`}>{l.action}</span>
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
            <h2>v{preview.version} — config</h2>
            <button className="ghost small" onClick={() => setPreview(null)}>
              Close
            </button>
          </div>
          <pre className="json">{JSON.stringify(preview.config, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function fmt(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
function fmtDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}
