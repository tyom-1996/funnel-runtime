import { useState } from 'react';
import type { FunnelResult, Step } from '@funnel/shared';

interface Props {
  step: Step;
  result: FunnelResult;
  /** Called on every CTA click (cta_clicked). */
  onCta: () => void;
  /** Called the first time the recommendations are revealed (recommendation_expanded, if the version allows it). */
  onExpand: (source: 'cta') => void;
  onRestart: () => void;
  /** Session persistence state for the result step (drives loadingTitle / errorTitle / retryLabel from the config). */
  saving?: boolean;
  saveError?: string | null;
  onRetry?: () => void;
}

/**
 * Result screen. Title/summary/CTA come from the (variant-merged) result; the
 * CTA action `expand_recommendation` reveals the recommendation list in place.
 * Any other action with a `url` opens the link.
 */
export function ResultView({ step, result, onCta, onExpand, onRestart, saving, saveError, onRetry }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (saving) {
    return (
      <div className="result">
        <h1 className="muted">{step.content.loadingTitle ?? 'Loading…'}</h1>
      </div>
    );
  }
  if (saveError) {
    return (
      <div className="result">
        <h1>{step.content.errorTitle ?? 'Something went wrong'}</h1>
        <p className="muted">{saveError}</p>
        <div className="actions">
          <button type="button" className="primary" onClick={onRetry}>
            {step.content.retryLabel ?? 'Try again'}
          </button>
        </div>
      </div>
    );
  }

  const handleCta = () => {
    onCta();
    if (result.cta.action === 'expand_recommendation') {
      if (!expanded) onExpand('cta');
      setExpanded(true);
      return;
    }
    if (result.cta.url && !result.cta.url.startsWith('#')) {
      window.open(result.cta.url, '_blank', 'noopener');
    }
  };

  const recommendations = result.recommendations ?? [];

  return (
    <div className="result">
      <div className="eyebrow">{step.content.eyebrow ?? 'Your recommendation'}</div>
      <h1>{result.title}</h1>
      {result.summary && <p className="lead">{result.summary}</p>}

      {expanded && recommendations.length > 0 && (
        <ul className="highlights" aria-label="Recommendations">
          {recommendations.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      <div className="actions">
        {!expanded || result.cta.action !== 'expand_recommendation' ? (
          <button type="button" className="primary" onClick={handleCta}>
            {result.cta.label}
          </button>
        ) : null}
        <button type="button" className="ghost" onClick={onRestart}>
          Start over
        </button>
      </div>
    </div>
  );
}
