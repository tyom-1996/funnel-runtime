import { useState } from 'react';
import type { FunnelResult } from '@funnel/shared';

interface Props {
  result: FunnelResult;
  canExpand: boolean;
  onCta: () => void;
  onExpand: () => void;
  onRestart: () => void;
}

export function ResultView({ result, canExpand, onCta, onExpand, onRestart }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [ctaDone, setCtaDone] = useState(false);

  const handleCta = () => {
    onCta();
    setCtaDone(true);
    if (result.cta.url && !result.cta.url.startsWith('#')) {
      window.open(result.cta.url, '_blank', 'noopener');
    }
  };

  return (
    <div className="result">
      <div className="eyebrow">Your recommendation</div>
      <h1>{result.title}</h1>
      {result.body && <p className="lead">{result.body}</p>}
      {result.highlights && (
        <ul className="highlights">
          {result.highlights.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      )}
      {result.details && result.details.length > 0 && (
        <div className="details">
          <button
            type="button"
            className="link-button"
            aria-expanded={expanded}
            onClick={() => {
              if (!expanded && canExpand) onExpand();
              setExpanded((v) => !v);
            }}
          >
            {expanded ? 'Hide the reasoning' : 'Why this recommendation?'}
          </button>
          {expanded && (
            <ul className="details-list">
              {result.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="actions">
        <button type="button" className="primary" onClick={handleCta}>
          {result.cta.label}
        </button>
        <button type="button" className="ghost" onClick={onRestart}>
          Start over
        </button>
      </div>
      {ctaDone && <div className="toast">Thanks — your playbook is on its way.</div>}
    </div>
  );
}
