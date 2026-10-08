import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/server/src and packages/server/dist are both three levels below the repo root
const repoRoot = path.resolve(here, '../../..');

const PORT = Number(process.env.PORT ?? 3000);
const DB_FILE = process.env.DB_FILE ?? path.join(repoRoot, 'data', 'funnel.sqlite');
const CONFIGS_DIR = process.env.CONFIGS_DIR ?? path.join(repoRoot, 'configs');
const STATIC_DIR = process.env.STATIC_DIR ?? path.join(repoRoot, 'packages', 'web', 'dist');

const { app, versions } = createApp({
  dbFile: DB_FILE,
  configsDir: CONFIGS_DIR,
  staticDir: STATIC_DIR,
  adminToken: process.env.ADMIN_TOKEN || undefined,
});

app.listen(PORT, () => {
  console.log(`funnel-runtime listening on http://localhost:${PORT}`);
  console.log(`db: ${DB_FILE}`);
  console.log(`active version: ${versions.getActiveVersion() ?? 'none'}`);
});
