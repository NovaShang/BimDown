import { useRef, useCallback, useMemo, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { Raycaster, Vector2, Vector3, Plane } from 'three';
import type { ToolContext, ToolStateSnapshot, TransformAction } from '../../tools/types.ts';
import type { EditorAction } from '../../state/editorTypes.ts';
import type { SnapResult } from '../../utils/snap.ts';
import { useEditorState, useEditorDispatch } from '../../state/EditorContext.tsx';

type ToolDispatchAction = EditorAction | TransformAction;

function isTransformAction(action: ToolDispatchAction): action is TransformAction {
  return action.type === 'SET_TRANSFORM' || action.type === 'ZOOM_BY'
    || action.type === 'ZOOM_TO_FIT' || action.type === 'ZOOM_TO_PERCENT';
}

/**
 * Provides a ToolContext that adapts 3D raycasting to the same interface
 * that 2D SVG tools expect. Tools work unchanged — only the coordinate
 * conversion layer differs.
 */
export function useToolContext3D(floorElevation: number) {
  const { camera, gl } = useThree();
  const state = useEditorState();
  const globalDispatch = useEditorDispatch();
  const stateRef = useRef(state);
  stateRef.current = state;

  // Ref that useInteraction3D writes into before invoking tools
  const hitElementIdRef = useRef<string | null>(null);

  const [activeSnap, setActiveSnap] = useState<SnapResult | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // Keep containerRef pointed at the canvas parent div
  if (!containerRef.current && gl.domElement.parentElement) {
    containerRef.current = gl.domElement.parentElement as HTMLDivElement;
  }

  // Dummy svgRef — only used by 2D marquee (we override via resolveMarquee)
  const svgRef = useRef<SVGSVGElement | null>(null);

  const raycasterRef = useRef(new Raycaster());
  const floorPlane = useMemo(() => new Plane(new Vector3(0, 1, 0), -floorElevation), [floorElevation]);

  // Convert screen (client) coords to model (x, y) via floor plane raycast
  const screenToSvg = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = gl.domElement.getBoundingClientRect();
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycasterRef.current.setFromCamera(ndc, camera);

    const intersection = new Vector3();
    const hit = raycasterRef.current.ray.intersectPlane(floorPlane, intersection);
    if (!hit) return null;

    // 3D coords (x, elev, z) → model coords (x, y) where model y = -z
    return { x: intersection.x, y: -intersection.z };
  }, [camera, gl, floorPlane]);

  // Find element ID — reads from the ref that useInteraction3D populates
  const findElementId = useCallback((_target: EventTarget | null): string | null => {
    return hitElementIdRef.current;
  }, []);

  // Dispatch: pass through EditorActions, ignore TransformActions
  const dispatch = useCallback((action: ToolDispatchAction) => {
    if (isTransformAction(action)) return; // OrbitControls handles camera
    globalDispatch(action);
  }, [globalDispatch]);

  const getState = useCallback((): ToolStateSnapshot => {
    const s = stateRef.current;
    return {
      transform: { x: 0, y: 0, scale: 1 }, // not used in 3D but satisfies interface
      selectedIds: s.selectedIds,
      hoveredId: s.hoveredId,
      drawingTarget: s.drawingTarget,
      drawingAttrs: s.drawingAttrs,
      drawingState: s.drawingState,
      document: s.document,
      project: s.project,
      grids: s.grids,
    };
  }, []);

  // Marquee selection in 3D: project element positions to screen space
  const resolveMarquee = useCallback((rect: { x: number; y: number; w: number; h: number }, containerRect: DOMRect): string[] => {
    const doc = stateRef.current.document;
    if (!doc) return [];

    const ids: string[] = [];
    const tempVec = new Vector3();
    const canvasRect = gl.domElement.getBoundingClientRect();

    for (const [id, el] of doc.elements) {
      // Get element center in model coords
      let cx: number, cy: number;
      if (el.geometry === 'line') {
        cx = (el.start.x + el.end.x) / 2;
        cy = (el.start.y + el.end.y) / 2;
      } else if (el.geometry === 'point') {
        cx = el.position.x;
        cy = el.position.y;
      } else if (el.geometry === 'polygon' && el.vertices.length > 0) {
        cx = el.vertices.reduce((s, v) => s + v.x, 0) / el.vertices.length;
        cy = el.vertices.reduce((s, v) => s + v.y, 0) / el.vertices.length;
      } else {
        continue;
      }

      // Model coords → 3D world: (cx, elevation, -cy)
      tempVec.set(cx, floorElevation, -cy);
      tempVec.project(camera);

      // NDC → screen-space relative to container
      const screenX = ((tempVec.x + 1) / 2) * canvasRect.width + canvasRect.left - containerRect.left;
      const screenY = ((-tempVec.y + 1) / 2) * canvasRect.height + canvasRect.top - containerRect.top;

      // AABB test against marquee
      if (
        screenX >= rect.x && screenX <= rect.x + rect.w &&
        screenY >= rect.y && screenY <= rect.y + rect.h
      ) {
        ids.push(id);
      }
    }
    return ids;
  }, [camera, gl, floorElevation]);

  const toolCtx = useMemo<ToolContext>(() => ({
    dispatch,
    svgRef,
    containerRef,
    getState,
    screenToSvg,
    findElementId,
    setSnap: setActiveSnap,
    resolveMarquee,
  }), [dispatch, getState, screenToSvg, findElementId, resolveMarquee]);

  // Flag for ResizeHandles3D to signal that it's handling a drag,
  // so the interaction layer should skip its own handling.
  const resizeDraggingRef = useRef(false);

  return { toolCtx, hitElementIdRef, activeSnap, setActiveSnap, resizeDraggingRef };
}
