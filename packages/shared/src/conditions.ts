import type { Condition } from './schema.js';

export type Answers = Record<string, unknown>;

/**
 * Condition engine shared by `visibleWhen` and `resultRules`.
 *
 * Leaf:        { "answer": "work_mode", "operator": "in", "value": ["hybrid", "office"] }
 * Combinators: { "all": [...] }, { "any": [...] }, { "not": {...} }
 *
 * Semantics (a missing answer never matches, except `neq`):
 *  - eq / neq      : strict equality on primitives
 *  - in            : answer is one of value[] (array answer: any element is in value[])
 *  - contains      : array answer contains value (string answer: includes substring)
 *  - gte/gt/lte/lt : numeric comparison; non-numeric answers never match
 *  - all([]) = true, any([]) = false
 */
export function evaluateCondition(cond: Condition, answers: Answers): boolean {
  if ('all' in cond) return cond.all.every((c) => evaluateCondition(c, answers));
  if ('any' in cond) return cond.any.some((c) => evaluateCondition(c, answers));
  if ('not' in cond) return !evaluateCondition(cond.not, answers);
  return evaluateLeaf(cond.operator, answers[cond.answer], cond.value);
}

function evaluateLeaf(op: string, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return actual !== undefined && actual !== null && actual === expected;
    case 'neq':
      return actual !== expected;
    case 'in': {
      if (!Array.isArray(expected)) return false;
      if (actual === undefined || actual === null) return false;
      if (Array.isArray(actual)) return actual.some((a) => expected.includes(a));
      return expected.includes(actual);
    }
    case 'contains': {
      if (Array.isArray(actual)) return actual.includes(expected);
      if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected);
      return false;
    }
    case 'gte':
    case 'gt':
    case 'lte':
    case 'lt': {
      const a = toNumber(actual);
      const b = toNumber(expected);
      if (a === null || b === null) return false;
      if (op === 'gte') return a >= b;
      if (op === 'gt') return a > b;
      if (op === 'lte') return a <= b;
      return a < b;
    }
    default:
      return false;
  }
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}
