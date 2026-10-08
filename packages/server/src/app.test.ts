import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp, type AppContext } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const v1raw = JSON.parse(readFileSync(path.join(here, '../../../configs/funnel-v1.json'), 'utf8'));

/** A fictional later version: non-sequential number, arrives as draft, adds a step + an event. */
function makeV9() {
  const v9 = JSON.parse(JSON.stringify(v1raw));
  v9.version = 9;
  v9.status = 'draft';
  v9.experiment.id = 'exp-v9';
  v9.steps.meeting_hours = {
    id: 'meeting_hours',
    type: 'number',
    content: { title: 'Meeting hours per week?' },
    input: { min: 0, max: 40, step: 1 },
    validation: { required: true },
  };
  for (const v of Object.values(v9.experiment.variants) as Array<{ stepSequence: string[] }>) v.stepSequence.splice(5, 0, 'meeting_hours');
  v9.events.allowed.push({ name: 'recommendation_expanded', properties: ['result_id'] });
  return v9;
}

let ctx: AppContext;
let api: ReturnType<typeof request>;

beforeEach(() => {
  // deterministic variant assignment: alternating A, B, A, B...
  let i = 0;
  ctx = createApp({ dbFile: ':memory:', random: () => (i++ % 2 === 0 ? 0.1 : 0.9) });
  ctx.versions.create(v1raw);
  ctx.versions.publish('1');
  api = request(ctx.app);
});

const ev = (session_id: string, event_type: string, step_id?: string, extra: Record<string, unknown> = {}) => ({
  event_id: randomUUID(),
  session_id,
  event_type,
  step_id,
  client_timestamp: new Date().toISOString(),
  ...extra,
});

describe('version pinning', () => {
  it('a session keeps its version after a new one is published; new sessions get the new one', async () => {
    const old = await api.post('/api/sessions').send({}).expect(201);
    expect(old.body.session.funnelVersion).toBe('1');

    ctx.versions.create(makeV9());
    ctx.versions.publish('9');

    const again = await api.get(`/api/sessions/${old.body.session.id}`).expect(200);
    expect(again.body.session.funnelVersion).toBe('1');
    expect(again.body.funnel.version).toBe('1');
    expect(again.body.funnel.steps.map((s: { id: string }) => s.id)).not.toContain('meeting_hours');

    const fresh = await api.post('/api/sessions').send({}).expect(201);
    expect(fresh.body.session.funnelVersion).toBe('9');
    expect(fresh.body.funnel.steps.map((s: { id: string }) => s.id)).toContain('meeting_hours');

    // old session can still progress and is validated against ITS config
    await api.patch(`/api/sessions/${old.body.session.id}`).send({ answers: { team_size: 5 }, currentStepId: 'work_mode' }).expect(200);
    await api.patch(`/api/sessions/${old.body.session.id}`).send({ answers: { meeting_hours: 5 } }).expect(400);
  });

  it('answers are validated against the config and stale hidden answers are pruned', async () => {
    const s = (await api.post('/api/sessions?variant=A').send({})).body.session.id;
    await api.patch(`/api/sessions/${s}`).send({ answers: { team_size: 0 } }).expect(400);
    await api.patch(`/api/sessions/${s}`).send({ answers: { team_size: 2.5 } }).expect(400); // step: 1
    await api.patch(`/api/sessions/${s}`).send({ answers: { work_mode: 'hybrid', office_days: 3 } }).expect(200);
    const changed = await api.patch(`/api/sessions/${s}`).send({ answers: { work_mode: 'remote' } }).expect(200);
    expect(changed.body.session.answers).toEqual({ work_mode: 'remote' });
  });
});

