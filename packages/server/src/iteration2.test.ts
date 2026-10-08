/**
 * Iteration 2 — funnel-v3.json
 *
 * Mirrors the manual verification scenario from the task:
 *   sessions on v1 → publish v3 → old sessions finish on v1, new ones run on v3
 *   → roll back to v1 → sessions started on v3 keep working on v3
 *   → analytics for both versions is intact, no schema change needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveFunnel, getVisibleSteps, evaluateResult, parseFunnelConfig, computeProgress } from '@funnel/shared';
import { createApp, type AppContext } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => JSON.parse(readFileSync(path.join(here, '../../../configs', f), 'utf8'));
const v1raw = read('funnel-v1.json');
const v3raw = read('funnel-v3.json');
const v3 = parseFunnelConfig(v3raw);

let ctx: AppContext;
let api: ReturnType<typeof request>;

beforeEach(() => {
  let i = 0;
  ctx = createApp({ dbFile: ':memory:', random: () => (i++ % 2 === 0 ? 0.1 : 0.9) });
  ctx.versions.create(v1raw);
  ctx.versions.publish('v1');
  api = request(ctx.app);
});

const ev = (session_id: string, event_type: string, step_id?: string) => ({
  event_id: randomUUID(),
  session_id,
  event_type,
  step_id,
  client_timestamp: new Date().toISOString(),
});

describe('funnel-v3 config', () => {
  it('is a draft with a non-sequential version and a new experiment id', () => {
    expect(v3.version).toBe('v3');
    expect(v3raw.status).toBe('draft');
    expect(v3.experiment.id).not.toBe(parseFunnelConfig(v1raw).experiment.id);
    expect(v3.events.allowed).toContain('recommendation_expanded');
  });

  it('shows security_constraints only when compliance is among priorities', () => {
    const a = resolveFunnel(v3, 'A');
    expect(getVisibleSteps(a, { priorities: ['speed'] }).map((s) => s.id)).not.toContain('security_constraints');
    expect(getVisibleSteps(a, { priorities: ['speed', 'compliance'] }).map((s) => s.id)).toContain('security_constraints');
    // progress reflects the extra step
    expect(computeProgress(a, { work_mode: 'remote', priorities: ['speed'] }, 'team_size').total).toBe(5);
    expect(computeProgress(a, { work_mode: 'remote', priorities: ['compliance'] }, 'team_size').total).toBe(6);
  });

  it('removes tool_count for variant B but keeps it for A; rules referencing it still evaluate safely', () => {
    const a = resolveFunnel(v3, 'A');
    const b = resolveFunnel(v3, 'B');
    expect(a.steps.map((s) => s.id)).toContain('tool_count');
    expect(b.steps.map((s) => s.id)).not.toContain('tool_count');
    // for B the remote-many-tools rule can never fire (no answer), remote rule does
    expect(evaluateResult(b, { work_mode: 'remote', priorities: ['speed'], meeting_hours: 3, team_size: 5 }).id).toBe('remote_async');
    expect(evaluateResult(a, { work_mode: 'remote', priorities: ['speed'], meeting_hours: 3, team_size: 5, tool_count: 10 }).id).toBe('remote_tool_sprawl');
  });

  it('new results win in rule order', () => {
    const a = resolveFunnel(v3, 'A');
    expect(evaluateResult(a, { work_mode: 'remote', priorities: ['compliance'], team_size: 25, meeting_hours: 20 }).id).toBe('regulated_scale');
    expect(evaluateResult(a, { work_mode: 'remote', priorities: ['speed'], team_size: 25, meeting_hours: 20 }).id).toBe('meeting_heavy');
    expect(evaluateResult(a, { work_mode: 'hybrid', office_days: 2, priorities: ['compliance'], team_size: 5, meeting_hours: 2 }).id).toBe('compliance_focus');
  });
});

describe('publish v3 → verify → roll back', () => {
  it('keeps old sessions on v1, runs new ones on v3, survives the rollback and keeps analytics for both', async () => {
    // --- sessions on v1 ---
    const oldA = (await api.post('/api/sessions?variant=A').send({ utm: { utm_campaign: 'before' } })).body.session.id;
    const oldB = (await api.post('/api/sessions?variant=B').send({ utm: { utm_campaign: 'before' } })).body.session.id;
    await api.post('/api/events').send([ev(oldA, 'session_started'), ev(oldA, 'step_viewed', 'intro'), ev(oldB, 'session_started'), ev(oldB, 'step_viewed', 'intro')]).expect(200);

    // --- upload v3 through the admin API as a draft, then publish ---
    const uploaded = await api.post('/api/admin/versions').send(v3raw).expect(201);
    expect(uploaded.body).toMatchObject({ version: 'v3', status: 'draft', isActive: false });
    await api.post('/api/admin/versions/v3/publish').expect(200);
    expect((await api.get('/api/health')).body.activeVersion).toBe('v3');

    // --- old sessions continue on v1 and can finish ---
    const oldAgain = await api.get(`/api/sessions/${oldA}`).expect(200);
    expect(oldAgain.body.funnel.version).toBe('v1');
    expect(oldAgain.body.funnel.steps.map((s: { id: string }) => s.id)).not.toContain('security_constraints');
    await api
      .patch(`/api/sessions/${oldA}`)
      .send({ answers: { team_size: 4, work_mode: 'remote', priorities: ['speed'], tool_count: 2 }, currentStepId: 'result' })
      .expect(200);
    await api.patch(`/api/sessions/${oldA}`).send({ answers: { meeting_hours: 3 } }).expect(400); // not a v1 step
    const finishOld = await api
      .post('/api/events')
      .send([ev(oldA, 'result_viewed', 'result'), ev(oldA, 'cta_clicked', 'result'), ev(oldA, 'recommendation_expanded', 'result')])
      .expect(207);
    expect(finishOld.body.results.map((r: { status: string }) => r.status)).toEqual(['accepted', 'accepted', 'rejected']);

    // --- new sessions run on v3 with the new branch / event ---
    const newB = (await api.post('/api/sessions?variant=B').send({ utm: { utm_campaign: 'after' } })).body;
    expect(newB.session.funnelVersion).toBe('v3');
    expect(newB.funnel.steps.map((s: { id: string }) => s.id)).not.toContain('tool_count');
    const newA = (await api.post('/api/sessions?variant=A').send({ utm: { utm_campaign: 'after' } })).body;
    expect(newA.funnel.steps.map((s: { id: string }) => s.id)).toContain('tool_count');

    const withCompliance = await api
      .patch(`/api/sessions/${newB.session.id}`)
      .send({ answers: { work_mode: 'office', office_days: 5, team_size: 30, priorities: ['compliance'], security_constraints: ['sso'], meeting_hours: 4 } })
      .expect(200);
    expect(withCompliance.body.session.answers.security_constraints).toEqual(['sso']);
    const fresh = await api
      .post('/api/events')
      .send([
        ev(newB.session.id, 'session_started'),
        ev(newB.session.id, 'step_viewed', 'security_constraints'),
        ev(newB.session.id, 'result_viewed', 'result'),
        ev(newB.session.id, 'recommendation_expanded', 'result'),
        ev(newA.session.id, 'session_started'),
        ev(newA.session.id, 'step_viewed', 'tool_count'),
      ])
      .expect(200);
    expect(fresh.body.summary).toEqual({ accepted: 6, duplicate: 0, rejected: 0 });

    // --- roll back to v1 ---
    const rb = await api.post('/api/admin/rollback').send({}).expect(200);
    expect(rb.body.version).toBe('v1');
    expect(rb.body.isActive).toBe(true);
    expect((await api.post('/api/sessions').send({})).body.session.funnelVersion).toBe('v1');

    // sessions started on v3 keep working on v3, including the v3-only event
    const stillV3 = await api.get(`/api/sessions/${newB.session.id}`).expect(200);
    expect(stillV3.body.funnel.version).toBe('v3');
    expect(stillV3.body.session.answers.security_constraints).toEqual(['sso']);
    await api.post('/api/events').send([ev(newB.session.id, 'cta_clicked', 'result')]).expect(200);

    // --- analytics across both versions, no schema change ---
    const all = (await api.get('/api/analytics').expect(200)).body;
    expect(all.versions).toEqual(['v1', 'v3']);
    expect(all.byVersion).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: 'v1', started: 2, reachedResult: 1, ctaClicked: 1 }),
        expect.objectContaining({ version: 'v3', started: 2, reachedResult: 1, ctaClicked: 1 }),
      ]),
    );
    const v3B = all.segments.find((s: { version: string; variant: string }) => s.version === 'v3' && s.variant === 'B');
    expect(v3B.steps.map((s: { stepId: string }) => s.stepId)).not.toContain('tool_count');
    expect(v3B.steps.find((s: { stepId: string }) => s.stepId === 'security_constraints').viewed).toBe(1);
    const v3A = all.segments.find((s: { version: string; variant: string }) => s.version === 'v3' && s.variant === 'A');
    expect(v3A.steps.find((s: { stepId: string }) => s.stepId === 'tool_count').viewed).toBe(1);

    const after = (await api.get('/api/analytics?utm_campaign=after').expect(200)).body;
    expect(after.overview.started).toBe(2);

    const versions = ctx.versions.list();
    expect(versions.map((v) => [v.version, v.status, v.isActive])).toEqual([
      ['v1', 'published', true],
      ['v3', 'published', false],
    ]);
    expect(ctx.versions.log().map((l) => l.action)).toEqual(['rollback', 'publish', 'publish']);
  });

  it('bootstrap loads v3 from configs/ as a draft without activating it', () => {
    const fresh = createApp({ dbFile: ':memory:', configsDir: path.join(here, '../../../configs') });
    expect(fresh.versions.getActiveVersion()).toBe('v1');
    expect(fresh.versions.summary('v3')).toMatchObject({ status: 'draft', isActive: false });
  });
});
