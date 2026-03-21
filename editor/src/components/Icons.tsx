import React from 'react';

export type IconName = 
  | 'select' | 'pan' | 'zoom' | 'undo' | 'redo'
  | 'eye-visible' | 'eye-hidden'
  | 'wall' | 'structure_wall' | 'column' | 'structure_column' | 'window'
  | 'door' | 'space' | 'slab' | 'structure_slab' | 'stair'
  | 'duct' | 'pipe' | 'equipment' | 'terminal' | 'conduit' | 'cable_tray'
  | 'beam' | 'brace' | 'grid';

// Dynamically load all SVG files as raw strings
const svgModules = import.meta.glob('../assets/icons/*.svg', { eager: true, query: '?raw', import: 'default' });

const svgMap: Record<string, string> = {};
for (const path in svgModules) {
  const name = path.match(/\/([^/]+)\.svg$/)?.[1];
  if (name) {
    svgMap[name] = svgModules[path] as string;
  }
}

interface IconProps extends React.HTMLAttributes<HTMLSpanElement> {
  name: IconName | string;
  width?: number;
  height?: number;
  strokeWidth?: number;
}

export function Icon({ name, width = 22, height = 22, strokeWidth = 1.4, style, className = '', ...props }: IconProps) {
  const svgStr = svgMap[name] || svgMap['default'];
  
  return (
    <span
      className={`icon-wrapper ${className}`}
      dangerouslySetInnerHTML={{ __html: svgStr }}
      style={{
        display: 'inline-flex',
        width,
        height,
        '--icon-stroke-width': strokeWidth,
        ...style
      } as React.CSSProperties}
      {...props}
    />
  );
}
