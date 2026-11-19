/**
 * CJK font for PDF sheets: Noto Sans SC (SIL OFL 1.1, see assets/fonts/OFL.txt),
 * subset to GB2312 + Latin by scripts/build-cjk-font.py. Only fetched when a
 * sheet has text outside Latin-1; jsPDF embeds just the glyphs used.
 */
import fontUrl from '../../assets/fonts/NotoSansSC-Regular-subset.ttf?url';

export const CJK_FONT_NAME = 'NotoSansSC';
export const CJK_FONT_FILE = 'NotoSansSC-Regular-subset.ttf';

export type FontLoader = () => Promise<ArrayBuffer>;

/** True when Helvetica (WinAnsi) can't show some of the text. */
export function needsUnicodeFont(texts: Iterable<string>): boolean {
  for (const t of texts) if (/[^\x20-\x7e\xa0-\xff]/.test(t)) return true;
  return false;
}

let cached: Promise<string> | null = null;

const fetchFont: FontLoader = async () => {
  const res = await fetch(fontUrl);
  if (!res.ok) throw new Error(`font ${res.status}`);
  return res.arrayBuffer();
};

/** The font as a binary string (what jsPDF's VFS takes), loaded once per session. */
export function loadUnicodeFont(loader?: FontLoader): Promise<string> {
  if (loader) return loader().then(toBinaryString);
  cached ??= fetchFont().then(toBinaryString).catch(err => { cached = null; throw err; });
  return cached;
}

function toBinaryString(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}
