import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { openDb, type Db } from './db.js';
import { HttpError } from './errors.js';
import { VersionService } from './versions.js';
import { SessionService } from './sessions.js';
import { EventService } from './events.js';
import { AnalyticsService } from './analytics.js';

export interface AppOptions {
  dbFile: string;
  /** Directory with funnel-*.json to load on boot (all as drafts; the one marked `published` becomes active if nothing is). */
  configsDir?: string;
  /** Directory with the built frontend to serve. */
  staticDir?: string;
  adminToken?: string;
  random?: () => number;
}

export interface AppContext {
  app: express.Express;
  db: Db;
  versions: VersionService;
  sessions: SessionService;
  events: EventService;
  analytics: AnalyticsService;
}

export function createApp(opts: AppOptions): AppContext {
  const db = openDb(opts.dbFile);
  const versions = new VersionService(db);
  const sessions = new SessionService(db, versions, opts.random);
  const events = new EventService(db, versions);
  const analytics = new AnalyticsService(db, versions);

  if (opts.configsDir) bootstrapConfigs(versions, opts.configsDir);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const wrap =
    (fn: (req: Request, res: Response) => unknown) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve()
        .then(() => fn(req, res))
        .catch(next);
    };

  const param = (req: Request, name: string): string => {
    const v = req.params[name];
    if (typeof v !== 'string' || v === '') throw new HttpError(400, `Missing route parameter "${name}"`);
    return v;
  };

  const requireAdmin = (req: Request, _res: Response, next: NextFunction) => {
    if (!opts.adminToken) return next();
    const token = req.header('x-admin-token') ?? (typeof req.query.token === 'string' ? req.query.token : undefined);
    if (token !== opts.adminToken) return next(new HttpError(401, 'Admin token required'));
    next();
  };

  // ---------- health ----------
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, activeVersion: versions.getActiveVersion(), time: new Date().toISOString() });
  });

  // ---------- sessions ----------
  app.post(
    '/api/sessions',
    wrap((req, res) => {
      const body = (req.body ?? {}) as { utm?: unknown; variantOverride?: string | null };
      const active = versions.getActive();
      // override is only honoured through the query param named in the config
      const param = active.experiment.overrideQueryParam;
      const fromQuery = typeof req.query[param] === 'string' ? (req.query[param] as string) : null;
      const override = fromQuery ?? body.variantOverride ?? null;
      res.status(201).json(sessions.create({ utm: body.utm, variantOverride: override }));
    }),
  );

  app.get(
    '/api/sessions/:id',
    wrap((req, res) => {
      res.json(sessions.get(param(req, 'id')));
    }),
  );

  app.patch(
    '/api/sessions/:id',
    wrap((req, res) => {
      const body = (req.body ?? {}) as { answers?: Record<string, unknown>; currentStepId?: string | null };
      res.json(sessions.update(param(req, 'id'), body));
    }),
  );

  // ---------- events ----------
  app.post(
    '/api/events',
    wrap((req, res) => {
      const result = events.ingest(req.body);
      // 207 Multi-Status when the batch is mixed, 200 when everything was accepted/duplicate
      const status = result.summary.rejected > 0 ? 207 : 200;
      res.status(status).json(result);
    }),
  );

  // ---------- public config info ----------
  app.get(
    '/api/versions/active',
    wrap((_req, res) => {
      const v = versions.getActiveVersion();
      res.json({ version: v, summary: v ? versions.summary(v) : null });
    }),
  );

  // ---------- admin ----------
  app.get(
    '/api/admin/versions',
    requireAdmin,
    wrap((_req, res) => {
      res.json({ activeVersion: versions.getActiveVersion(), versions: versions.list(), log: versions.log() });
    }),
  );

  app.get(
    '/api/admin/versions/:version',
    requireAdmin,
    wrap((req, res) => {
      res.json({ summary: versions.summary(param(req, 'version')), config: versions.getRaw(param(req, 'version')) });
    }),
  );

  app.post(
    '/api/admin/versions',
    requireAdmin,
    wrap((req, res) => {
      const config = versions.create(req.body);
      res.status(201).json(versions.summary(config.version));
    }),
  );

  app.post(
    '/api/admin/versions/:version/publish',
    requireAdmin,
    wrap((req, res) => {
      res.json(versions.publish(param(req, 'version')));
    }),
  );

  app.post(
    '/api/admin/rollback',
    requireAdmin,
    wrap((req, res) => {
      const body = (req.body ?? {}) as { toVersion?: string };
      res.json(versions.rollback(body.toVersion));
    }),
  );

  // ---------- analytics ----------
  app.get(
    '/api/analytics',
    requireAdmin,
    wrap((req, res) => {
      const q = (k: string) => (typeof req.query[k] === 'string' && req.query[k] !== '' ? (req.query[k] as string) : undefined);
      res.json(analytics.compute({ version: q('version'), variant: q('variant'), utm_campaign: q('utm_campaign') }));
    }),
  );

  app.get(
    '/api/analytics/sessions/:id/events',
    requireAdmin,
    wrap((req, res) => {
      const rows = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY server_timestamp, client_timestamp').all(param(req, 'id'));
      res.json(rows);
    }),
  );

  // ---------- static frontend ----------
  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir, { index: false, maxAge: '1h' }));
    const indexHtml = path.join(opts.staticDir, 'index.html');
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  // ---------- errors ----------
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.issues });
      return;
    }
    if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Malformed JSON body' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return { app, db, versions, sessions, events, analytics };
}

/**
 * Loads every *.json in `dir` as a version (ignores ones already stored).
 * If no version is active, activates the config whose own `status` is
 * `published` — that is how the very first deploy gets v1 live without
 * touching the admin UI. Later versions (e.g. v3 shipped as `draft`) wait
 * for an explicit publish.
 */
export function bootstrapConfigs(versions: VersionService, dir: string) {
  if (!fs.existsSync(dir)) return;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  let publishedCandidate: string | null = null;
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const config = versions.ensure(raw);
      if (raw.status === 'published' && !publishedCandidate) publishedCandidate = config.version;
    } catch (e) {
      console.warn(`[bootstrap] skipping ${f}: ${(e as Error).message}`);
    }
  }
  if (!versions.getActiveVersion() && publishedCandidate) {
    versions.publish(publishedCandidate);
    console.log(`[bootstrap] activated ${publishedCandidate}`);
  }
}
