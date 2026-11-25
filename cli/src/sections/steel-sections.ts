/**
 * Steel section library: common catalogue sizes with their real dimensions,
 * to create column / beam types from (Edit Type ▸ From library).
 *   EN   HEA / HEB / IPE (EN 10365), UPN, RHS / SHS / CHS (EN 10210 hot
 *        finished, corner radius 1.5 t), equal angles L (EN 10056)
 *   US   W, HSS rectangular / square / round (ASTM A500, design wall
 *        thickness 0.93 × nominal, corner radius 2 t), C, L (AISC Manual)
 *   CN   HW / HM / HN (GB/T 11263), channels [ (GB/T 706), equal angles L
 *        (GB/T 706), cold-formed square / rectangular tubes (GB/T 6728, outer
 *        corner 2 t), round tubes Φ (GB/T 8162)
 *   US   K-series open-web joists (SJI): depth and standard weight per foot;
 *        the chord angle thickness is fitted so the open_web area gives it
 * Stored in metres; `sectionTypeValues` scales to the project unit. No
 * imports: the editor re-exports this file (families/sections/steelSections.ts);
 * import-ifc maps catalogue designations with it.
 */
export type SectionStandard = 'EN' | 'US' | 'CN';

export interface SteelSection {
  /** Catalogue designation, e.g. "HEA 300", "W14X90"; the type name and IFC ProfileName. */
  designation: string;
  standard: SectionStandard;
  /** Family within the standard ("HEA", "W", "HSS round"…), for grouping in the picker. */
  family: string;
  shape: 'i_shape' | 'c_shape' | 'l_shape' | 'rect_hollow' | 'round_hollow' | 'open_web';
  /** Section parameters in metres (structural_section_profile fields). */
  size_x: number;
  size_y?: number;
  flange?: number;
  web?: number;
  thickness?: number;
  root_radius?: number;
  /** Default steel grade of the family. */
  grade: string;
}

const MM = 0.001;
const IN = 0.0254;
export const STEEL_DENSITY = 7850;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

type ISpec = [name: string, h: number, b: number, tw: number, tf: number, r: number];

function iShapes(standard: SectionStandard, family: string, grade: string, unit: number, rows: ISpec[], shape: 'i_shape' | 'c_shape' = 'i_shape', label = (n: string) => n): SteelSection[] {
  return rows.map(([n, h, b, tw, tf, r]) => ({
    designation: label(n), standard, family, shape, grade,
    size_x: r6(b * unit), size_y: r6(h * unit), web: r6(tw * unit), flange: r6(tf * unit), root_radius: r6(r * unit),
  }));
}

