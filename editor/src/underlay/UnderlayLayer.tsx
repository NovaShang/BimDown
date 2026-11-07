import React, { useMemo } from 'react';
import { useCoreEditorState } from '../state/EditorContext.tsx';
import { useUnderlaySnapshot, useUnderlayStore } from './UnderlayContext.tsx';
import { assetKey, type AssetState } from './store.ts';
import { svgTransform } from './transform.ts';
import type { DxfDrawing } from './dxf.ts';

/** One screen pixel in plan units at --canvas-scale 1 (see Canvas uiScale). */
const PX_AT_SCALE_1 = 1 / 15;

/**
 * Underlays of the current level, drawn beneath every element layer and
 * never hit-tested. Zoom changes only touch CSS variables, so the (possibly
 * large) DXF paths are not re-rendered while panning or zooming.
 */
export default function UnderlayLayer() {
  const store = useUnderlayStore();
  const snap = useUnderlaySnapshot();
  const { currentLevel } = useCoreEditorState();
  if (!store) return null;
  const shown = snap.underlays.filter(u => u.levelId === currentLevel && u.visible);
  if (shown.length === 0) return null;
  return (
    <g className="underlay-layer" pointerEvents="none" transform="scale(1,-1)">
      {shown.map(u => {
        const placed = store.displayed(u);
        const asset = snap.assets.get(assetKey(u));
        return (
          <g
            key={u.id}
            data-underlay={u.id}
            transform={svgTransform(placed)}
            opacity={u.opacity}
            style={{ '--ul-px': PX_AT_SCALE_1 / placed.scale } as React.CSSProperties}
          >
            {asset && <UnderlayContent asset={asset} hiddenLayers={u.hiddenLayers.join(';')} />}
          </g>
        );
      })}
    </g>
  );
}

const UnderlayContent = React.memo(function UnderlayContent({ asset, hiddenLayers }: { asset: AssetState; hiddenLayers: string }) {
  if (asset.status !== 'ready') return null;
  if (asset.kind === 'dxf') return <DxfContent drawing={asset.drawing} hiddenLayers={hiddenLayers} />;
  // Raster local units: x right, y up, origin at the bottom-left corner.
  return (
    <image
      href={asset.url}
      x={0}
      y={0}
      width={asset.width}
      height={asset.height}
      preserveAspectRatio="none"
      transform={`matrix(1 0 0 -1 0 ${asset.height})`}
    />
  );
});

const STROKE = { strokeWidth: 'calc(var(--ul-px) * 1px / var(--canvas-scale, 1))' } as React.CSSProperties;

function round(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

const DxfContent = React.memo(function DxfContent({ drawing, hiddenLayers }: { drawing: DxfDrawing; hiddenLayers: string }) {
  // One path per layer
  const paths = useMemo(() => drawing.layers.map(layer => {
    const list = drawing.polylines.get(layer.name);
    if (!list) return { layer, d: '' };
    const parts: string[] = [];
    for (const pl of list) {
      let s = `M${round(pl[0])} ${round(pl[1])}`;
      for (let i = 2; i < pl.length; i += 2) s += `L${round(pl[i])} ${round(pl[i + 1])}`;
      parts.push(s);
    }
    return { layer, d: parts.join('') };
  }), [drawing]);
  const colorOf = useMemo(() => new Map(drawing.layers.map(l => [l.name, l.color])), [drawing]);
  const hidden = new Set(hiddenLayers ? hiddenLayers.split(';') : []);
  const { x: ox, y: oy } = drawing.origin;
  return (
    <g transform={`translate(${ox} ${oy})`}>
      {paths.map(({ layer, d }) => (d && !hidden.has(layer.name)
        ? <path key={layer.name} d={d} fill="none" stroke={layer.color} strokeLinecap="round" strokeLinejoin="round" style={STROKE} />
        : null))}
      {drawing.texts.map((t, i) => (hidden.has(t.layer) ? null : (
        <text
          key={i}
          transform={`translate(${round(t.x)} ${round(t.y)}) rotate(${round(t.rotation)}) scale(1 -1)`}
          fontSize={t.height}
          textAnchor={t.anchor}
          dominantBaseline={t.baseline}
          fill={colorOf.get(t.layer) ?? '#3f3f46'}
          textRendering="optimizeSpeed"
          style={{ fontFamily: 'sans-serif', whiteSpace: 'pre' }}
        >
          {t.text}
        </text>
      )))}
    </g>
  );
});
