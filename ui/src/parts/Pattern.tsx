// The line drawings that tell vaults apart: the big pattern on the lock screen (fourteen closed lines) and the small
// mark beside a vault's name (two). Both are drawn from one number, the pattern's points, the way the approved screens
// were; the colour and the thickness come from the style sheet, so a contrast theme can change them.

export interface VaultLook {
  accent: "work" | "home" | "old";
  points: number;
}

/**
 * How a vault looks, worked out from its place on the list, not stored: every listed vault has a shape of its own, by
 * its place (3 points, then 5, 6, 7, 8, 9 and on; never 4), while the colour takes turns, Work then Home. A read-only
 * vault is the amber one with four points wherever it is, so no listed vault ever has its shape.
 */
export function vaultLook(position: number, readOnly: boolean): VaultLook {
  if (readOnly) return { accent: "old", points: 4 };
  return {
    accent: position % 2 === 0 ? "work" : "home",
    points: position === 0 ? 3 : position + 4,
  };
}

const cache = new Map<string, string>();

// `lines` closed curves of 360 degrees round a centre, each radius swelling `points` times; the lines differ a little
// in size and in turn. The numbers are those of the approved drawings.
function lines(points: number, count: number, step: number, size: (index: number) => number, turn: (index: number) => number): string {
  const key = `${String(points)}/${String(count)}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  let d = "";
  for (let index = 0; index < count; index += 1) {
    const amplitude = size(index);
    const phase = turn(index);
    for (let degrees = 0; degrees <= 360; degrees += step) {
      const angle = (degrees * Math.PI) / 180;
      const radius = 100 * (0.62 + amplitude * Math.sin(points * angle + phase));
      d += `${degrees === 0 ? "M" : "L"}${(100 + radius * Math.cos(angle)).toFixed(1)} ${(100 + radius * Math.sin(angle)).toFixed(1)}`;
    }
    d += "Z";
  }
  cache.set(key, d);
  return d;
}

interface DrawingProps {
  points: number;
  /** The style sheet's class for the drawing's size, place and stroke. */
  className?: string;
}

/** The fourteen-line pattern, for the lock screen. */
export function Pattern({ points, className }: DrawingProps) {
  const d = lines(points, 14, 3, (index) => 0.16 + index * 0.012, (index) => (index * Math.PI) / 14);
  return (
    <svg className={className} viewBox="0 0 200 200" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** The two-line mark beside a vault's name. Its petals are shallow, so up to nine points stay clear at 36 pixels. */
export function VaultMark({ points, className }: DrawingProps) {
  const d = lines(points, 2, 2, () => 0.17, (index) => index * Math.PI);
  return (
    <svg className={className} viewBox="0 0 200 200" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