// h, b, tw, tf, r (mm)
const HEA: ISpec[] = [
  ['100', 96, 100, 5, 8, 12], ['120', 114, 120, 5, 8, 12], ['140', 133, 140, 5.5, 8.5, 12], ['160', 152, 160, 6, 9, 15],
  ['180', 171, 180, 6, 9.5, 15], ['200', 190, 200, 6.5, 10, 18], ['220', 210, 220, 7, 11, 18], ['240', 230, 240, 7.5, 12, 21],
  ['260', 250, 260, 7.5, 12.5, 24], ['280', 270, 280, 8, 13, 24], ['300', 290, 300, 8.5, 14, 27], ['320', 310, 300, 9, 15.5, 27],
  ['340', 330, 300, 9.5, 16.5, 27], ['360', 350, 300, 10, 17.5, 27], ['400', 390, 300, 11, 19, 27], ['450', 440, 300, 11.5, 21, 27],
  ['500', 490, 300, 12, 23, 27], ['600', 590, 300, 13, 25, 27],
];
const HEB: ISpec[] = [
  ['100', 100, 100, 6, 10, 12], ['120', 120, 120, 6.5, 11, 12], ['140', 140, 140, 7, 12, 12], ['160', 160, 160, 8, 13, 15],
  ['180', 180, 180, 8.5, 14, 15], ['200', 200, 200, 9, 15, 18], ['220', 220, 220, 9.5, 16, 18], ['240', 240, 240, 10, 17, 21],
  ['260', 260, 260, 10, 17.5, 24], ['280', 280, 280, 10.5, 18, 24], ['300', 300, 300, 11, 19, 27], ['320', 320, 300, 11.5, 20.5, 27],
  ['340', 340, 300, 12, 21.5, 27], ['360', 360, 300, 12.5, 22.5, 27], ['400', 400, 300, 13.5, 24, 27], ['450', 450, 300, 14, 26, 27],
  ['500', 500, 300, 14.5, 28, 27], ['600', 600, 300, 15.5, 30, 27],
];
const IPE: ISpec[] = [
  ['80', 80, 46, 3.8, 5.2, 5], ['100', 100, 55, 4.1, 5.7, 7], ['120', 120, 64, 4.4, 6.3, 7], ['140', 140, 73, 4.7, 6.9, 7],
  ['160', 160, 82, 5, 7.4, 9], ['180', 180, 91, 5.3, 8, 9], ['200', 200, 100, 5.6, 8.5, 12], ['220', 220, 110, 5.9, 9.2, 12],
  ['240', 240, 120, 6.2, 9.8, 15], ['270', 270, 135, 6.6, 10.2, 15], ['300', 300, 150, 7.1, 10.7, 15], ['330', 330, 160, 7.5, 11.5, 18],
  ['360', 360, 170, 8, 12.7, 18], ['400', 400, 180, 8.6, 13.5, 21], ['450', 450, 190, 9.4, 14.6, 21], ['500', 500, 200, 10.2, 16, 21],
  ['550', 550, 210, 11.1, 17.2, 24], ['600', 600, 220, 12, 19, 24],
];
// UPN: mean flange thickness, root radius r1
const UPN: ISpec[] = [
  ['80', 80, 45, 6, 8, 8], ['100', 100, 50, 6, 8.5, 8.5], ['120', 120, 55, 7, 9, 9], ['140', 140, 60, 7, 10, 10],
  ['160', 160, 65, 7.5, 10.5, 10.5], ['180', 180, 70, 8, 11, 11], ['200', 200, 75, 8.5, 11.5, 11.5], ['220', 220, 80, 9, 12.5, 12.5],
  ['240', 240, 85, 9.5, 13, 13], ['260', 260, 90, 10, 14, 14], ['280', 280, 95, 10, 15, 15], ['300', 300, 100, 10, 16, 16],
];
// d, bf, tw, tf, r = kdes − tf (in)
const W: ISpec[] = [
  ['W8X31', 8.0, 8.0, 0.285, 0.435, 0.394], ['W10X33', 9.73, 7.96, 0.29, 0.435, 0.5], ['W10X49', 9.98, 10.0, 0.34, 0.56, 0.5],
  ['W12X26', 12.2, 6.49, 0.23, 0.38, 0.3], ['W12X50', 12.2, 8.08, 0.37, 0.64, 0.5], ['W12X65', 12.1, 12.0, 0.39, 0.605, 0.595],
  ['W14X22', 13.7, 5.0, 0.23, 0.335, 0.4], ['W14X30', 13.8, 6.73, 0.27, 0.385, 0.4], ['W14X48', 13.8, 8.03, 0.34, 0.595, 0.595],
  ['W14X90', 14.0, 14.5, 0.44, 0.71, 0.6], ['W16X26', 15.7, 5.5, 0.25, 0.345, 0.4], ['W16X40', 16.0, 7.0, 0.305, 0.505, 0.4],
  ['W18X35', 17.7, 6.0, 0.3, 0.425, 0.4], ['W18X50', 18.0, 7.5, 0.355, 0.57, 0.4], ['W21X44', 20.7, 6.5, 0.35, 0.45, 0.5],
  ['W21X62', 21.0, 8.24, 0.4, 0.615, 0.5], ['W24X55', 23.6, 7.01, 0.395, 0.505, 0.5], ['W24X76', 23.9, 8.99, 0.44, 0.68, 0.5],
  ['W27X84', 26.7, 10.0, 0.46, 0.64, 0.6], ['W30X99', 29.7, 10.5, 0.52, 0.67, 0.65], ['W33X118', 32.9, 11.5, 0.55, 0.74, 0.8],
  ['W36X135', 35.6, 12.0, 0.6, 0.79, 0.75],
];
const C_US: ISpec[] = [
  ['C6X8.2', 6, 1.92, 0.2, 0.343, 0.25], ['C8X11.5', 8, 2.26, 0.22, 0.39, 0.3125], ['C10X15.3', 10, 2.6, 0.24, 0.436, 0.3125],
  ['C12X20.7', 12, 2.94, 0.282, 0.501, 0.375], ['C15X33.9', 15, 3.4, 0.4, 0.65, 0.4375],
];
// GB/T 11263 H sections: h, b, tw, tf, r (mm)
const HW: ISpec[] = [
  ['HW200x200x8x12', 200, 200, 8, 12, 13], ['HW250x250x9x14', 250, 250, 9, 14, 13], ['HW300x300x10x15', 300, 300, 10, 15, 13],
  ['HW350x350x12x19', 350, 350, 12, 19, 13], ['HW400x400x13x21', 400, 400, 13, 21, 22],
];
const HM: ISpec[] = [
  ['HM244x175x7x11', 244, 175, 7, 11, 13], ['HM294x200x8x12', 294, 200, 8, 12, 13], ['HM340x250x9x14', 340, 250, 9, 14, 13],
  ['HM390x300x10x16', 390, 300, 10, 16, 13], ['HM440x300x11x18', 440, 300, 11, 18, 13], ['HM488x300x11x18', 488, 300, 11, 18, 13],
];
const HN: ISpec[] = [
  ['HN200x100x5.5x8', 200, 100, 5.5, 8, 8], ['HN250x125x6x9', 250, 125, 6, 9, 8], ['HN300x150x6.5x9', 300, 150, 6.5, 9, 13],
  ['HN350x175x7x11', 350, 175, 7, 11, 13], ['HN400x200x8x13', 400, 200, 8, 13, 13], ['HN450x200x9x14', 450, 200, 9, 14, 13],
  ['HN500x200x10x16', 500, 200, 10, 16, 13], ['HN600x200x11x17', 600, 200, 11, 17, 13], ['HN700x300x13x24', 700, 300, 13, 24, 18],
];

