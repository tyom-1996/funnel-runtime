/**
 * Synthetic traffic generator.
 *
 *   npm run seed                      # 120 sessions against http://localhost:3000
 *   npm run seed -- --sessions 300 --base https://my-host --seed 7
 *
 * Everything goes through the public HTTP API exactly like the browser does,
 * so the run doubles as an end-to-end check of session pinning, A/B assignment
 * and event deduplication. At the end it prints the numbers it EXPECTS the
 * dashboard to show (computed locally from what was generated) and compares
 * them with GET /api/analytics.
 */
import { randomUUID } from 'node:crypto';
import {
  evaluateResult,
  getVisibleSteps,
  visiblePosition,
  type AnalyticsResponse,
  type Answers,
  type EventsBatchResponse,
  type SessionResponse,
  type Step,
} from '@funnel/shared';

interface Args {
  base: string;
  sessions: number;
  seed: number;
  token?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { base: process.env.BASE_URL ?? 'http://localhost:3000', sessions: 120, seed: Date.now() % 100000, token: process.env.ADMIN_TOKEN };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--base' && v) args.base = v, i++;
    else if (a === '--sessions' && v) args.sessions = Number(v), i++;
    else if (a === '--seed' && v) args.seed = Number(v), i++;
    else if (a === '--token' && v) args.token = v, i++;
  }
  return args;
}

/** Small deterministic PRNG (mulberry32) so a run can be reproduced with --seed. */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const CAMPAIGNS = ['spring_launch', 'retargeting', 'newsletter', 'partner_blog', null];
const SOURCES = ['google', 'linkedin', 'newsletter', 'direct'];

interface Event {
  event_id: string;
  session_id: string;
  event_type: string;
  step_id?: string;
  client_timestamp: string;
  properties?: Record<string, unknown>;
}

