import type { Step } from '@funnel/shared';

interface Props {
  step: Step;
  value: unknown;
  error: string | null;
  onChange: (value: unknown) => void;
}

/**
 * One generic component per step type. Nothing here knows about concrete
 * steps; titles, options, hints and error texts come from the config.
 */
export function StepInput({ step, value, error, onChange }: Props) {
  switch (step.type) {
    case 'single-select':
      return (
        <div className="options" role="radiogroup" aria-label={step.title}>
          {(step.options ?? []).map((o) => {
            const selected = value === o.id;
            return (
              <button
                type="button"
                key={o.id}
                role="radio"
                aria-checked={selected}
                className={selected ? 'option selected' : 'option'}
                onClick={() => onChange(o.id)}
              >
                <span className="option-label">{o.label}</span>
                {o.description && <span className="option-desc">{o.description}</span>}
              </button>
            );
          })}
          {error && <div className="error">{error}</div>}
        </div>
      );

    case 'multi-select': {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      const max = step.validation?.maxSelections;
      return (
        <div className="options" role="group" aria-label={step.title}>
          {(step.options ?? []).map((o) => {
            const selected = arr.includes(o.id);
            const disabled = !selected && max !== undefined && arr.length >= max;
            return (
              <button
                type="button"
                key={o.id}
                role="checkbox"
                aria-checked={selected}
                disabled={disabled}
                className={selected ? 'option selected' : 'option'}
                onClick={() => onChange(selected ? arr.filter((x) => x !== o.id) : [...arr, o.id])}
              >
                <span className="option-label">{o.label}</span>
                {o.description && <span className="option-desc">{o.description}</span>}
              </button>
            );
          })}
          {max !== undefined && (
            <div className="hint">
              {arr.length}/{max} selected
            </div>
          )}
          {error && <div className="error">{error}</div>}
        </div>
      );
    }

    case 'number':
      return (
        <div className="number-input">
          <label className="number-field">
            <input
              type="number"
              inputMode="numeric"
              value={value === undefined || value === null ? '' : String(value)}
              placeholder={step.placeholder}
              min={step.validation?.min}
              max={step.validation?.max}
              step={step.validation?.integer ? 1 : 'any'}
              onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              aria-invalid={!!error}
              autoFocus
            />
            {step.unit && <span className="unit">{step.unit}</span>}
          </label>
          {step.hint && <div className="hint">{step.hint}</div>}
          {error && <div className="error">{error}</div>}
        </div>
      );

    default:
      return null;
  }
}
