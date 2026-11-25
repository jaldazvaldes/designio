import { type Box, unionBoxes } from '@designio/core';
import { Spark, useNow } from '../components/people';
import { useDoc } from '../stores/doc';
import { useUi } from '../stores/ui';
import { boxToScreen, type PageBoxes } from './geometry';

/** Una IA trabajando se considera activa durante 2 min sin noticias; su cursor queda 8 s tras terminar. */
const WORKING_TTL = 120_000;
const LINGER_MS = 8_000;

/**
 * La IA, visible como una compañera más: un recuadro discontinuo sobre lo que está tocando,
 * con su nombre y lo que hace, y un cursor que se queda un momento donde trabajó.
 */
export function AiPresence({ boxes }: { boxes: PageBoxes }) {
  const presence = useDoc((s) => s.presence);
  const lastAi = useDoc((s) => s.lastAi);
  const camera = useUi((s) => s.camera);
  const now = useNow(1000);

  const boxOf = (ids: string[]): Box | null =>
    unionBoxes(ids.map((id) => boxes.get(id)).filter((b): b is NonNullable<typeof b> => !!b));

  const views: { key: string; name: string; text: string | null; box: Box; working: boolean }[] = [];
  for (const p of Object.values(presence)) {
    const age = now - new Date(p.at).getTime();
    const working = p.state === 'working' && age < WORKING_TTL;
    const recent = lastAi && lastAi.name === p.name && now - lastAi.at < LINGER_MS ? lastAi : null;
    // Mientras trabaja: lo que anunció. Al terminar: lo que acaba de cambiar.
    const box = working
      ? (boxOf(p.targets) ?? (recent ? boxOf(recent.ids) : null))
      : recent
        ? boxOf(recent.ids)
        : null;
    if (!box) continue;
    views.push({
      key: p.agentId,
      name: p.name,
      text: working ? p.text.replace(/^está /, '') : null,
      box,
      working,
    });
  }
  // Una IA que cambió algo sin anunciar presencia (p. ej. editando el JSON) también deja rastro.
  if (lastAi && now - lastAi.at < LINGER_MS && !views.some((v) => v.name === lastAi.name)) {
    const box = boxOf(lastAi.ids);
    if (box) views.push({ key: `last-${lastAi.name}`, name: lastAi.name, text: null, box, working: false });
  }

  return (
    <>
      {views.map((v) => {
        const s = boxToScreen(camera, v.box);
        const cx = s.x + Math.min(s.w - 8, Math.max(24, s.w * 0.72));
        const cy = s.y + Math.min(s.h - 8, Math.max(24, s.h * 0.42));
        return (
          <div key={v.key} className={`ai-presence${v.working ? ' is-working' : ' is-done'}`}>
            {v.working && (
              <div
                className="ai-box"
                style={{ left: s.x - 6, top: s.y - 6, width: s.w + 12, height: s.h + 12 }}
              >
                <span className="ai-tag">
                  <Spark size={10} /> {v.name} · {v.text}
                </span>
              </div>
            )}
            <div className="ai-cursor" style={{ left: cx, top: cy }}>
              <svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">
                <path d="M2 2l6.5 17 2.4-7.1L18 9.5z" />
              </svg>
              <b>{v.name}</b>
            </div>
          </div>
        );
      })}
    </>
  );
}