interface Expectation {
  version: string;
  variant: string;
  campaign: string | null;
  viewed: Set<string>;
  reachedResult: boolean;
  cta: boolean;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const random = rng(args.seed);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(random() * arr.length)]!;
  const chance = (p: number) => random() < p;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (args.token) headers['x-admin-token'] = args.token;

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${args.base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok && res.status !== 207) throw new Error(`${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

  const health = (await (await fetch(`${args.base}/api/health`)).json()) as { activeVersion: string | null };
  if (!health.activeVersion) throw new Error('No active version on the server — publish one first.');
  console.log(`→ ${args.base} · active version ${health.activeVersion} · ${args.sessions} sessions · seed ${args.seed}\n`);

  const expectations: Expectation[] = [];
  let sent = 0;
  let accepted = 0;
  let duplicate = 0;
  let rejected = 0;
  let intentionalResends = 0;
  let shuffledBatches = 0;
  let overrides = 0;
  let startedAt = Date.now();

  for (let i = 0; i < args.sessions; i++) {
    // ~30% of sessions use the override param to make sure both variants are well represented
    const override = chance(0.3) ? pick(['A', 'B'] as const) : null;
    if (override) overrides++;
    const campaign = pick(CAMPAIGNS);
    const utm = {
      utm_source: pick(SOURCES),
      utm_medium: pick(['cpc', 'email', 'social', 'referral']),
      ...(campaign ? { utm_campaign: campaign } : {}),
    };
    const created = await post<SessionResponse>(`/api/sessions${override ? `?variant=${override}` : ''}`, { utm });
    const { session, funnel } = created;
    if (override && session.variant !== override) throw new Error(`override ignored: wanted ${override}, got ${session.variant}`);

    // `funnel` is already resolved for the session's version + variant by the
    // server; the generator walks it with the same shared engine as the browser
    const sid = session.id;
    let ts = Date.now() - Math.floor(random() * 3 * 24 * 3600 * 1000);
    const tick = () => new Date((ts += 1000 + Math.floor(random() * 20000))).toISOString();
    const ev = (type: string, step?: string, properties?: Record<string, unknown>): Event => ({
      event_id: randomUUID(),
      session_id: sid,
      event_type: type,
      step_id: step,
      client_timestamp: tick(),
      properties,
    });

    const events: Event[] = [ev('session_started')];
    const viewed = (stepId: string, a: Answers) => {
      const pos = visiblePosition(funnel, a, stepId);
      const st = funnel.steps.find((s) => s.id === stepId)!;
      return ev('step_viewed', stepId, { step_type: st.type, visible_step_index: pos.index, visible_step_count: pos.count });
    };
    const exp: Expectation = { version: session.funnelVersion, variant: session.variant, campaign, viewed: new Set(), reachedResult: false, cta: false };
    const answers: Answers = {};

    // decide where this session gives up (drop-off); ~62% finish
    const dropAfterSteps = chance(0.62) ? Infinity : 1 + Math.floor(random() * 5);

    let visible = getVisibleSteps(funnel, answers);
    let idx = 0;
    let completedSteps = 0;
    while (idx < visible.length) {
      const step = visible[idx]!;
      events.push(viewed(step.id, answers));
      exp.viewed.add(step.id);

      if (step.type === 'result') {
        const result = evaluateResult(funnel, answers);
        events.push(ev('result_viewed', step.id, { result_id: result.id }));
        exp.reachedResult = true;
        if (chance(session.variant === 'B' ? 0.55 : 0.4)) {
          events.push(ev('cta_clicked', step.id, { result_id: result.id, action: result.cta.action ?? null }));
          exp.cta = true;
          // the CTA expands the recommendation → v3 emits recommendation_expanded
          if (funnel.allowedEvents.includes('recommendation_expanded') && result.cta.action === 'expand_recommendation') {
            events.push(ev('recommendation_expanded', step.id, { result_id: result.id, action: result.cta.action, source: 'cta' }));
          }
        }
        break;
      }

      if (completedSteps >= dropAfterSteps) break; // user leaves on this step

      if (step.type !== 'info') {
        // occasionally go back one step and re-view it (must not inflate unique counts)
        if (idx > 0 && chance(0.15)) {
          const prev = visible[idx - 1]!;
          events.push(ev('back_clicked', step.id, { destination_step_id: prev.id }));
          events.push(viewed(prev.id, answers));
          events.push(viewed(step.id, answers));
        }
        answers[step.id] = randomAnswer(step, random);
        events.push(ev('answer_submitted', step.id, { answer_kind: step.type }));
      }
      // persist like the browser does (validates the answer server-side)
      visible = getVisibleSteps(funnel, answers);
      const next = visible[visible.findIndex((s) => s.id === step.id) + 1];
      events.push(ev('step_completed', step.id, { next_step_id: next?.id ?? null }));
      completedSteps++;
      await patch(args.base, headers, sid, { answers: { [step.id]: answers[step.id] }, currentStepId: next?.id ?? step.id });
      idx = visible.findIndex((s) => s.id === step.id) + 1;
    }

    // --- delivery quirks ---------------------------------------------------
    // 1. split into batches of random size
    const batches: Event[][] = [];
    for (let k = 0; k < events.length; ) {
      const size = 1 + Math.floor(random() * 6);
      batches.push(events.slice(k, k + size));
      k += size;
    }
    // 2. some batches arrive out of order (events reversed inside, batches swapped)
    if (chance(0.25)) {
      shuffledBatches++;
      batches.reverse();
      for (const b of batches) b.reverse();
    }
    // 3. some events are duplicated inside a batch
    if (chance(0.3)) {
      const b = pick(batches);
      b.push({ ...pick(b) });
    }
    for (const batch of batches) {
      const res = await post<EventsBatchResponse>('/api/events', batch);
      sent += batch.length;
      accepted += res.summary.accepted;
      duplicate += res.summary.duplicate;
      rejected += res.summary.rejected;
      // 4. simulate a client timeout → the same batch is sent again
      if (chance(0.2)) {
        intentionalResends++;
        const again = await post<EventsBatchResponse>('/api/events', batch);
        sent += batch.length;
        accepted += again.summary.accepted;
        duplicate += again.summary.duplicate;
        rejected += again.summary.rejected;
        if (again.summary.accepted !== 0) throw new Error('Dedup failed: resent batch produced new rows');
      }
    }
    expectations.push(exp);
    if ((i + 1) % 20 === 0) process.stdout.write(`  ${i + 1}/${args.sessions} sessions\n`);
  }

  console.log(`\nDone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`events sent: ${sent}  accepted: ${accepted}  duplicate: ${duplicate}  rejected: ${rejected}`);
  console.log(`override sessions: ${overrides}  shuffled sessions: ${shuffledBatches}  resent batches: ${intentionalResends}`);
  if (rejected > 0) console.log('⚠ some events were rejected — check the server log');

  // --- expected vs actual --------------------------------------------------
  const expected = summarize(expectations);
  console.log('\nExpected dashboard numbers (unique sessions):');
  printTable(expected);

  const res = await fetch(`${args.base}/api/analytics`, { headers });
  if (!res.ok) {
    console.log(`\n(could not fetch /api/analytics: ${res.status} — set --token if ADMIN_TOKEN is configured)`);
    return;
  }
  const actual = (await res.json()) as AnalyticsResponse;
  const totalExpected = expectations.length;
  const startedActual = actual.overview.started;
  console.log(`\nDashboard reports ${startedActual} started sessions in total (this run generated ${totalExpected}; earlier runs add to the total).`);

  let mismatches = 0;
  for (const row of expected) {
    const seg = actual.segments.find((s) => s.version === row.version && s.variant === row.variant);
    if (!seg) {
      console.log(`  ✗ segment ${row.version}/${row.variant} missing in dashboard`);
      mismatches++;
      continue;
    }
    // we can only assert >= because the database may contain sessions from previous runs
    const ok = seg.started >= row.started && seg.reachedResult >= row.reachedResult && seg.ctaClicked >= row.ctaClicked;
    console.log(`  ${ok ? '✓' : '✗'} ${row.version}/${row.variant}: dashboard started=${seg.started} result=${seg.reachedResult} cta=${seg.ctaClicked}`);
    if (!ok) mismatches++;
  }
  if (startedActual === totalExpected) {
    const exact = expected.every((row) => {
      const seg = actual.segments.find((s) => s.version === row.version && s.variant === row.variant);
      return seg && seg.started === row.started && seg.reachedResult === row.reachedResult && seg.ctaClicked === row.ctaClicked;
    });
    console.log(exact ? '\n✓ fresh database: dashboard matches the generated traffic exactly' : '\n✗ numbers differ from what was generated');
    if (!exact) process.exitCode = 1;
  }
  if (mismatches) process.exitCode = 1;
}

