import { useRef, useState } from 'react';

interface NumberFieldProps {
  /** Accessible name — full and unambiguous, e.g. "Position X". */
  label: string;
  /** Short text shown on the scrub handle. Defaults to the label. */
  scrubLabel?: string;
  value: number;
  onChange(value: number): void;
  /** World units (or degrees) moved per pixel dragged. */
  step?: number;
  suffix?: string;
  disabled?: boolean;
}

/**
 * A numeric input whose label can be dragged to scrub the value.
 *
 * Drag-to-scrub is the standard interaction in every 3D tool, and it matters here specifically
 * because nudging a value is far more common than typing an exact one. Typing still works: the
 * field only commits on blur or Enter, so a half-typed "-" or "1." is never parsed as a value and
 * pushed into the document.
 */
export function NumberField({
  label,
  scrubLabel,
  value,
  onChange,
  step = 0.1,
  suffix,
  disabled = false,
}: NumberFieldProps): React.JSX.Element {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const [lastValue, setLastValue] = useState(value);
  const scrub = useRef<{ startX: number; startValue: number } | null>(null);

  // Track external changes — a gizmo drag, an undo — but never stomp on what is being typed.
  // Adjusted during render rather than in an effect: an effect would paint the stale value for a
  // frame first, which is visible as flicker while a gizmo drag streams updates in.
  if (!editing && value !== lastValue) {
    setLastValue(value);
    setDraft(String(Number(value.toFixed(4))));
  }

  const commit = (raw: string): void => {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) onChange(parsed);
    else setDraft(String(value));
  };

  const handleScrubDown = (event: React.PointerEvent<HTMLSpanElement>): void => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    scrub.current = { startX: event.clientX, startValue: value };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleScrubMove = (event: React.PointerEvent<HTMLSpanElement>): void => {
    const origin = scrub.current;
    if (!origin) return;
    // Shift for fine control is the near-universal convention for this interaction.
    const scale = event.shiftKey ? step / 10 : step;
    onChange(Number((origin.startValue + (event.clientX - origin.startX) * scale).toFixed(4)));
  };

  const handleScrubUp = (event: React.PointerEvent<HTMLSpanElement>): void => {
    scrub.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const inputId = `field-${label.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <div className={`number-field${disabled ? ' disabled' : ''}`}>
      <span
        className="number-scrub"
        onPointerDown={handleScrubDown}
        onPointerMove={handleScrubMove}
        onPointerUp={handleScrubUp}
        onPointerCancel={handleScrubUp}
        aria-hidden="true"
      >
        {scrubLabel ?? label}
      </span>
      <input
        id={inputId}
        type="text"
        inputMode="decimal"
        aria-label={label}
        disabled={disabled}
        value={draft}
        onFocus={() => setEditing(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          setEditing(false);
          commit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(String(value));
            event.currentTarget.blur();
          }
        }}
      />
      {suffix && <span className="number-suffix">{suffix}</span>}
    </div>
  );
}
