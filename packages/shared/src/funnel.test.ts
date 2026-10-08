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
} from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const v1 = parseFunnelConfig(JSON.parse(readFileSync(path.join(here, '../../../configs/funnel-v1.json'), 'utf8')));

describe('condition engine', () => {
  it('supports eq / in / contains / gte', () => {
    const a = { work_mode: 'hybrid', priorities: ['speed', 'compliance'], team_size: 20 };
    expect(evaluateCondition({ op: 'eq', field: 'work_mode', value: 'hybrid' }, a)).toBe(true);
    expect(evaluateCondition({ op: 'eq', field: 'work_mode', value: 'remote' }, a)).toBe(false);
    expect(evaluateCondition({ op: 'in', field: 'work_mode', value: ['hybrid', 'office'] }, a)).toBe(true);
    expect(evaluateCondition({ op: 'contains', field: 'priorities', value: 'compliance' }, a)).toBe(true);
    expect(evaluateCondition({ op: 'contains', field: 'priorities', value: 'cost' }, a)).toBe(false);
    expect(evaluateCondition({ op: 'gte', field: 'team_size', value: 20 }, a)).toBe(true);
    expect(evaluateCondition({ op: 'gte', field: 'team_size', value: 21 }, a)).toBe(false);
  });

  it('missing answers never match', () => {
    expect(evaluateCondition({ op: 'eq', field: 'x', value: undefined }, {})).toBe(false);
    expect(evaluateCondition({ op: 'gte', field: 'x', value: 0 }, {})).toBe(false);
    expect(evaluateCondition({ op: 'contains', field: 'x', value: 'a' }, {})).toBe(false);
  });

  it('nests all/any', () => {
    const cond = {
      op: 'any' as const,
      conditions: [
        { op: 'eq' as const, field: 'a', value: 1 },
        { op: 'all' as const, conditions: [{ op: 'eq' as const, field: 'b', value: 2 }, { op: 'gte' as const, field: 'c', value: 3 }] },
      ],
    };
    expect(evaluateCondition(cond, { b: 2, c: 3 })).toBe(true);
    expect(evaluateCondition(cond, { b: 2, c: 2 })).toBe(false);
    expect(evaluateCondition(cond, { a: 1 })).toBe(true);
  });
});

describe('variant resolution', () => {
  it('applies step order, text and result overrides', () => {
    const a = resolveFunnel(v1, 'A');
    const b = resolveFunnel(v1, 'B');
    expect(a.steps.map((s) => s.id)).toEqual(['intro', 'team_size', 'work_mode', 'office_days', 'priorities', 'tool_count', 'result']);
    expect(b.steps.map((s) => s.id)).toEqual(['intro', 'work_mode', 'office_days', 'team_size', 'priorities', 'tool_count', 'result']);
    expect(b.steps[0]!.title).not.toEqual(a.steps[0]!.title);
    expect(b.steps[0]!.type).toBe('info');
    expect(b.results.every((r) => r.cta.label === 'Get my 30-day plan')).toBe(true);
    expect(a.results.every((r) => r.cta.label !== 'Get my 30-day plan')).toBe(true);
    // base result url preserved by deep merge
    expect(b.results[0]!.cta.url).toBe(a.results[0]!.cta.url);
  });

  it('pickVariant respects weights', () => {
    expect(pickVariant(v1, () => 0.1).id).toBe('A');
    expect(pickVariant(v1, () => 0.9).id).toBe('B');
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
    const answers = { team_size: 10, work_mode: 'remote', office_days: 5, priorities: ['speed'], tool_count: 3 };
    const pruned = pruneAnswers(a, answers);
    expect(pruned).not.toHaveProperty('office_days');
    // office-heavy rule must not fire; remote rule wins
    expect(evaluateResult(a, answers).id).toBe('remote_async');
    const progress = computeProgress(a, answers, 'tool_count');
    expect(progress.total).toBe(4); // team_size, work_mode, priorities, tool_count
    expect(progress.current).toBe(4);
  });

  it('progress excludes info/result and counts only visible steps', () => {
    expect(computeProgress(a, {}, 'intro')).toEqual({ current: 0, total: 4, ratio: 0 });
    expect(computeProgress(a, { work_mode: 'hybrid' }, 'office_days')).toMatchObject({ current: 3, total: 5 });
    expect(computeProgress(a, { work_mode: 'hybrid' }, 'result')).toMatchObject({ current: 5, total: 5, ratio: 1 });
  });
});

describe('validation', () => {
  const a = resolveFunnel(v1, 'A');
  const step = (id: string) => a.steps.find((s) => s.id === id)!;

  it('uses messages from config', () => {
    expect(validateAnswer(step('team_size'), undefined)?.message).toBe('Please enter your team size');
    expect(validateAnswer(step('team_size'), 0)?.rule).toBe('min');
    expect(validateAnswer(step('team_size'), 501)?.rule).toBe('max');
    expect(validateAnswer(step('team_size'), 2.5)?.rule).toBe('integer');
    expect(validateAnswer(step('team_size'), 12)).toBeNull();
  });

  it('checks selections', () => {
    expect(validateAnswer(step('priorities'), [])?.rule).toBe('required');
    expect(validateAnswer(step('priorities'), ['speed', 'cost', 'quality', 'compliance'])?.rule).toBe('maxSelections');
    expect(validateAnswer(step('priorities'), ['nope'])?.rule).toBe('option');
    expect(validateAnswer(step('priorities'), ['speed'])).toBeNull();
    expect(validateAnswer(step('work_mode'), 'remote')).toBeNull();
    expect(validateAnswer(step('work_mode'), 'moon')?.rule).toBe('option');
  });
});

describe('result rules', () => {
  const a = resolveFunnel(v1, 'A');
  it('first matching rule wins, otherwise default', () => {
    expect(evaluateResult(a, { work_mode: 'remote', tool_count: 9 }).id).toBe('remote_tool_sprawl');
    expect(evaluateResult(a, { work_mode: 'remote', tool_count: 2, priorities: ['compliance'] }).id).toBe('remote_async');
    expect(evaluateResult(a, { work_mode: 'office', office_days: 5 }).id).toBe('office_first');
    expect(evaluateResult(a, { work_mode: 'hybrid', office_days: 2, priorities: ['compliance'] }).id).toBe('compliance_focus');
    expect(evaluateResult(a, { work_mode: 'hybrid', office_days: 2, priorities: ['speed'] }).id).toBe('balanced_team');
  });
});

describe('schema', () => {
  it('rejects dangling references', () => {
    const broken = JSON.parse(JSON.stringify(v1));
    broken.defaultResultId = 'nope';
    expect(() => parseFunnelConfig(broken)).toThrow(/Unknown result/);
  });
});