async function patch(base: string, headers: Record<string, string>, sid: string, body: unknown) {
  const res = await fetch(`${base}/api/sessions/${sid}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`PATCH session → ${res.status} ${await res.text()}`);
}

function randomAnswer(step: Step, random: () => number): unknown {
  const v = step.validation ?? {};
  const input = step.input ?? {};
  const options = input.options ?? [];
  switch (step.type) {
    case 'number': {
      const min = input.min ?? 0;
      const max = input.max ?? 20;
      const span = Math.min(max, min + 40) - min; // keep numbers in a realistic range
      const stepSize = input.step ?? 1;
      const n = min + Math.round((random() * span) / stepSize) * stepSize;
      return Math.min(max, Number(n.toFixed(2)));
    }
    case 'single-select':
      return options[Math.floor(random() * options.length)]!.value;
    case 'multi-select': {
      const minSel = v.minSelections ?? 1;
      const maxSel = Math.min(v.maxSelections ?? 3, options.length);
      const count = minSel + Math.floor(random() * (maxSel - minSel + 1));
      const pool = [...options];
      const out: string[] = [];
      while (out.length < count && pool.length) {
        out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!.value);
      }
      return out;
    }
    default:
      return undefined;
  }
}

interface Row {
  version: string;
  variant: string;
  started: number;
  reachedResult: number;
  ctaClicked: number;
}

function summarize(exps: Expectation[]): Row[] {
  const map = new Map<string, Row>();
  for (const e of exps) {
    const k = `${e.version}/${e.variant}`;
    const r = map.get(k) ?? { version: e.version, variant: e.variant, started: 0, reachedResult: 0, ctaClicked: 0 };
    r.started++;
    if (e.reachedResult) r.reachedResult++;
    if (e.cta) r.ctaClicked++;
    map.set(k, r);
  }
  return [...map.values()].sort((a, b) => a.version.localeCompare(b.version) || a.variant.localeCompare(b.variant));
}

function printTable(rows: Row[]) {
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
  console.log('  version  variant  started  result  completion  cta  cta/started  cta ctr');
  for (const r of rows) {
    console.log(
      `  ${r.version.padEnd(8)} ${r.variant.padEnd(8)} ${String(r.started).padEnd(8)} ${String(r.reachedResult).padEnd(7)} ${pct(r.reachedResult, r.started).padEnd(11)} ${String(r.ctaClicked).padEnd(4)} ${pct(r.ctaClicked, r.started).padEnd(12)} ${pct(r.ctaClicked, r.reachedResult)}`,
    );
  }
  const total = rows.reduce((s, r) => s + r.started, 0);
  const result = rows.reduce((s, r) => s + r.reachedResult, 0);
  const cta = rows.reduce((s, r) => s + r.ctaClicked, 0);
  console.log(`  total             ${String(total).padEnd(8)} ${String(result).padEnd(7)} ${pct(result, total).padEnd(11)} ${String(cta).padEnd(4)} ${pct(cta, total).padEnd(12)} ${pct(cta, result)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