/** Rectangular hollow: h × b × t (depth × width × wall); `ro` = outer corner radius factor × t. */
function rhs(standard: SectionStandard, family: string, grade: string, unit: number, rows: [string, number, number, number][], ro: number): SteelSection[] {
  return rows.map(([n, h, b, t]) => ({
    designation: n, standard, family, shape: 'rect_hollow' as const, grade,
    size_x: r6(b * unit), size_y: r6(h * unit), thickness: r6(t * unit), root_radius: r6(ro * t * unit),
  }));
}

function chs(standard: SectionStandard, family: string, grade: string, unit: number, rows: [string, number, number][]): SteelSection[] {
  return rows.map(([n, d, t]) => ({
    designation: n, standard, family, shape: 'round_hollow' as const, grade, size_x: r6(d * unit), thickness: r6(t * unit),
  }));
}

function angles(standard: SectionStandard, grade: string, unit: number, rows: [string, number, number, number, number][]): SteelSection[] {
  return rows.map(([n, a, b, t, r]) => ({
    designation: n, standard, family: 'L', shape: 'l_shape' as const, grade,
    size_x: r6(a * unit), size_y: r6(b * unit), thickness: r6(t * unit), root_radius: r6(r * unit),
  }));
}

const enRhs = (h: number, b: number, t: number): [string, number, number, number] =>
  [`${h === b ? 'SHS' : 'RHS'} ${h}x${b}x${t}`, h, b, t];
