import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseFunnelConfig,
  resolveFunnel,
  getVisibleSteps,
  pruneAnswers,
  computeProgress,
  evaluateResult,
  evaluateCondition,
  validateAnswer,
  pickVariant,
  versionKey,
  allowedEventNames,
} from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const v1 = parseFunnelConfig(JSON.parse(readFileSync(path.join(here, '../../../configs/funnel-v1.json'), 'utf8')));

describe('condition engine', () => {
  it('supports eq / in / contains / gte', () => {
    const a = { work_mode: 'hybrid', priorities: ['speed', 'compliance'], team_size: 20 };
    expect(evaluateCondition({ answer: 'work_mode', operator: 'eq', value: 'hybrid' }, a)).toBe(true);
    expect(evaluateCondition({ answer: 'work_mode', operator: 'eq', value: 'remote' }, a)).toBe(false);
    expect(evaluateCondition({ answer: 'work_mode', operator: 'in', value: ['hybrid', 'office'] }, a)).toBe(true);
    expect(evaluateCondition({ answer: 'priorities', operator: 'contains', value: 'compliance' }, a)).toBe(true);
    expect(evaluateCondition({ answer: 'priorities', operator: 'contains', value: 'cost' }, a)).toBe(false);
    expect(evaluateCondition({ answer: 'team_size', operator: 'gte', value: 20 }, a)).toBe(true);
    expect(evaluateCondition({ answer: 'team_size', operator: 'gte', value: 21 }, a)).toBe(false);
  });

  it('missing answers never match', () => {
    expect(evaluateCondition({ answer: 'x', operator: 'eq', value: undefined }, {})).toBe(false);
    expect(evaluateCondition({ answer: 'x', operator: 'gte', value: 0 }, {})).toBe(false);
    expect(evaluateCondition({ answer: 'x', operator: 'contains', value: 'a' }, {})).toBe(false);
    expect(evaluateCondition({ answer: 'x', operator: 'in', value: ['a'] }, {})).toBe(false);
  });

  it('nests all/any (the async_native rule from v1)', () => {
    const rule = v1.resultRules.find((r) => r.resultId === 'async_native')!.when;
    expect(evaluateCondition(rule, { work_mode: 'remote', timezone_span: 'global' })).toBe(true);
    expect(evaluateCondition(rule, { work_mode: 'remote', timezone_span: 'same' })).toBe(false);
    expect(evaluateCondition(rule, { work_mode: 'office', async_maturity: 'high' })).toBe(true);
    expect(evaluateCondition(rule, {})).toBe(false);
  });
});

describe('config parsing', () => {
  it('reads the official format: numeric version, keyed steps/results/variants, event objects', () => {
    expect(v1.version).toBe(1);
    expect(versionKey(v1)).toBe('1');
    expect(Object.keys(v1.steps)).toHaveLength(9);
    expect(Object.keys(v1.experiment.variants)).toEqual(['A', 'B']);
    expect(allowedEventNames(v1)).toEqual(['session_started', 'step_viewed', 'answer_submitted', 'step_completed', 'back_clicked', 'result_viewed', 'cta_clicked']);
    expect(v1.events.privacy.storeRawAnswers).toBe(false);
    expect(v1.session.ttlHours).toBe(72);
  });

  it('rejects dangling references and key/id mismatches', () => {
    const broken = JSON.parse(JSON.stringify(v1));
    broken.defaultResultId = 'nope';
    expect(() => parseFunnelConfig(broken)).toThrow(/Unknown result/);
    const mismatch = JSON.parse(JSON.stringify(v1));
    mismatch.steps.team_size.id = 'other';
    expect(() => parseFunnelConfig(mismatch)).toThrow(/does not match/);
    const badSeq = JSON.parse(JSON.stringify(v1));
    badSeq.experiment.variants.A.stepSequence.push('ghost');
    expect(() => parseFunnelConfig(badSeq)).toThrow(/Unknown step/);
  });
});

describe('variant resolution', () => {
  it('applies step order, content and result overrides', () => {
    const a = resolveFunnel(v1, 'A');
    const b = resolveFunnel(v1, 'B');
    expect(a.steps.map((s) => s.id)).toEqual(['intro', 'team_size', 'work_mode', 'priorities', 'timezone_span', 'office_days', 'async_maturity', 'tool_count', 'result']);
    expect(b.steps.map((s) => s.id)).toEqual(['intro', 'work_mode', 'timezone_span', 'team_size', 'async_maturity', 'priorities', 'office_days', 'tool_count', 'result']);
    expect(b.steps[0]!.content.title).toBe('How should your team really work?');
    expect(b.steps[0]!.content.primaryActionLabel).toBe('Show me');
    expect(b.steps[0]!.type).toBe('info');
    // override of `content.title` keeps the base helperText (deep merge)
    const prioB = b.steps.find((s) => s.id === 'priorities')!;
    expect(prioB.content.title).toBe('What would make the biggest difference right now?');
    expect(prioB.input?.options).toHaveLength(5);
    // result overrides: new title + cta label, summary/recommendations preserved
    const asyncB = b.results.find((r) => r.id === 'async_native')!;
    const asyncA = a.results.find((r) => r.id === 'async_native')!;
    expect(asyncB.title).toBe('Your team is ready to reduce meetings');
    expect(asyncB.cta.label).toBe('See the 30-day action list');
    expect(asyncB.cta.action).toBe('expand_recommendation');
    expect(asyncB.summary).toBe(asyncA.summary);
    expect(asyncA.cta.label).toBe('View the action list');
  });

  it('pickVariant respects weights', () => {
    expect(pickVariant(v1, () => 0.1)).toBe('A');
    expect(pickVariant(v1, () => 0.9)).toBe('B');
  });
});

