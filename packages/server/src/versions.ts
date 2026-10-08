import { parseFunnelConfig, type FunnelConfig, type PublicationLogEntry, type VersionSummary } from '@funnel/shared';
import type { Db } from './db.js';
import { nowIso } from './db.js';
import { HttpError } from './errors.js';

interface VersionRow {
  version: string;
  funnel_id: string;
  name: string | null;
  status: 'draft' | 'published' | 'archived';
  is_active: number;
  config_json: string;
  created_at: string;
  published_at: string | null;
}

export class VersionService {
  private cache = new Map<string, FunnelConfig>();

  constructor(private db: Db) {}

  /** Upload a new version (draft) from raw JSON. Rejects duplicates and invalid configs. */
  create(raw: unknown, opts: { status?: 'draft' | 'published' } = {}): FunnelConfig {
    const config = parseFunnelConfig(raw);
    const existing = this.db.prepare('SELECT version FROM funnel_versions WHERE version = ?').get(config.version);
    if (existing) throw new HttpError(409, `Version "${config.version}" already exists`);
    this.db
      .prepare(
        `INSERT INTO funnel_versions(version, funnel_id, name, status, config_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(config.version, config.funnelId, config.name ?? null, opts.status ?? 'draft', JSON.stringify(raw));
    this.cache.set(config.version, config);
    return config;
  }

  /** Idempotent helper for bootstrapping: insert if missing, return the stored config. */
  ensure(raw: unknown): FunnelConfig {
    const config = parseFunnelConfig(raw);
    const row = this.db.prepare('SELECT version FROM funnel_versions WHERE version = ?').get(config.version);
    if (!row) return this.create(raw);
    return this.get(config.version);
  }

  get(version: string): FunnelConfig {
    const cached = this.cache.get(version);
    if (cached) return cached;
    const row = this.db.prepare('SELECT config_json FROM funnel_versions WHERE version = ?').get(version) as
      | { config_json: string }
      | undefined;
    if (!row) throw new HttpError(404, `Version "${version}" not found`);
    const config = parseFunnelConfig(JSON.parse(row.config_json));
    this.cache.set(version, config);
    return config;
  }

  getRaw(version: string): unknown {
    const row = this.db.prepare('SELECT config_json FROM funnel_versions WHERE version = ?').get(version) as
      | { config_json: string }
      | undefined;
    if (!row) throw new HttpError(404, `Version "${version}" not found`);
    return JSON.parse(row.config_json);
  }

  getActiveVersion(): string | null {
    const row = this.db.prepare('SELECT version FROM funnel_versions WHERE is_active = 1').get() as { version: string } | undefined;
    return row?.version ?? null;
  }

  getActive(): FunnelConfig {
    const v = this.getActiveVersion();
    if (!v) throw new HttpError(503, 'No active funnel version. Publish one in /admin.');
    return this.get(v);
  }

  /**
   * Make `version` the active one. Takes effect immediately for new sessions;
   * existing sessions keep their pinned version. No redeploy involved.
   */
  publish(version: string, action: 'publish' | 'rollback' = 'publish'): VersionSummary {
    this.get(version); // throws 404 if unknown
    const from = this.getActiveVersion();
    if (from === version) throw new HttpError(409, `Version "${version}" is already active`);
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE funnel_versions SET is_active = 0 WHERE is_active = 1').run();
      this.db
        .prepare(
          `UPDATE funnel_versions SET is_active = 1, status = 'published', published_at = COALESCE(published_at, ?) WHERE version = ?`,
        )
        .run(nowIso(), version);
      this.db.prepare('INSERT INTO publication_log(action, from_version, to_version) VALUES (?, ?, ?)').run(action, from, version);
    });
    tx();
    return this.summary(version);
  }

  /**
   * Roll back to the version that was active before the current one, based on
   * the publication log (NOT on version numbering — versions are not sequential).
   * Optionally roll back to an explicit version.
   */
  rollback(toVersion?: string): VersionSummary {
    const current = this.getActiveVersion();
    let target = toVersion;
    if (!target) {
      const row = this.db
        .prepare('SELECT from_version FROM publication_log WHERE to_version = ? AND from_version IS NOT NULL ORDER BY id DESC LIMIT 1')
        .get(current ?? '') as { from_version: string | null } | undefined;
      target = row?.from_version ?? undefined;
    }
    if (!target) throw new HttpError(409, 'Nothing to roll back to');
    return this.publish(target, 'rollback');
  }

  list(): VersionSummary[] {
    const rows = this.db.prepare('SELECT * FROM funnel_versions ORDER BY created_at ASC').all() as VersionRow[];
    return rows.map((r) => this.toSummary(r));
  }

  summary(version: string): VersionSummary {
    const row = this.db.prepare('SELECT * FROM funnel_versions WHERE version = ?').get(version) as VersionRow | undefined;
    if (!row) throw new HttpError(404, `Version "${version}" not found`);
    return this.toSummary(row);
  }

  log(): PublicationLogEntry[] {
    const rows = this.db.prepare('SELECT * FROM publication_log ORDER BY id DESC LIMIT 100').all() as Array<{
      id: number;
      action: 'publish' | 'rollback';
      from_version: string | null;
      to_version: string;
      created_at: string;
    }>;
    return rows.map((r) => ({ id: r.id, action: r.action, fromVersion: r.from_version, toVersion: r.to_version, createdAt: r.created_at }));
  }

  private toSummary(r: VersionRow): VersionSummary {
    const config = this.get(r.version);
    const sessions = this.db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE funnel_version = ?').get(r.version) as { c: number };
    return {
      version: r.version,
      funnelId: r.funnel_id,
      name: r.name,
      status: r.status,
      isActive: r.is_active === 1,
      createdAt: r.created_at,
      publishedAt: r.published_at,
      experimentId: config.experiment.id,
      stepCount: config.steps.length,
      sessionCount: sessions.c,
    };
  }
}