// US HSS: nominal t → design 0.93 t
const usRhs = (h: number, b: number, t: string): [string, number, number, number] => {
  const [p, q] = t.split('/').map(Number);
  return [`HSS${h}X${b}X${t}`, h, b, Math.round(0.93 * (q ? p / q : p) * 1000) / 1000];
};
const usChs = (d: string, t: string): [string, number, number] => [`HSS${d}X${t}`, Number(d), Math.round(0.93 * Number(t) * 1000) / 1000];

// GB/T 706 hot-rolled channels: h, b, d (web), t (flange), r (mm)
const CN_CHANNEL: ISpec[] = [
  ['[10', 100, 48, 5.3, 8.5, 8.5], ['[12.6', 126, 53, 5.5, 9, 9], ['[14a', 140, 58, 6, 9.5, 9.5], ['[16a', 160, 63, 6.5, 10, 10],
  ['[18a', 180, 68, 7, 10.5, 10.5], ['[20a', 200, 73, 7, 11, 11], ['[22a', 220, 77, 7, 11.5, 11.5], ['[25a', 250, 78, 7, 12, 12],
  ['[28a', 280, 82, 7.5, 12.5, 12.5], ['[32a', 320, 88, 8, 14, 14], ['[36a', 360, 96, 9, 16, 16], ['[40a', 400, 100, 10.5, 18, 18],
];

/** Chord width / depth of a K-series joist section (m), as Revit's K-Series family. */
const JOIST_CHORD_W = 0.073;
const JOIST_CHORD_D = 0.032;
/** open_web area factor: two double-angle chords + 15 % web rods (spec structural_section_profile). */
export const OPEN_WEB_K = 4.6;

/** K-series joist: depth (in), standard weight (lb/ft) → open_web section with the fitted chord thickness. */
function kJoists(rows: [string, number][]): SteelSection[] {
  return rows.map(([n, plf]) => {
    const depth = parseInt(n, 10) * IN;
    const area = (plf * 1.48816) / STEEL_DENSITY;
    const a = JOIST_CHORD_W / 2 + JOIST_CHORD_D;
    // OPEN_WEB_K · t · (a − t) = area
    const t = (a - Math.sqrt(a * a - (4 * area) / OPEN_WEB_K)) / 2;
    return {
      designation: n, standard: 'US' as const, family: 'K joist', shape: 'open_web' as const, grade: 'A36',
      size_x: JOIST_CHORD_W, size_y: r6(depth), flange: JOIST_CHORD_D, thickness: r6(t),
    };
  });
}

// SJI K-series standard weights (lb/ft)
const K_SERIES: [string, number][] = [
  ['8K1', 5.1], ['10K1', 5.0], ['12K1', 5.0], ['12K3', 5.7], ['12K5', 7.1], ['14K1', 5.2], ['14K3', 6.0], ['14K4', 6.7], ['14K6', 7.7],
  ['16K2', 5.5], ['16K3', 6.3], ['16K4', 7.0], ['16K5', 7.5], ['16K6', 8.1], ['16K7', 8.6], ['16K9', 10.0],
  ['18K3', 6.6], ['18K4', 7.2], ['18K5', 7.7], ['18K6', 8.5], ['18K7', 9.0], ['18K9', 10.2], ['18K10', 11.7],
  ['20K3', 6.7], ['20K4', 7.6], ['20K5', 8.2], ['20K6', 8.9], ['20K7', 9.3], ['20K9', 10.8], ['20K10', 12.2],
  ['22K4', 8.0], ['22K5', 8.8], ['22K6', 9.2], ['22K7', 9.7], ['22K9', 11.3], ['22K10', 12.6], ['22K11', 13.8],
  ['24K4', 8.4], ['24K5', 9.3], ['24K6', 9.7], ['24K7', 10.1], ['24K8', 11.5], ['24K9', 12.0], ['24K10', 13.1], ['24K12', 16.0],
  ['26K5', 9.8], ['26K6', 10.6], ['26K7', 10.9], ['26K8', 12.1], ['26K9', 12.2], ['26K10', 13.8], ['26K12', 16.6],
  ['28K6', 11.4], ['28K7', 11.8], ['28K8', 12.7], ['28K9', 13.0], ['28K10', 14.3], ['28K12', 17.1],
  ['30K7', 12.3], ['30K8', 13.2], ['30K9', 13.4], ['30K10', 15.0], ['30K11', 16.4], ['30K12', 17.6],
];

