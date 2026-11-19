/**
 * Deterministic IFC GlobalIds: the same BimDown element (level + table + id)
 * gets the same GUID on every export, so Revit links, BCF issues and model
 * diffs keep tracking it across re-exports.
 */

const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/** 128-bit string hash (cyrb128) as 16 bytes. */
function hash128(s: string): Uint8Array {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
  const out = new Uint8Array(16);
  [h1, h2, h3, h4].forEach((h, i) => {
    out[i * 4] = (h >>> 24) & 255;
    out[i * 4 + 1] = (h >>> 16) & 255;
    out[i * 4 + 2] = (h >>> 8) & 255;
    out[i * 4 + 3] = h & 255;
  });
  return out;
}

/** 16 bytes → the 22-character IFC base64 GUID (first char is 0..3). */
export function compressGuid(bytes: Uint8Array): string {
  const enc = (n: number, digits: number) => {
    let s = '';
    for (let i = 0; i < digits; i++) { s = B64[n % 64] + s; n = Math.floor(n / 64); }
    return s;
  };
  let out = enc(bytes[0], 2);
  for (let i = 1; i < 16; i += 3) out += enc((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2], 4);
  return out;
}

export function ifcGuid(key: string): string {
  return compressGuid(hash128(key));
}
