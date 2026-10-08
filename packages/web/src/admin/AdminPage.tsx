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
      <div className="row space-between">
        <h1>Funnel versions</h1>
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

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Name</th>
              <th>Status</th>
              <th>Experiment</th>
              <th>Steps</th>
              <th>Sessions</th>
              <th>Created</th>
              <th>Published</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version} className={v.isActive ? 'active-row' : ''}>
                <td>
                  <strong>{v.version}</strong> {v.isActive && <span className="pill ok">active</span>}
                </td>
                <td>{v.name ?? '—'}</td>
                <td>{v.status}</td>
                <td className="mono">{v.experimentId}</td>
                <td>{v.stepCount}</td>
                <td>{v.sessionCount}</td>
                <td className="mono">{fmt(v.createdAt)}</td>
                <td className="mono">{v.publishedAt ? fmt(v.publishedAt) : '—'}</td>
                <td className="row gap">
                  <button
                    className="ghost small"
                    onClick={() => void api.adminVersion(v.version).then((r) => setPreview({ version: v.version, config: r.config }))}
                  >
                    View JSON
                  </button>
                  {!v.isActive && (
                    <button className="primary small" disabled={busy} onClick={() => void run(`Published ${v.version}`, () => api.adminPublish(v.version))}>
                      Publish
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {versions.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  No versions yet. Upload one below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="row gap" style={{ marginTop: 12 }}>
          <button
            className="danger"
            disabled={busy || !previousVersion}
            title={previousVersion ? `Roll back to ${previousVersion}` : 'No previous publication to roll back to'}
            onClick={() => void run(`Rolled back to ${previousVersion}`, () => api.adminRollback())}
          >
            Roll back{previousVersion ? ` to ${previousVersion}` : ''}
          </button>
          <span className="muted small">
            Publishing switches new sessions immediately. Existing sessions stay pinned to the version they started on.
          </span>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Upload a version</h2>
          <p className="muted small">Paste a funnel JSON or pick a file. It is stored as a draft until you publish it.</p>
          <input type="file" accept="application/json,.json" onChange={(e) => void onFile(e.target.files?.[0])} />
          <textarea
            rows={12}
            value={uploadText}
            onChange={(e) => setUploadText(e.target.value)}
            placeholder='{ "funnelId": "...", "version": "v3", ... }'
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
              <li key={l.id}>
                <span className={`pill ${l.action === 'rollback' ? 'warn' : 'ok'}`}>{l.action}</span>{' '}
                <span className="mono">{l.fromVersion ?? '∅'}</span> → <span className="mono">{l.toVersion}</span>{' '}
                <span className="muted small mono">{fmt(l.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {preview && (
        <div className="card">
          <div className="row space-between">
            <h2>{preview.version} — config</h2>
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