const cnTube = (h: number, b: number, t: number): [string, number, number, number] => [`□${h}x${b}x${t}`, h, b, t];

export const STEEL_SECTIONS: SteelSection[] = [
  ...iShapes('EN', 'HEA', 'S355', MM, HEA, 'i_shape', n => `HEA ${n}`),
  ...iShapes('EN', 'HEB', 'S355', MM, HEB, 'i_shape', n => `HEB ${n}`),
  ...iShapes('EN', 'IPE', 'S355', MM, IPE, 'i_shape', n => `IPE ${n}`),
  ...iShapes('EN', 'UPN', 'S275', MM, UPN, 'c_shape', n => `UPN ${n}`),
  ...rhs('EN', 'RHS', 'S355', MM, [
    enRhs(100, 50, 4), enRhs(100, 50, 5), enRhs(120, 60, 5), enRhs(150, 100, 6.3), enRhs(160, 80, 6.3), enRhs(200, 100, 8),
    enRhs(200, 100, 10), enRhs(250, 150, 8), enRhs(250, 150, 10), enRhs(300, 200, 10), enRhs(300, 200, 12.5), enRhs(400, 200, 12.5),
  ], 1.5),
  ...rhs('EN', 'SHS', 'S355', MM, [
    enRhs(60, 60, 5), enRhs(80, 80, 5), enRhs(100, 100, 5), enRhs(100, 100, 8), enRhs(120, 120, 6.3), enRhs(150, 150, 8),
    enRhs(200, 200, 10), enRhs(250, 250, 10), enRhs(300, 300, 12.5), enRhs(350, 350, 12.5), enRhs(400, 400, 16),
  ], 1.5),
  ...chs('EN', 'CHS', 'S355', MM, ([
    [48.3, 4], [60.3, 4], [76.1, 5], [88.9, 5], [114.3, 6.3], [139.7, 8], [168.3, 8], [219.1, 8], [219.1, 10],
    [273, 10], [323.9, 10], [355.6, 12.5], [406.4, 12.5], [508, 12.5],
  ] as [number, number][]).map(([d, t]) => [`CHS ${d}x${t}`, d, t] as [string, number, number])),
  ...angles('EN', 'S355', MM, ([
    [50, 5, 7], [60, 6, 8], [70, 7, 9], [80, 8, 10], [90, 9, 11], [100, 10, 12], [120, 12, 13], [150, 15, 16], [200, 20, 18],
  ] as [number, number, number][]).map(([a, t, r]) => [`L ${a}x${a}x${t}`, a, a, t, r] as [string, number, number, number, number])),
  ...iShapes('US', 'W', 'A992', IN, W),
  ...rhs('US', 'HSS rectangular', 'A500 Gr.C', IN, [
    usRhs(4, 4, '1/4'), usRhs(6, 6, '3/8'), usRhs(8, 8, '1/2'), usRhs(10, 10, '1/2'), usRhs(12, 12, '5/8'),
    usRhs(6, 4, '1/4'), usRhs(8, 4, '3/8'), usRhs(10, 6, '3/8'), usRhs(12, 8, '1/2'), usRhs(16, 8, '1/2'),
  ], 2),
  ...chs('US', 'HSS round', 'A500 Gr.C', IN, [
    usChs('4.000', '0.250'), usChs('6.625', '0.280'), usChs('8.625', '0.322'), usChs('10.750', '0.500'),
    usChs('12.750', '0.500'), usChs('16.000', '0.500'),
  ]),
  ...iShapes('US', 'C', 'A36', IN, C_US, 'c_shape'),
  ...angles('US', 'A36', IN, [
    ['L2X2X1/4', 2, 2, 0.25, 0.25], ['L3X3X1/4', 3, 3, 0.25, 0.25], ['L3X3X3/8', 3, 3, 0.375, 0.25],
    ['L4X4X3/8', 4, 4, 0.375, 0.375], ['L4X4X1/2', 4, 4, 0.5, 0.375], ['L5X5X1/2', 5, 5, 0.5, 0.375],
    ['L6X6X1/2', 6, 6, 0.5, 0.5], ['L6X6X5/8', 6, 6, 0.625, 0.5], ['L8X8X3/4', 8, 8, 0.75, 0.5],
    ['L4X3X3/8', 4, 3, 0.375, 0.375], ['L6X4X1/2', 6, 4, 0.5, 0.5],
  ]),
  ...iShapes('CN', 'HW', 'Q355', MM, HW),
  ...iShapes('CN', 'HM', 'Q355', MM, HM),
  ...iShapes('CN', 'HN', 'Q355', MM, HN),
  ...iShapes('CN', '[', 'Q235', MM, CN_CHANNEL, 'c_shape'),
  ...angles('CN', 'Q235', MM, ([
    [50, 5, 5.5], [63, 6, 7], [70, 7, 8], [75, 8, 9], [80, 8, 9], [90, 8, 10], [100, 10, 12], [110, 10, 12],
    [125, 10, 14], [140, 12, 14], [160, 14, 16], [180, 16, 16], [200, 16, 18],
  ] as [number, number, number][]).map(([a, t, r]) => [`L${a}x${t}`, a, a, t, r] as [string, number, number, number, number])),
  ...rhs('CN', '□', 'Q355', MM, [
    cnTube(100, 100, 5), cnTube(120, 120, 6), cnTube(150, 150, 6), cnTube(150, 150, 8), cnTube(200, 200, 8), cnTube(200, 200, 10),
    cnTube(250, 250, 10), cnTube(300, 300, 12), cnTube(400, 400, 16), cnTube(150, 100, 5), cnTube(200, 100, 6), cnTube(200, 150, 8),
    cnTube(300, 200, 8), cnTube(400, 200, 10),
  ], 2),
  ...chs('CN', 'Φ', 'Q355', MM, ([
    [89, 4], [114, 5], [133, 6], [159, 6], [219, 8], [273, 10], [325, 10], [377, 12], [426, 12],
  ] as [number, number][]).map(([d, t]) => [`Φ${d}x${t}`, d, t] as [string, number, number])),
  ...kJoists(K_SERIES),
];

