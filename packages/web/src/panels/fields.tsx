import { useEffect, useState } from 'react';

export function NumberField({
  label,
  value,
  onCommit,
  min,
  step = 1,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  step?: number;
}) {
  const [text, setText] = useState(String(Math.round(value * 100) / 100));
  useEffect(() => setText(String(Math.round(value * 100) / 100)), [value]);
  const commit = () => {
    const n = Number(text.replace(',', '.'));
    if (Number.isFinite(n) && n !== value && (min === undefined || n >= min)) onCommit(n);
    else setText(String(Math.round(value * 100) / 100));
  };
  return (
    <label className="field field-num">
      <span>{label}</span>
      <input
        value={text}
        inputMode="decimal"
        step={step}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const delta = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : step);
            onCommit(Math.max(min ?? Number.NEGATIVE_INFINITY, value + delta));
          }
        }}
      />
    </label>
  );
}

export function TextField({
  label,
  value,
  onCommit,
  placeholder,
  multiline = false,
}: {
  label?: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: el control (input o textarea) está dentro de la etiqueta
    <label className="field field-text">
      {label && <span>{label}</span>}
      {multiline ? (
        <textarea
          value={text}
          placeholder={placeholder}
          rows={3}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur();
            if (e.key === 'Escape') {
              setText(value);
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
      ) : (
        <input
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setText(value);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      )}
    </label>
  );
}

function toHex(color: string | undefined): string {
  if (color && /^#[0-9a-f]{6}$/i.test(color)) return color;
  if (color && /^#[0-9a-f]{3}$/i.test(color)) {
    return `#${color
      .slice(1)
      .split('')
      .map((c) => c + c)
      .join('')}`;
  }
  return '#ffffff';
}

export function ColorField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string | undefined;
  onCommit: (v: string | null) => void;
}) {
  return (
    <div className="field field-color">
      <span>{label}</span>
      <input
        type="color"
        value={toHex(value)}
        onChange={(e) => onCommit(e.target.value)}
        aria-label={label}
      />
      <TextField
        value={value ?? ''}
        placeholder="ninguno"
        onCommit={(v) => onCommit(v.trim() ? v.trim() : null)}
      />
    </div>
  );
}
