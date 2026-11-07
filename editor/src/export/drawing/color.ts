/** Colour helpers shared by the PDF and DXF plan writers. */

export type Rgb = [number, number, number];

/** Parse `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `hsl()`; alpha is dropped. Unknown → mid grey. */
export function parseColor(css: string): Rgb {
  const s = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) return [0, 1, 2].map(i => parseInt(h[i] + h[i], 16)) as Rgb;
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (rgb) return [1, 2, 3].map(i => Math.round(Math.min(255, parseFloat(rgb[i])))) as Rgb;
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(s);
  if (hsl) return hslToRgb(parseFloat(hsl[1]), parseFloat(hsl[2]) / 100, parseFloat(hsl[3]) / 100);
  return [128, 128, 128];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map(v => Math.round(v * 255)) as Rgb;
}

export function toHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/** Mix a colour towards white: `amount` 0 → unchanged, 1 → white. Used for
 *  half-tone context and tinted fills (opaque, so prints predictably). */
export function tint(css: string, amount: number): string {
  const c = parseColor(css);
  return toHex(c.map(v => v + (255 - v) * amount) as Rgb);
}

/** DXF true colour (group code 420): 0x00RRGGBB. */
export function trueColor(css: string): number {
  const [r, g, b] = parseColor(css);
  return (r << 16) | (g << 8) | b;
}

/** The ten AutoCAD standard colours, enough to give each layer a sensible ACI fallback. */
const ACI_BASE: [number, Rgb][] = [
  [1, [255, 0, 0]], [2, [255, 255, 0]], [3, [0, 255, 0]], [4, [0, 255, 255]],
  [5, [0, 0, 255]], [6, [255, 0, 255]], [8, [128, 128, 128]], [9, [192, 192, 192]],
  [30, [255, 127, 0]], [150, [0, 127, 255]],
];

/** Nearest standard ACI to a colour (by hue when saturated, else 7/8/9 by lightness). */
export function nearestAci(css: string): number {
  const [r, g, b] = parseColor(css);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 40) return max < 100 ? 7 : max < 170 ? 8 : 9; // greys; 7 = black/white
  let best = 7, bestD = Infinity;
  for (const [aci, [ar, ag, ab]] of ACI_BASE) {
    const d = (r - ar) ** 2 + (g - ag) ** 2 + (b - ab) ** 2;
    if (d < bestD) { bestD = d; best = aci; }
  }
  return best;
}
