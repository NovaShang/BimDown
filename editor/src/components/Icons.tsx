import React from 'react';

export type IconName = 
  | 'select' | 'pan' | 'zoom' | 'undo' | 'redo'
  | 'eye-visible' | 'eye-hidden'
  | 'wall' | 'structure_wall' | 'column' | 'structure_column' | 'window'
  | 'door' | 'space' | 'slab' | 'structure_slab' | 'stair'
  | 'duct' | 'pipe' | 'equipment' | 'terminal' | 'conduit' | 'cable_tray'
  | 'beam' | 'brace' | 'grid';

interface IconProps extends React.SVGProps<SVGSVGElement> {
  name: IconName | string;
}

export function Icon({ name, width = 18, height = 18, strokeWidth = 1.4, ...props }: IconProps) {
  const Svg = ({ children, ...rest }: any) => (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={strokeWidth} {...rest} {...props}>
      {children}
    </svg>
  );

  switch (name) {
    // -------------------------------------------------------------
    // General UI Tools (Clean 2D for Usability)
    // -------------------------------------------------------------
    case 'select': return <Svg strokeDasharray="3 3"><path d="M4 4h16v16H4z" /></Svg>;
    case 'pan': return <Svg><path d="M9 11V5a2 2 0 0 1 4 0v6M13 11V7a2 2 0 0 1 4 0v4M17 11V9a2 2 0 0 1 4 0v6.5a7.5 7.5 0 0 1-15 0V11a2 2 0 0 1 4 0" /></Svg>;
    case 'zoom': return <Svg><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Svg>;
    case 'undo': return <Svg><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" /></Svg>;
    case 'redo': return <Svg><path d="M21 7v6h-6" /><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7" /></Svg>;
    case 'eye-visible': return <Svg><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></Svg>;
    case 'eye-hidden': return <Svg><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" /><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20" /></Svg>;

    // -------------------------------------------------------------
    // Revit-style Isometric 3D Elements
    // -------------------------------------------------------------
    case 'wall':
    case 'structure_wall':
      // Solid slanted block facing forward left
      return (
        <Svg strokeLinejoin="miter">
          <path d="M 6 8 L 14 11 L 17 9 L 9 6 Z" fill="currentColor" fillOpacity="0.05" />
          <path d="M 6 8 L 14 11 L 14 19 L 6 16 Z" fill="currentColor" fillOpacity="0.25" />
          <path d="M 6 8 L 9 6 L 9 14 L 6 16 Z" fill="currentColor" fillOpacity="0.4" />
        </Svg>
      );
      
    case 'column':
    case 'structure_column':
      // Upright cylinder
      return (
        <Svg>
          <ellipse cx="12" cy="6" rx="4" ry="2" fill="currentColor" fillOpacity="0.05" />
          <path d="M 8 6 V 18 A 4 2 0 0 0 16 18 V 6 Z" fill="currentColor" fillOpacity="0.25" />
        </Svg>
      );
      
    case 'space':
      // Transparent room volume over tiled floor
      return (
        <Svg>
          {/* Blue Floor */}
          <path d="M 4 16 L 12 20 L 20 16 L 12 12 Z" fill="#4B96FF" fillOpacity="0.4" stroke="none" />
          {/* White Tiles */}
          <path d="M 6 16 L 9 17.5 L 11 15.5 L 8 14 Z" fill="white" fillOpacity="0.5" stroke="none" />
          <path d="M 13 17.5 L 16 16 L 14 14 L 11 15.5 Z" fill="white" fillOpacity="0.5" stroke="none" />
          {/* Transparent Walls */}
          <path d="M 4 16 L 12 12 V 4 L 4 8 Z" fill="currentColor" fillOpacity="0.1" />
          <path d="M 12 12 L 20 16 V 8 L 12 4 Z" fill="currentColor" fillOpacity="0.2" />
        </Svg>
      );
      
    case 'stair':
      // 3-step solid stair block
      return (
        <Svg strokeLinejoin="miter">
          {/* Left Face (Profile) */}
          <path d="M 4 18 V 15 L 8 12.5 V 9.5 L 12 7 V 4 L 16 1.5 V 10.5 Z" fill="currentColor" fillOpacity="0.4" />
          {/* Treads */}
          <path d="M 4 15 L 10 18 L 14 15.5 L 8 12.5 Z" fill="currentColor" fillOpacity="0.05" />
          <path d="M 8 9.5 L 14 12.5 L 18 10 L 12 7 Z" fill="currentColor" fillOpacity="0.05" />
          <path d="M 12 4 L 18 7 L 22 4.5 L 16 1.5 Z" fill="currentColor" fillOpacity="0.05" />
          {/* Risers */}
          <path d="M 4 15 V 18 L 10 21 V 18 Z" fill="currentColor" fillOpacity="0.25" />
          <path d="M 8 9.5 V 12.5 L 14 15.5 V 12.5 Z" fill="currentColor" fillOpacity="0.25" />
          <path d="M 12 4 V 7 L 18 10 V 7 Z" fill="currentColor" fillOpacity="0.25" />
        </Svg>
      );

    case 'grid':
      // Tic-tac-toe grid with Revit bubble heads
      return (
        <Svg>
          <path d="M 8 10 H 20 M 8 16 H 20 M 12 6 V 20 M 18 6 V 20" />
          <circle cx="6" cy="10" r="2" />
          <circle cx="6" cy="16" r="2" />
          <circle cx="12" cy="4" r="2" />
          <circle cx="18" cy="4" r="2" />
        </Svg>
      );

    case 'beam':
      // Isometric I-Beam
      return (
        <Svg strokeLinejoin="miter">
          {/* Top Flange */}
          <path d="M 5 8 L 15 4 L 20 6 L 10 10 Z" fill="currentColor" fillOpacity="0.05" />
          <path d="M 5 8 L 10 10 V 12 L 5 10 Z" fill="currentColor" fillOpacity="0.25" />
          <path d="M 10 10 L 20 6 V 8 L 10 12 Z" fill="currentColor" fillOpacity="0.4" />
          {/* Web */}
          <path d="M 12 11 Z" />
          <path d="M 8 10 L 18 6 V 12 L 8 16 Z" fill="currentColor" fillOpacity="0.25" stroke="none" />
          <path d="M 12 11.2 L 18 8.8 V 14.8 L 12 17.2 Z" fill="currentColor" fillOpacity="0.3" />
          {/* Bottom Flange */}
          <path d="M 5 16 L 10 18 L 20 14 L 15 12 Z" fill="currentColor" fillOpacity="0.05" />
          <path d="M 5 16 L 10 18 V 20 L 5 18 Z" fill="currentColor" fillOpacity="0.25" />
          <path d="M 10 18 L 20 14 V 16 L 10 20 Z" fill="currentColor" fillOpacity="0.4" />
        </Svg>
      );

    case 'door':
      // Wall block with cutout and open panel
      return (
        <Svg strokeLinejoin="miter">
          {/* Main Wall Context */}
          <path d="M 4 10 L 16 16 L 18 15 L 6 9 Z" fill="currentColor" fillOpacity="0.05" />
          <path d="M 4 10 L 16 16 V 22 L 4 16 Z" fill="currentColor" fillOpacity="0.1" stroke="none" />
          
          {/* Left Wall Side */}
          <path d="M 4 10 L 8 12 V 18 L 4 16 Z" fill="currentColor" fillOpacity="0.25" />
          {/* Right Wall Side */}
          <path d="M 12 14 L 16 16 V 22 L 12 20 Z" fill="currentColor" fillOpacity="0.25" />
          {/* Header */}
          <path d="M 8 12 L 12 14 V 15 L 8 13 Z" fill="currentColor" fillOpacity="0.25" />
          
          {/* Door panel open out */}
          <path d="M 8 13 L 12 11 V 17 L 8 19 Z" fill="currentColor" fillOpacity="0.5" />
          {/* Swing arc */}
          <path d="M 12 21 C 10 22, 6 21, 8 19" strokeDasharray="2 2" />
        </Svg>
      );

    case 'window':
      // Wall with glass pane
      return (
        <Svg strokeLinejoin="miter">
          <path d="M 4 10 L 16 16 L 18 15 L 6 9 Z" fill="currentColor" fillOpacity="0.05" />
          <path d="M 4 10 L 16 16 V 22 L 4 16 Z" fill="currentColor" fillOpacity="0.2" />
          {/* Glass Pane */}
          <path d="M 9 13 L 13 15 V 19 L 9 17 Z" fill="#88ccff" fillOpacity="0.8" stroke="currentColor" strokeWidth={1} />
        </Svg>
      );

    case 'slab':
    case 'structure_slab':
      // Thick flat isometric plate
      return (
        <Svg strokeLinejoin="miter">
          <path d="M 2 11 L 12 6 L 22 11 L 12 16 Z" fill="currentColor" fillOpacity="0.05" />
          <path d="M 2 11 V 14 L 12 19 V 16 Z" fill="currentColor" fillOpacity="0.25" />
          <path d="M 12 19 V 16 L 22 11 V 14 Z" fill="currentColor" fillOpacity="0.4" />
        </Svg>
      );
    
    // -------------------------------------------------------------
    // MEP Elements (Isometric 3D)
    // -------------------------------------------------------------
    case 'duct':
      return (
        <Svg strokeLinejoin="miter">
          <path d="M 6 12 L 14 8 L 20 11 L 12 15 Z" fill="currentColor" fillOpacity="0.05" />
          <path d="M 6 12 V 16 L 12 19 V 15 Z" fill="currentColor" fillOpacity="0.25" />
          <path d="M 12 19 L 20 15 V 11 L 12 15 Z" fill="currentColor" fillOpacity="0.4" />
          <path d="M 12 15 L 20 15 M 12 19 L 20 11" strokeOpacity="0.3" strokeWidth={1} />
        </Svg>
      );
      
    case 'pipe':
      return (
        <Svg>
          <path d="M 5 13 L 17 6 Q 19 8 18 10 L 6 17 Q 4 15 5 13 Z" fill="currentColor" fillOpacity="0.25" />
          <ellipse cx="6" cy="15" rx="1.5" ry="2.5" transform="rotate(-30 6 15)" fill="currentColor" fillOpacity="0.4" />
        </Svg>
      );
      
    case 'conduit':
      return (
        <Svg>
          <path d="M 5 13 L 17 7 Q 18 8 17.5 9 L 5.5 15 Q 4.5 14 5 13 Z" fill="currentColor" fillOpacity="0.3" />
          <ellipse cx="5.25" cy="14" rx="0.5" ry="1.5" transform="rotate(-30 5.25 14)" fill="currentColor" fillOpacity="0.5" />
        </Svg>
      );
      
    case 'cable_tray':
      return (
        <Svg strokeLinejoin="miter">
          <path d="M 6 14 L 14 10 L 20 13 L 12 17 Z" fill="currentColor" fillOpacity="0.05" />
          <path d="M 6 14 V 11 L 12 8 V 11 Z" fill="currentColor" fillOpacity="0.25" />
          <path d="M 14 18 V 15 L 20 12 V 15 Z" fill="currentColor" fillOpacity="0.4" />
          <path d="M 6 14 V 11 L 12 14 V 17 Z" fill="currentColor" fillOpacity="0.15" />
        </Svg>
      );
      
    case 'equipment':
      return (
        <Svg strokeLinejoin="miter">
          <path d="M 4 13 L 12 9 L 20 13 L 12 17 Z" fill="currentColor" fillOpacity="0.05" />
          <path d="M 4 13 V 18 L 12 22 V 17 Z" fill="currentColor" fillOpacity="0.25" />
          <path d="M 12 22 L 20 18 V 13 L 12 17 Z" fill="currentColor" fillOpacity="0.4" />
          <path d="M 12 10.5 C 14 9.5, 16 11.5, 14 13.5 C 12 14.5, 10 12.5, 12 10.5 Z" fill="currentColor" fillOpacity="0.2" strokeOpacity="0.5" />
        </Svg>
      );
      
    case 'terminal':
      return (
        <Svg strokeLinejoin="miter">
          <path d="M 6 13 L 12 10 L 18 13 L 12 16 Z" fill="currentColor" fillOpacity="0.05" />
          <path d="M 6 13 V 15 L 12 18 V 16 Z" fill="currentColor" fillOpacity="0.25" />
          <path d="M 12 18 L 18 15 V 13 L 12 16 Z" fill="currentColor" fillOpacity="0.4" />
          <path d="M 8 13.5 L 12 11.5 L 16 13.5 L 12 15.5 Z" strokeOpacity="0.5" strokeWidth={1} />
          <path d="M 10 13.5 L 12 12.5 L 14 13.5 L 12 14.5 Z" strokeOpacity="0.5" strokeWidth={1} />
        </Svg>
      );

    case 'brace':
      return (
        <Svg strokeLinejoin="miter">
          <path d="M 5 21 L 9 19 L 19 5 L 15 7 Z" fill="currentColor" fillOpacity="0.05" />
          <path d="M 5 21 V 23 L 15 9 V 7 Z" fill="currentColor" fillOpacity="0.25" />
          <path d="M 15 9 L 19 7 V 5 L 15 7 Z" fill="currentColor" fillOpacity="0.4" />
        </Svg>
      );
      
    default:
      return (
        <Svg>
          <rect x="6" y="6" width="12" height="12" />
        </Svg>
      );
  }
}
