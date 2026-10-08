import type { Step } from '@funnel/shared';

interface Props {
  step: Step;
  value: unknown;
  error: string | null;
  onChange: (value: unknown) => void;
}

/**
 * One generic component per step type. Nothing here knows about concrete
 * steps; titles, options, hints and error texts come from the config
 * (`step.content`, `step.input`, `step.validation`).
 */
export function StepInput({ step, value, error, onChange }: Props) {
  const input = step.input ?? {};
  const options = input.options ?? [];
  const label = step.content.title ?? step.id;

  switch (step.type) {
    case 'single-select':
      return (
        <div className="options" role="radiogroup" aria-label={label}>
          {options.map((o) => {
            const selected = value === o.value;
            return (
              <button
                type="button"
                key={o.value}
                role="radio"
                aria-checked={selected}
                className={selected ? 'option selected' : 'option'}
                onClick={() => onChange(o.value)}
              >
                <span className="option-label">{o.label}</span>
                {o.description && <span className="option-desc">{o.description}</span>}
              </button>
            );
          })}
          {step.content.helperText && <div className="hint">{step.content.helperText}</div>}
          {error && <div className="error">{error}</div>}
        </div>
      );

    case 'multi-select': {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      const max = step.validation?.maxSelections;
      return (
        <div className="options" role="group" aria-label={label}>
          {options.map((o) => {
            const selected = arr.includes(o.value);
            const disabled = !selected && max !== undefined && arr.length >= max;
            return (
              <button
                type="button"
                key={o.value}
                role="checkbox"
                aria-checked={selected}
                disabled={disabled}
                className={selected ? 'option selected' : 'option'}
                onClick={() => onChange(selected ? arr.filter((x) => x !== o.value) : [...arr, o.value])}
              >
                <span className="option-label">{o.label}</span>
                {o.description && <span className="option-desc">{o.description}</span>}
              </button>
            );
          })}
          <div className="hint">
            {step.content.helperText}
            {max !== undefined && (
              <>
                {step.content.helperText ? ' · ' : ''}
                {arr.length}/{max} selected
              </>
            )}
          </div>
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
              name={input.name ?? step.id}
              inputMode={input.step !== undefined && input.step < 1 ? 'decimal' : 'numeric'}
              value={value === undefined || value === null ? '' : String(value)}
              placeholder={input.placeholder}
              min={input.min}
              max={input.max}
              step={input.step ?? 'any'}
              onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              aria-invalid={!!error}
              aria-label={label}
              autoFocus
            />
            {input.unit && <span className="unit">{input.unit}</span>}
          </label>
          {step.content.helperText && <div className="hint">{step.content.helperText}</div>}
          {error && <div className="error">{error}</div>}
        </div>
      );

    default:
      return null;
  }
}