describe('A/B assignment', () => {
  it('is assigned by the server, is stable across reloads and honours the override param', async () => {
    const a = await api.post('/api/sessions').send({}).expect(201);
    const b = await api.post('/api/sessions').send({}).expect(201);
    expect([a.body.session.variant, b.body.session.variant].sort()).toEqual(['A', 'B']);

    for (let i = 0; i < 3; i++) {
      const r = await api.get(`/api/sessions/${a.body.session.id}`).expect(200);
      expect(r.body.session.variant).toBe(a.body.session.variant);
    }

    const forced = await api.post('/api/sessions?variant=B').send({}).expect(201);
    expect(forced.body.session.variant).toBe('B');
    expect(forced.body.session.variantSource).toBe('override');
    expect(forced.body.funnel.steps[1].id).toBe('work_mode'); // B order (A starts with team_size)
    expect(forced.body.funnel.steps[0].content.title).toBe('How should your team really work?');

    const bogus = await api.post('/api/sessions?variant=Z').send({}).expect(201);
    expect(['A', 'B']).toContain(bogus.body.session.variant);
    expect(bogus.body.session.variantSource).toBe('assigned');
  });

  it('weights roughly 50/50 with the real RNG', () => {
    const real = createApp({ dbFile: ':memory:' });
    real.versions.create(v1raw);
    real.versions.publish('1');
    const counts = { A: 0, B: 0 };
    for (let i = 0; i < 400; i++) counts[real.sessions.create({}).session.variant as 'A' | 'B']++;
    expect(counts.A).toBeGreaterThan(130);
    expect(counts.B).toBeGreaterThan(130);
  });
});

describe('event ingestion', () => {
  it('deduplicates by event_id, including whole-batch retries and in-batch repeats', async () => {
    const s = (await api.post('/api/sessions').send({})).body.session.id;
    const batch = [ev(s, 'session_started'), ev(s, 'step_viewed', 'intro'), ev(s, 'step_viewed', 'intro')];
    batch.push({ ...batch[1]! }); // same event_id repeated within the batch

    const first = await api.post('/api/events').send(batch).expect(200);
    expect(first.body.results.map((r: { status: string }) => r.status)).toEqual(['accepted', 'accepted', 'accepted', 'duplicate']);

    const retry = await api.post('/api/events').send(batch).expect(200);
    expect(retry.body.summary).toEqual({ accepted: 0, duplicate: 4, rejected: 0 });

    const count = ctx.db.prepare('SELECT COUNT(*) c FROM events').get() as { c: number };
    expect(count.c).toBe(3);
  });

  it('rejects bad events individually and keeps the rest of the batch', async () => {
    const s = (await api.post('/api/sessions').send({})).body.session.id;
    const res = await api
      .post('/api/events')
      .send([
        ev(s, 'session_started'),
        { event_id: randomUUID(), session_id: s }, // missing fields
        ev('00000000-0000-0000-0000-000000000000', 'step_viewed', 'intro'), // unknown session
        ev(s, 'recommendation_expanded', 'result'), // not allowed in v1
        ev(s, 'cta_clicked', 'result'),
      ])
      .expect(207);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['accepted', 'rejected', 'rejected', 'rejected', 'accepted']);
    expect(res.body.results[3].reason).toMatch(/not allowed in version 1/);
    expect(res.body.summary).toEqual({ accepted: 2, duplicate: 0, rejected: 3 });
  });

  it('takes version/variant/utm from the session and strips raw answers', async () => {
    const s = (
      await api
        .post('/api/sessions?variant=B')
        .send({ utm: { utm_campaign: 'spring', utm_source: 'ads' } })
    ).body.session.id;
    const e = ev(s, 'answer_submitted', 'team_size', {
      properties: { answer_kind: 'number', value: 12, answer: 12 },
      funnel_version: 'hacked',
      variant: 'Z',
    });
    await api.post('/api/events').send([e]).expect(200);
    const row = ctx.db.prepare('SELECT * FROM events WHERE event_id = ?').get(e.event_id) as Record<string, string>;
    expect(row.funnel_version).toBe('1');
    expect(row.variant).toBe('B');
    expect(row.utm_campaign).toBe('spring');
    expect(row.utm_source).toBe('ads');
    expect(row.server_timestamp).toBeTruthy();
    expect(JSON.parse(row.properties_json!)).toEqual({ answer_kind: 'number' });
  });

  it('a non-array body is rejected, not a 500', async () => {
    const res = await api.post('/api/events').send({ nope: true }).expect(207);
    expect(res.body.results[0].status).toBe('rejected');
  });
});

