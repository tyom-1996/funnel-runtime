import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  computeProgress,
  evaluateResult,
  getNextStep,
  getPrevStep,
  getVisibleSteps,
  normalizeAnswer,
  validateAnswer,
  type Answers,
  type Step,
} from '@funnel/shared';
import { api, ApiError } from '../api';
import { useSession } from './useSession';
import { tracker } from './tracker';
import { StepInput } from './StepView';
import { ResultView } from './ResultView';

export function FunnelPage() {
  const { data, loading, error, restart, setData } = useSession();

  if (loading) return <div className="page center muted">Loading…</div>;
  if (error || !data) {
    return (
      <div className="page center">
        <div className="card">
          <h2>Something went wrong</h2>
          <p className="muted">{error ?? 'No session'}</p>
          <button className="primary" onClick={() => void restart()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  return <FunnelRunner key={data.session.id} data={data} setData={setData} restart={restart} />;
}

interface RunnerProps {
  data: NonNullable<ReturnType<typeof useSession>['data']>;
  setData: (d: RunnerProps['data']) => void;
  restart: () => Promise<void>;
}

function FunnelRunner({ data, setData, restart }: RunnerProps) {
  const { funnel, session } = data;

  const [answers, setAnswers] = useState<Answers>(session.answers);
  // step id and the draft value for that step live together so a step change
  // never renders the previous step's draft in the new input
  const [position, setPosition] = useState<{ stepId: string; draft: unknown }>(() => {
    // restore position; if the stored step is no longer visible (branch changed), fall back to the first visible one
    const visible = getVisibleSteps(funnel, session.answers);
    const id = visible.find((s) => s.id === session.currentStepId)?.id ?? visible[0]!.id;
    return { stepId: id, draft: session.answers[id] };
  });
  const { stepId, draft } = position;
  const setDraft = (d: unknown) => setPosition((p) => ({ ...p, draft: d }));
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const step: Step = useMemo(() => funnel.steps.find((s) => s.id === stepId)!, [funnel, stepId]);
  const progress = useMemo(() => computeProgress(funnel, answers, stepId), [funnel, answers, stepId]);
  const result = useMemo(() => (step.type === 'result' ? evaluateResult(funnel, answers) : null), [funnel, answers, step]);
  const canExpand = funnel.allowedEvents.includes('recommendation_expanded');

  // track the view once per step change (a refresh re-tracks, which is a real repeated view)
  const lastTracked = useRef<string | null>(null);
  useEffect(() => {
    if (lastTracked.current !== stepId) {
      lastTracked.current = stepId;
      tracker.track('step_viewed', stepId, { step_type: step.type });
      if (step.type === 'result') tracker.track('result_viewed', stepId, { result_id: evaluateResult(funnel, answers).id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId]);

  const persist = useCallback(
    async (patch: { answers?: Answers; currentStepId?: string }) => {
      setSaving(true);
      setSaveError(null);
      try {
        const updated = await api.updateSession(session.id, patch);
        // server is the source of truth: it prunes answers of hidden steps
        setAnswers(updated.session.answers);
        setData(updated);
        return updated;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
          await restart();
          return null;
        }
        setSaveError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setSaving(false);
      }
    },
    [session.id, setData, restart],
  );

  const goTo = useCallback(
    async (target: Step, nextAnswers: Answers) => {
      setPosition({ stepId: target.id, draft: nextAnswers[target.id] });
      setFieldError(null);
      await persist({ answers: nextAnswers, currentStepId: target.id });
    },
    [persist],
  );

  const handleContinue = async () => {
    if (saving) return;
    let nextAnswers = answers;

    if (step.type !== 'info') {
      const value = normalizeAnswer(step, draft);
      const err = validateAnswer(step, value);
      if (err) {
        setFieldError(err.message);
        return;
      }
      nextAnswers = { ...answers, [step.id]: value };
      setAnswers(nextAnswers);
      // privacy: only the KIND of answer is sent to analytics, never the value
      tracker.track('answer_submitted', step.id, { answer_kind: step.type });
    }
    tracker.track('step_completed', step.id);

    const next = getNextStep(funnel, nextAnswers, step.id);
    if (next) await goTo(next, nextAnswers);
  };

  const handleBack = async () => {
    const prev = getPrevStep(funnel, answers, step.id);
    if (!prev || saving) return;
    tracker.track('back_clicked', step.id);
    await goTo(prev, answers);
  };

  const prevStep = getPrevStep(funnel, answers, step.id);

  return (
    <div className="page">
      <div className="card funnel-card">
        <header className="funnel-header">
          <div className="meta">
            <span className="pill">{funnel.name ?? funnel.funnelId}</span>
            <span className="pill muted">
              {funnel.version} · {funnel.variant}
            </span>
          </div>
          {progress.total > 0 && step.type !== 'info' && (
            <div className="progress" aria-label={`Step ${progress.current} of ${progress.total}`}>
              <div className="progress-bar" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
              <span className="progress-text">
                {progress.current}/{progress.total}
              </span>
            </div>
          )}
        </header>

        {step.type === 'result' && result ? (
          <ResultView
            result={result}
            canExpand={canExpand}
            onCta={() => tracker.track('cta_clicked', step.id, { result_id: result.id, cta_label: result.cta.label })}
            onExpand={() => tracker.track('recommendation_expanded', step.id, { result_id: result.id })}
            onRestart={() => void restart()}
          />
        ) : (
          <form
            className="step"
            onSubmit={(e) => {
              e.preventDefault();
              void handleContinue();
            }}
          >
            {step.type === 'info' && <div className="eyebrow">Welcome</div>}
            <h1>{step.title}</h1>
            {step.subtitle && <p className="subtitle">{step.subtitle}</p>}
            {step.body && <p className="lead">{step.body}</p>}

            <StepInput
              step={step}
              value={draft}
              error={fieldError}
              onChange={(v) => {
                setDraft(v);
                setFieldError(null);
              }}
            />

            {saveError && <div className="error">Could not save: {saveError}</div>}

            <div className="actions">
              {prevStep && (
                <button type="button" className="ghost" onClick={() => void handleBack()} disabled={saving}>
                  ← Back
                </button>
              )}
              <button type="submit" className="primary" disabled={saving}>
                {step.ctaLabel ?? 'Continue'}
              </button>
            </div>
          </form>
        )}
      </div>
      <p className="footnote muted">
        Session {session.id.slice(0, 8)} · pinned to {session.funnelVersion} · variant {session.variant}
        {session.variantSource === 'override' ? ' (override)' : ''}
      </p>
    </div>
  );
}
