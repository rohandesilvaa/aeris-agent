import type { CSSProperties } from "react";
import { botTone, toneCss } from "../team";

type Props = { botId: string; name: string; size?: number; working?: boolean };

/** A teammate's monogram in its own colour, with a pulse while it works. */
export default function Avatar({ botId, name, size = 34, working = false }: Props) {
  const tone = botTone(botId);
  const style = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.4),
    "--tone": toneCss(tone),
    "--tone-soft": toneCss(tone, 0.14),
  } as CSSProperties;
  return (
    <span className={`avatar ${working ? "working" : ""}`} style={style} aria-hidden="true">
      {name.trim().slice(0, 1).toUpperCase() || "?"}
    </span>
  );
}