describe('publish and rollback', () => {
  it('publishes a draft, rolls back via the publication log, and keeps sessions on their versions', async () => {
    const onV1 = (await api.post('/api/sessions').send({})).body.session.id;

    ctx.versions.create(makeV9()); // arrives as draft, version number is not sequential
    let list = ctx.versions.list();
    expect(list.find((v) => v.version === '9')?.status).toBe('draft');
    expect(list.find((v) => v.version === '9')?.isActive).toBe(false);

    await api.post('/api/admin/versions/9/publish').expect(200);
    expect(ctx.versions.getActiveVersion()).toBe('9');
    const onV9 = (await api.post('/api/sessions').send({})).body.session.id;
    expect((await api.get(`/api/sessions/${onV9}`)).body.session.funnelVersion).toBe('9');
    expect((await api.get(`/api/sessions/${onV1}`)).body.session.funnelVersion).toBe('1');

    // v9-only event works for the v9 session and is rejected for the v1 session
    const r = await api
      .post('/api/events')
      .send([ev(onV9, 'recommendation_expanded', 'result'), ev(onV1, 'recommendation_expanded', 'result'), ev(onV1, 'session_started')])
      .expect(207);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['accepted', 'rejected', 'accepted']);

    await api.post('/api/admin/rollback').send({}).expect(200);
    expect(ctx.versions.getActiveVersion()).toBe('1');
    list = ctx.versions.list();
    expect(list.find((v) => v.version === '9')?.status).toBe('published'); // it was published once; just not active
    expect(list.find((v) => v.version === '9')?.isActive).toBe(false);

    // sessions started on v9 continue on v9 after the rollback; new sessions are on v1
    expect((await api.get(`/api/sessions/${onV9}`)).body.session.funnelVersion).toBe('9');
    await api.post('/api/events').send([ev(onV9, 'recommendation_expanded', 'result')]).expect(200);
    expect((await api.post('/api/sessions').send({})).body.session.funnelVersion).toBe('1');

    // analytics still sees both versions
    const analytics = await api.get('/api/analytics').expect(200);
    expect(analytics.body.versions).toEqual(['1', '9']);

    const log = ctx.versions.log();
    expect(log[0]).toMatchObject({ action: 'rollback', fromVersion: '9', toVersion: '1' });
    expect(log[1]).toMatchObject({ action: 'publish', fromVersion: '1', toVersion: '9' });
  });

  it('refuses duplicates, unknown versions and invalid configs', async () => {
    await api.post('/api/admin/versions').send(v1raw).expect(409);
    await api.post('/api/admin/versions/404/publish').expect(404);
    await api.post('/api/admin/versions/1/publish').expect(409); // already active
    const broken = { ...makeV9(), defaultResultId: 'nope' };
    const res = await api.post('/api/admin/versions').send(broken).expect(400);
    expect(res.body.error).toBe('Validation failed');
    // nothing to roll back to on a fresh system with a single publish
    const fresh = createApp({ dbFile: ':memory:' });
    fresh.versions.create(v1raw);
    fresh.versions.publish('1');
    expect(() => fresh.versions.rollback()).toThrow(/Nothing to roll back/);
  });
});

