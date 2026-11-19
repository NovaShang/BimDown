import fs from 'fs';
import path from 'path';

const g3d = (paths) => `<g stroke="currentColor" stroke-width="0.5" stroke-opacity="0.15">\n${paths}\n</g>`;

const map = {
  // 2D Tools (Inherits thick 1.4px stroke from CSS)
  'select': '<path d="M4 4h16v16H4z" stroke-dasharray="3 3"/>',
  'pan': '<path d="M9 11V5a2 2 0 0 1 4 0v6M13 11V7a2 2 0 0 1 4 0v4M17 11V9a2 2 0 0 1 4 0v6.5a7.5 7.5 0 0 1-15 0V11a2 2 0 0 1 4 0" />',
  'zoom': '<circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />',
  'undo': '<path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />',
  'redo': '<path d="M21 7v6h-6" /><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7" />',
  'eye-visible': '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />',
  'eye-hidden': '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20" />',
  
  // High-poly 3D Isometric Elements
  'wall': g3d(
    `<path d="M 6 18 L 16 13 V 5 L 6 10 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 6 18 L 2 16 V 8 L 6 10 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 6 10 L 2 8 L 12 3 L 16 5 Z" fill="currentColor" fill-opacity="0.2" />`
  ),
  'structure_wall': g3d(
    `<path d="M 6 18 L 16 13 V 5 L 6 10 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 6 18 L 2 16 V 8 L 6 10 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 6 10 L 2 8 L 12 3 L 16 5 Z" fill="currentColor" fill-opacity="0.2" />`
  ),
  'column': g3d(
    `<path d="M 8 6 V 16 A 4 2 0 0 0 16 16 V 6 Z" fill="currentColor" fill-opacity="0.85" />
<ellipse cx="12" cy="6" rx="4" ry="2" fill="currentColor" fill-opacity="0.2" />`
  ),
  'structure_column': g3d(
    `<path d="M 8 6 V 16 A 4 2 0 0 0 16 16 V 6 Z" fill="currentColor" fill-opacity="0.85" />
<ellipse cx="12" cy="6" rx="4" ry="2" fill="currentColor" fill-opacity="0.2" />`
  ),
  'space': g3d(
    `<path d="M 12 20 L 20 16 L 12 12 L 4 16 Z" fill="#4B96FF" fill-opacity="0.5" stroke="none" />
<path d="M 4 16 L 12 12 V 4 L 4 8 Z" fill="currentColor" fill-opacity="0.1" />
<path d="M 12 12 L 20 16 V 8 L 12 4 Z" fill="currentColor" fill-opacity="0.2" />
<path d="M 8 18 L 12 16 L 16 18 M 8 14 L 12 16 L 16 14" stroke="white" stroke-opacity="0.7" stroke-dasharray="2 2" fill="none" />`
  ),
  'stair': g3d(
    `<path d="M 22 18 V 15 L 18 13 V 10 L 14 8 V 5 L 10 3 V 12 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 22 15 L 14 19 L 10 17 L 18 13 Z" fill="currentColor" fill-opacity="0.2" />
<path d="M 18 10 L 10 14 L 6 12 L 14 8 Z" fill="currentColor" fill-opacity="0.2" />
<path d="M 14 5 L 6 9 L 2 7 L 10 3 Z" fill="currentColor" fill-opacity="0.2" />
<path d="M 22 18 L 14 22 V 19 L 22 15 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 18 13 L 10 17 V 14 L 18 10 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 14 8 L 6 12 V 9 L 14 5 Z" fill="currentColor" fill-opacity="0.5" />`
  ),
  'grid': `<path d="M 6 11 H 22 M 6 17 H 22 M 11 4 V 20 M 17 4 V 20" stroke="currentColor" stroke-width="1.2" />
<circle cx="5" cy="11" r="2.5" />
<circle cx="5" cy="17" r="2.5" />
<circle cx="11" cy="3" r="2.5" />
<circle cx="17" cy="3" r="2.5" />`,
  'beam': g3d(
    `<path d="M 8 10 L 4 8 L 14 3 L 18 5 Z" fill="currentColor" fill-opacity="0.2" />
<path d="M 8 10 L 4 8 V 10 L 8 12 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 8 10 L 18 5 V 7 L 8 12 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 8 12 L 18 7 V 14 L 8 19 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 8 19 L 18 14 V 16 L 8 21 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 8 19 L 4 17 V 19 L 8 21 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 7.5 19.25 L 17.5 14.25 L 18 14 L 8 19 Z" fill="currentColor" fill-opacity="0.2" />`
  ),
  'door': g3d(
    `<path d="M 6 18 L 8 17 V 11 L 6 12 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 12 15 L 16 13 V 7 L 12 9 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 6 12 L 16 7 V 5 L 6 10 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 6 18 L 2 16 V 8 L 6 10 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 6 10 L 2 8 L 12 3 L 16 5 Z" fill="currentColor" fill-opacity="0.2" />
<path d="M 12 15 L 8 13 V 7 L 12 9 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 8 11 L 4 9 L 8 7 L 12 9 Z" fill="currentColor" fill-opacity="0.2" />
<path d="M 8 17 L 10 20 V 14 L 8 11 Z" fill="currentColor" fill-opacity="0.6" />`
  ),
  'window': g3d(
    `<path d="M 6 18 L 16 13 V 11 L 6 16 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 6 16 L 8 15 V 11 L 6 12 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 12 13 L 16 11 V 7 L 12 9 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 6 12 L 16 7 V 5 L 6 10 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 8 15 L 4 13 L 8 11 L 12 13 Z" fill="currentColor" fill-opacity="0.2" />
<path d="M 12 13 L 8 11 V 7 L 12 9 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 10 14 L 14 12 V 8 L 10 10 Z" fill="#88CCFF" fill-opacity="0.8" stroke="currentColor" stroke-width="0.5" />
<path d="M 6 18 L 2 16 V 8 L 6 10 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 6 10 L 2 8 L 12 3 L 16 5 Z" fill="currentColor" fill-opacity="0.2" />`
  ),
  'slab': g3d(
    `<path d="M 12 20 L 20 16 V 14 L 12 18 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 12 20 L 4 16 V 14 L 12 18 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 12 18 L 4 14 L 12 10 L 20 14 Z" fill="currentColor" fill-opacity="0.2" />`
  ),
  'structure_slab': g3d(
    `<path d="M 12 20 L 20 16 V 14 L 12 18 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 12 20 L 4 16 V 14 L 12 18 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 12 18 L 4 14 L 12 10 L 20 14 Z" fill="currentColor" fill-opacity="0.2" />`
  ),
  'duct': g3d(
    `<path d="M 6 16 L 16 11 V 7 L 6 12 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 6 16 L 2 14 V 10 L 6 12 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 6 12 L 2 10 L 12 5 L 16 7 Z" fill="currentColor" fill-opacity="0.2" />
<path d="M 6 16 L 16 7 M 6 12 L 16 11" stroke="currentColor" stroke-opacity="0.3" stroke-width="0.5" />`
  ),
  'pipe': g3d(
    `<path d="M 5 15 L 15 10 A 3 2 0 0 0 15 6 L 5 11 A 3 2 0 0 1 5 15 Z" fill="currentColor" fill-opacity="0.85" />
<ellipse cx="5" cy="13" rx="3" ry="2" transform="rotate(-26.5 5 13)" fill="currentColor" fill-opacity="0.2" />`
  ),
  'conduit': g3d(
    `<path d="M 5 14.5 L 15 9.5 A 1.5 1 0 0 0 15 7.5 L 5 12.5 A 1.5 1 0 0 1 5 14.5 Z" fill="currentColor" fill-opacity="0.85" />
<ellipse cx="5" cy="13.5" rx="1.5" ry="1" transform="rotate(-26.5 5 13.5)" fill="currentColor" fill-opacity="0.2" />`
  ),
  'cable_tray': g3d(
    `<path d="M 6 14 L 16 9 V 7 L 6 12 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 6 14 L 2 12 V 10 L 6 12 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 6 12 L 2 10 L 12 5 L 16 7 Z" fill="currentColor" fill-opacity="0.2" />
<path d="M 2 10 L 12 5 V 3 L 2 8 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 12 5 L 16 7 V 5 L 12 3 Z" fill="currentColor" fill-opacity="0.5" />`
  ),
  'equipment': g3d(
    `<path d="M 6 16 L 16 11 V 5 L 6 10 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 6 16 L 2 14 V 8 L 6 10 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 6 10 L 2 8 L 12 3 L 16 5 Z" fill="currentColor" fill-opacity="0.2" />
<ellipse cx="10" cy="6.5" rx="3" ry="1.5" transform="rotate(26.5 10 6.5)" fill="currentColor" fill-opacity="0.5" />`
  ),
  'terminal': g3d(
    `<path d="M 6 16 L 12 13 V 12 L 6 15 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 6 16 L 2 14 V 13 L 6 15 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 6 15 L 2 13 L 8 10 L 12 12 Z" fill="currentColor" fill-opacity="0.2" />
<path d="M 5 14 L 9 12 M 4 13.5 L 8 11.5" stroke="currentColor" stroke-opacity="0.5" stroke-width="0.5" stroke-linecap="square" />`
  ),
  'brace': g3d(
    `<path d="M 4 20 L 8 18 L 18 6 L 14 8 Z" fill="currentColor" fill-opacity="0.85" />
<path d="M 4 20 L 4 16 L 14 4 L 14 8 Z" fill="currentColor" fill-opacity="0.5" />
<path d="M 4 16 L 8 14 L 18 2 L 14 4 Z" fill="currentColor" fill-opacity="0.2" />`
  ),
  'default': `<rect x="6" y="6" width="12" height="12" />`
};

const dir = path.join(process.cwd(), 'src', 'assets', 'icons');

for (const [name, content] of Object.entries(map)) {
  const linejoin = ['wall', 'structure_wall', 'stair', 'beam', 'door', 'window', 'slab', 'structure_slab', 'duct', 'cable_tray', 'equipment', 'terminal', 'brace'].includes(name) ? 'miter' : 'round';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="' + linejoin + '">\n' + content + '\n</svg>';
  fs.writeFileSync(path.join(dir, name + '.svg'), svg);
}

console.log('Premium CAD-style SVGs generated!');
