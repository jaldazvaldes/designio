import { useEffect, useState } from 'react';

/** Quién hizo algo: tú o una IA con nombre (Claude, Codex…). */
export interface Actor {
  author: 'human' | 'ai';
  agent?: string;
}

export function actorName(actor: Actor): string {
  return actor.author === 'ai' ? (actor.agent ?? 'IA') : 'Tú';
}

export function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Frase completa para la actividad: tus cambios ya vienen en segunda persona
 * («Moviste «X»»); los de la IA en tercera, y se les antepone su nombre («Claude movió «X»»).
 */
export function sentence(item: Actor & { label: string }): string {
  return item.author === 'ai' ? `${actorName(item)} ${lowerFirst(item.label)}` : item.label;
}

export function timeAgo(iso: string | number, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'ahora';
  if (s < 60) return 'hace unos segundos';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short' });
}

/** Re-renderiza cada `ms` para que «hace 2 min» y la presencia se mantengan al día. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

const SPARK = 'M12 2l2.2 7.3L22 12l-7.8 2.7L12 22l-2.2-7.3L2 12l7.8-2.7z';

export function Spark({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={SPARK} fill="currentColor" />
    </svg>
  );
}

export function Avatar({ actor, size = 24 }: { actor: Actor; size?: number }) {
  const name = actorName(actor);
  if (actor.author === 'ai') {
    return (
      <span className="avatar avatar-ai" style={{ width: size, height: size }} title={name}>
        <Spark size={Math.round(size * 0.5)} />
      </span>
    );
  }
  return (
    <span
      className="avatar avatar-you"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      title="Tú"
    >
      Tú
    </span>
  );
}