describe('visibility, pruning and progress', () => {
  const a = resolveFunnel(v1, 'A');

  it('hides office_days for remote and shows it for hybrid/office', () => {
    expect(getVisibleSteps(a, { work_mode: 'remote' }).map((s) => s.id)).not.toContain('office_days');
    expect(getVisibleSteps(a, { work_mode: 'hybrid' }).map((s) => s.id)).toContain('office_days');
    expect(getVisibleSteps(a, { work_mode: 'office' }).map((s) => s.id)).toContain('office_days');
    expect(getVisibleSteps(a, {}).map((s) => s.id)).not.toContain('office_days');
  });

  it('stale answer of a hidden step is ignored (answered office_days, then switched to remote)', () => {
    const answers = { team_size: 10, work_mode: 'remote', office_days: 5, priorities: ['speed'], timezone_span: 'same', async_maturity: 'low', tool_count: 3 };
    expect(pruneAnswers(a, answers)).not.toHaveProperty('office_days');
    expect(evaluateResult(a, answers).id).toBe('balanced'); // not hybrid/office, not async-native
    const progress = computeProgress(a, answers, 'tool_count');
    expect(progress.total).toBe(6); // team_size, work_mode, priorities, timezone_span, async_maturity, tool_count
    expect(progress.current).toBe(6);
  });

  it('progress excludes info/result and counts only visible steps', () => {
    expect(computeProgress(a, {}, 'intro')).toEqual({ current: 0, total: 6, ratio: 0 });
    expect(computeProgress(a, { work_mode: 'hybrid' }, 'office_days')).toMatchObject({ current: 5, total: 7 });
    expect(computeProgress(a, { work_mode: 'hybrid' }, 'result')).toMatchObject({ current: 7, total: 7, ratio: 1 });
  });
});

describe('validation', () => {
  const a = resolveFunnel(v1, 'A');
  const step = (id: string) => a.steps.find((s) => s.id === id)!;

  it('uses bounds from input and messages from config', () => {
    expect(validateAnswer(step('team_size'), undefined)?.message).toBe('Enter the team size.');
    expect(validateAnswer(step('team_size'), 0)?.message).toBe('The team must have at least one person.');
    expect(validateAnswer(step('team_size'), 201)?.message).toBe('For this demo, enter a value up to 200.');
    expect(validateAnswer(step('team_size'), 2.5)?.rule).toBe('step');
    expect(validateAnswer(step('team_size'), 12)).toBeNull();
    expect(validateAnswer(step('office_days'), 0)).toBeNull(); // min is 0 in the official config
    expect(validateAnswer(step('office_days'), 6)?.message).toBe('Enter a value from 0 to 5.');
  });

  it('checks selections', () => {
    expect(validateAnswer(step('priorities'), [])?.rule).toBe('required');
    expect(validateAnswer(step('priorities'), ['speed', 'cost', 'focus', 'culture'])?.message).toBe('Choose no more than three priorities.');
    expect(validateAnswer(step('priorities'), ['nope'])?.rule).toBe('option');
    expect(validateAnswer(step('priorities'), ['speed'])).toBeNull();
    expect(validateAnswer(step('work_mode'), 'remote')).toBeNull();
    expect(validateAnswer(step('work_mode'), 'moon')?.rule).toBe('option');
    expect(validateAnswer(step('work_mode'), undefined)?.message).toBe("Select the team's main work mode.");
  });
});

describe('result rules', () => {
  const a = resolveFunnel(v1, 'A');
  it('first matching rule wins, otherwise default', () => {
    expect(evaluateResult(a, { work_mode: 'remote', timezone_span: 'wide' }).id).toBe('async_native');
    expect(evaluateResult(a, { work_mode: 'hybrid', office_days: 2, async_maturity: 'high' }).id).toBe('async_native'); // any-branch
    expect(evaluateResult(a, { work_mode: 'hybrid', office_days: 2, async_maturity: 'low' }).id).toBe('hybrid_structured');
    expect(evaluateResult(a, { work_mode: 'office', office_days: 5 }).id).toBe('office_core');
    expect(evaluateResult(a, { work_mode: 'remote', timezone_span: 'same', async_maturity: 'medium' }).id).toBe('balanced');
    expect(evaluateResult(a, {}).id).toBe('balanced');
  });
});