describe('analytics', () => {
  async function walk(variant: 'A' | 'B', stepsViewed: string[], opts: { result?: boolean; cta?: boolean; campaign?: string; dupes?: boolean; shuffle?: boolean } = {}) {
    const s = (await api.post(`/api/sessions?variant=${variant}`).send({ utm: { utm_campaign: opts.campaign ?? 'c1' } })).body.session.id;
    let events = [ev(s, 'session_started')];
    for (const st of stepsViewed) {
      events.push(ev(s, 'step_viewed', st));
      // viewing the same step twice (back navigation) must not inflate numbers
      events.push(ev(s, 'step_viewed', st));
      events.push(ev(s, 'back_clicked', st));
      events.push(ev(s, 'step_completed', st));
    }
    if (opts.result) events.push(ev(s, 'step_viewed', 'result'), ev(s, 'result_viewed', 'result'));
    if (opts.cta) events.push(ev(s, 'cta_clicked', 'result'));
    if (opts.dupes) events = [...events, ...events];
    if (opts.shuffle) events.reverse();
    await api.post('/api/events').send(events);
    return s;
  }

  it('counts unique sessions per step, drop-off, completion and CTR; respects filters', async () => {
    // A order: intro, team_size, work_mode, priorities, timezone_span, office_days, async_maturity, tool_count, result
    const fullA = ['intro', 'team_size', 'work_mode', 'priorities', 'timezone_span', 'async_maturity', 'tool_count']; // remote → no office_days
    await walk('A', ['intro', 'team_size', 'work_mode'], { dupes: true, shuffle: true }); // dropped at work_mode
    await walk('A', fullA, { result: true, cta: true });
    await walk('A', fullA, { result: true, campaign: 'c2' });
    await walk('A', ['intro'], { shuffle: true }); // dropped at intro
    // B order: intro, work_mode, timezone_span, team_size, async_maturity, priorities, office_days, tool_count, result
    await walk('B', ['intro', 'work_mode', 'timezone_span', 'team_size', 'async_maturity', 'priorities', 'tool_count'], { result: true, cta: true, dupes: true });
    await walk('B', ['intro', 'work_mode'], { campaign: 'c2' });

    const all = (await api.get('/api/analytics').expect(200)).body;
    expect(all.overview.started).toBe(6);
    expect(all.overview.reachedResult).toBe(3);
    expect(all.overview.ctaClicked).toBe(2);
    expect(all.overview.ctaCtr).toBeCloseTo(2 / 3);
    expect(all.overview.completionRate).toBeCloseTo(0.5);
    expect(all.overview.duplicateProtectedEvents).toBeGreaterThan(0);

    const a = all.segments.find((s: { variant: string }) => s.variant === 'A');
    expect(a.started).toBe(4);
    const step = (id: string) => a.steps.find((s: { stepId: string }) => s.stepId === id);
    expect(step('intro')).toMatchObject({ viewed: 4, completed: 4, droppedHere: 1, title: 'Build a work model your team can actually follow' });
    expect(step('team_size')).toMatchObject({ viewed: 3, droppedHere: 0, conversionFromPrev: 0.75 });
    expect(step('work_mode')).toMatchObject({ viewed: 3, droppedHere: 1 });
    expect(step('priorities')).toMatchObject({ viewed: 2, conversionFromPrev: 2 / 3 });
    expect(step('office_days')).toMatchObject({ viewed: 0, droppedHere: 0, conversionFromPrev: 0 }); // hidden branch never shown
    // denominator = sessions that got past office_days' POSITION (2), not "viewed office_days" (0)
    expect(step('async_maturity')).toMatchObject({ viewed: 2, conversionFromPrev: 1 });
    expect(step('result')).toMatchObject({ viewed: 2, droppedHere: 0 });
    expect(a.reachedResult).toBe(2);
    expect(a.ctaClicked).toBe(1);
    expect(a.ctaCtr).toBe(0.5);

    const b = all.segments.find((s: { variant: string }) => s.variant === 'B');
    expect(b.steps.map((s: { stepId: string }) => s.stepId).slice(0, 3)).toEqual(['intro', 'work_mode', 'timezone_span']);
    expect(b.started).toBe(2);
    expect(b.ctaCtr).toBe(1);

    expect(all.byVariant).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variant: 'A', started: 4, reachedResult: 2, ctaClicked: 1 }),
        expect.objectContaining({ variant: 'B', started: 2, reachedResult: 1, ctaClicked: 1 }),
      ]),
    );
    expect(all.byVersion).toEqual([expect.objectContaining({ version: '1', started: 6 })]);

    const c2 = (await api.get('/api/analytics?utm_campaign=c2').expect(200)).body;
    expect(c2.overview.started).toBe(2);
    expect(c2.overview.reachedResult).toBe(1);
    expect(c2.overview.ctaClicked).toBe(0);

    const onlyB = (await api.get('/api/analytics?variant=B').expect(200)).body;
    expect(onlyB.overview.started).toBe(2);
    expect(onlyB.segments).toHaveLength(1);
  });
});
