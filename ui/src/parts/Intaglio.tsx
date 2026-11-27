// Petalock's engraved logo, the large picture on the dark side of the lock screen and of every full-screen step (Plan 5
// Task 9b; the user interface design's 2026-11-27 note under "Name and logo"). It is the download page's picture ("The
// opening picture" of the download page design): twenty-six lines of the three-petal rule round (100, 100) in a 200 by
// 200 box, each a filled ribbon whose width swells with its petal. Line i follows r = 100 (0.62 + a sin(3t + phi)) with
// a = 0.16 + 0.156 i / 25 and phi = i pi / 26; its full width at angle t is
// weight (0.18 + 1.05 (0.5 + 0.5 sin(3t + phi)) ^ 2.2), set out on both sides of the line along its normal, a point every
// 1.5 degrees, the space between its two outlines filled (evenodd). The app draws it at weight 0.62, since it is shown at
// 3.8 pixels per unit. The colour comes from the style sheet (`fill`), so a contrast theme can change it.

/** The ribbons' weight on the app's screens. */
export const LOCK_WEIGHT = 0.62;

const num = (n: number) => String(Number(n.toFixed(2)));

function at(amplitude: number, phase: number, t: number): [number, number] {
  const r = 100 * (0.62 + amplitude * Math.sin(3 * t + phase));
  return [100 + r * Math.cos(t), 100 + r * Math.sin(t)];
}

/** One line as a ribbon: its two outlines, the line's normal worked out from a point just ahead on it. */
function ribbon(amplitude: number, phase: number, weight: number): string {
  const left: string[] = [];
  const right: string[] = [];
  for (let degrees = 0; degrees < 360; degrees += 1.5) {
    const t = (degrees * Math.PI) / 180;
    const [x, y] = at(amplitude, phase, t);
    const [x2, y2] = at(amplitude, phase, t + 0.002);
    const length = Math.hypot(x2 - x, y2 - y);
    const nx = -(y2 - y) / length;
    const ny = (x2 - x) / length;
    const half = (weight * (0.18 + 1.05 * Math.pow(0.5 + 0.5 * Math.sin(3 * t + phase), 2.2))) / 2;
    left.push(`${num(x + nx * half)} ${num(y + ny * half)}`);
    right.push(`${num(x - nx * half)} ${num(y - ny * half)}`);
  }
  return `M${left.join(" ")}Z M${right.join(" ")}Z`;
}

// Worked out once, the first time it is drawn, and kept: the rule never changes.
let ribbons: string[] | null = null;

function lines(): string[] {
  ribbons ??= Array.from({ length: 26 }, (_, i) => ribbon(0.16 + (0.156 * i) / 25, (i * Math.PI) / 26, LOCK_WEIGHT));
  return ribbons;
}

/** The engraved logo, for the eye only (the screen's words say what it is for). */
export function Intaglio({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 200 200" aria-hidden="true">
      {lines().map((d, i) => (
        <path key={i} d={d} fillRule="evenodd" />
      ))}
    </svg>
  );
}
