// The site's pictures, drawn from their rules (Plan 5, Task 6; the approved design, "The opening picture" and "The band"):
// the engraved logo, the dissolve band, and the small solid mark. Each function returns SVG markup for the build to put
// inline into the pages; the colours come from the style sheet (`fill` and `stroke` there), so one drawing serves the
// light and the dark theme and the Windows contrast themes recolour it.
//
// The engraved logo (design: `intaglio.mjs`): twenty-six lines of the logo's three-petal rule, in a 200 by 200 box centred
// at (100, 100); line `i` (0 to 25) follows r = 100 * (0.62 + a * sin(3t + phi)) with a = 0.16 + 0.156 * i / 25 and
// phi = i * pi / 26. Each line is a ribbon whose full width at angle t is
// weight * (0.18 + 1.05 * (0.5 + 0.5 * sin(3t + phi)) ** 2.2) logo units, set out on both sides of the line along its normal,
// one point every 1.5 degrees, filled with `fill-rule: evenodd`. The numbers are written with two decimals, as the drawing
// writes them, and trailing zeros are dropped (the same value, fewer bytes); the second outline's points follow the first
// without a repeated command (an SVG path's implicit line-to).

const num = (n) => String(Number(n.toFixed(2)));

const at = (amp, phase, t) => {
  const r = 100 * (0.62 + amp * Math.sin(3 * t + phase));
  return [100 + r * Math.cos(t), 100 + r * Math.sin(t)];
};

function ribbon(amp, phase, width, step = 1.5) {
  const left = [];
  const right = [];
  for (let deg = 0; deg < 360; deg += step) {
    const t = (deg * Math.PI) / 180;
    const [x, y] = at(amp, phase, t);
    const [x2, y2] = at(amp, phase, t + 0.002);
    const len = Math.hypot(x2 - x, y2 - y);
    const nx = -(y2 - y) / len;
    const ny = (x2 - x) / len;
    const w = width(t) / 2;
    left.push(`${num(x + nx * w)} ${num(y + ny * w)}`);
    right.push(`${num(x - nx * w)} ${num(y - ny * w)}`);
  }
  return `M${left.join(" ")}Z M${right.join(" ")}Z`;
}

/** The twenty-six lines as `<path>` elements (no colour: the style sheet's `fill`). `weight` scales every ribbon's width. */
export function intaglio(weight = 1) {
  let paths = "";
  for (let i = 0; i < 26; i += 1) {
    const amp = 0.16 + (i * 0.156) / 25;
    const phase = (i * Math.PI) / 26;
    const d = ribbon(amp, phase, (t) => weight * (0.18 + 1.05 * Math.pow(0.5 + 0.5 * Math.sin(3 * t + phase), 2.2)));
    paths += `<path d="${d}" fill-rule="evenodd"/>`;
  }
  return paths;
}

/** The weights the design fixes per place: 1 on the download page, 2.45 / 1.6 in the guide's header, 1.4 on the not-found page. */
export const WEIGHTS = Object.freeze({ download: 1, guide: 2.45 / 1.6, notFound: 1.4 });

/** The download page's picture: the box as drawn, in the svg whose viewBox is "-8 -8 216 216". */
export const heroPicture = () => intaglio(WEIGHTS.download);

/** The guide header's picture: in a 1280 by 300 box, the logo centred at (1060, 236), 1.6 pixels per logo unit. */
export const guidePicture = () => `<g transform="translate(900 76) scale(1.6)">${intaglio(WEIGHTS.guide)}</g>`;

/** The not-found page's picture. */
export const notFoundPicture = () => intaglio(WEIGHTS.notFound);

/**
 * The band where the blue meets the paper (design: "The band"): rows of the page's colour, 10 px apart, each row's dots larger
 * than the last until they close over the blue: radius 5 * 1.45 * ((row + 1) / rows) ** 1.3, odd rows offset half a step. A row
 * is one line drawn as round dots (a zero-length dash with a round cap is a dot as wide as the stroke), so the band is eleven
 * short elements instead of about fourteen hundred circles; the style sheet gives the stroke its colour.
 */
export function band({ width = 1280, height = 110, step = 10 } = {}) {
  const rows = Math.ceil(height / step);
  let paths = "";
  for (let j = 0; j < rows; j += 1) {
    const radius = (step / 2) * 1.45 * Math.pow((j + 1) / rows, 1.3);
    const offset = j % 2 === 0 ? 0 : step / 2;
    paths += `<path d="M${num(offset)} ${num(j * step + step / 2)}H${num(width + step + offset)}" stroke-width="${num(2 * radius)}" stroke-dasharray="0 ${num(step)}" stroke-linecap="round"/>`;
  }
  return paths;
}

/** The small solid three-petal mark (the app's icon rule: r = 100 * (0.56 + 0.34 * sin(3t)) with a hole at the centre). */
export function icon(size) {
  let d = "";
  for (let deg = 0; deg <= 360; deg += 2) {
    const t = (deg * Math.PI) / 180;
    const r = 100 * (0.56 + 0.34 * Math.sin(3 * t));
    d += `${deg === 0 ? "M" : "L"}${num(100 + r * Math.cos(t))} ${num(100 + r * Math.sin(t))}`;
  }
  return `<svg class="ic" width="${String(size)}" height="${String(size)}" viewBox="0 0 200 200" aria-hidden="true"><path d="${d}ZM115 100A15 15 0 1 0 85 100A15 15 0 1 0 115 100Z" fill="currentColor" fill-rule="evenodd"/></svg>`;
}
