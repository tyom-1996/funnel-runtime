/**
 * Tiny admin CLI that talks to the running server over HTTP.
 *
 *   npm run publish-version -- upload configs/funnel-v3.json
 *   npm run publish-version -- publish v3
 *   npm run publish-version -- rollback [v1]
 *   npm run publish-version -- list
 *
 * Env: BASE_URL (default http://localhost:3000), ADMIN_TOKEN
 */
import fs from 'node:fs';

const base = process.env.BASE_URL ?? 'http://localhost:3000';
const headers: Record<string, string> = { 'content-type': 'application/json' };
if (process.env.ADMIN_TOKEN) headers['x-admin-token'] = process.env.ADMIN_TOKEN;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`${method} ${path} → ${res.status}`, JSON.stringify(json, null, 2));
    process.exit(1);
  }
  return json;
}

const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case 'list': {
    const r = (await call('GET', '/api/admin/versions')) as {
      activeVersion: string | null;
      versions: Array<{ version: string; status: string; isActive: boolean; sessionCount: number; experimentId: string }>;
    };
    for (const v of r.versions) {
      console.log(`${v.isActive ? '●' : '○'} ${v.version.padEnd(6)} ${v.status.padEnd(10)} sessions=${v.sessionCount}  experiment=${v.experimentId}`);
    }
    break;
  }
  case 'upload': {
    if (!arg) throw new Error('usage: upload <file.json>');
    const raw = JSON.parse(fs.readFileSync(arg, 'utf8'));
    const r = await call('POST', '/api/admin/versions', raw);
    console.log('uploaded as draft:', JSON.stringify(r));
    break;
  }
  case 'publish': {
    if (!arg) throw new Error('usage: publish <version>');
    const r = await call('POST', `/api/admin/versions/${arg}/publish`, {});
    console.log('published:', JSON.stringify(r));
    break;
  }
  case 'rollback': {
    const r = await call('POST', '/api/admin/rollback', arg ? { toVersion: arg } : {});
    console.log('rolled back, active is now:', JSON.stringify(r));
    break;
  }
  default:
    console.log('commands: list | upload <file> | publish <version> | rollback [version]');
}