export const SECTION_STANDARDS: SectionStandard[] = ['EN', 'US', 'CN'];

/** Families of a standard in library order. */
export function sectionFamilies(standard: SectionStandard): string[] {
  return [...new Set(STEEL_SECTIONS.filter(s => s.standard === standard).map(s => s.family))];
}

export function sectionsOf(standard: SectionStandard, family: string): SteelSection[] {
  return STEEL_SECTIONS.filter(s => s.standard === standard && s.family === family);
}

export function findSteelSection(designation: string): SteelSection | undefined {
  const k = designation.replace(/\s+/g, '').toUpperCase();
  return STEEL_SECTIONS.find(s => s.designation.replace(/\s+/g, '').toUpperCase() === k);
}


/** Type parameter values (column_type / beam_type) for a library section, in project units. */
export function sectionTypeValues(s: SteelSection, upm = 1): Record<string, string> {
  const v = (n: number | undefined) => (n === undefined ? '' : String(r6(n * upm)));
  return {
    material: 'steel', shape: s.shape,
    size_x: v(s.size_x), size_y: s.shape === 'round_hollow' ? '' : v(s.size_y),
    flange: v(s.flange), web: v(s.web), thickness: v(s.thickness), root_radius: v(s.root_radius),
    designation: s.designation, material_grade: s.grade,
  };
}
