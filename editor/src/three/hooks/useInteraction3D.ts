import { useEffect, useRef, useCallback } from 'react';
import { useThree } from '@react-three/fiber';
import { Raycaster, Vector2, type Object3D, type Intersection } from 'three';

import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { getToolHandler } from '../../tools/registry.ts';
import type { ToolContext } from '../../tools/types.ts';
import { useEditorState } from '../../state/EditorContext.tsx';

/**
 * Resolves an element ID from a raycast intersection.
 * Walks up the object tree looking for userData.elementId or userData.indexToId.
 */
function resolveElementId(intersection: Intersection): string | null {
  let obj: Object3D | null = intersection.object;
  while (obj) {
    if (obj.userData.indexToId && intersection.instanceId !== undefined) {
      return obj.userData.indexToId[intersection.instanceId] ?? null;
    }
    if (obj.userData.elementId) {
      return obj.userData.elementId as string;
    }
    obj = obj.parent;
  }
  return null;
}

interface UseInteraction3DOptions {
  toolCtx: ToolContext;
  hitElementIdRef: React.RefObject<string | null>;
  floorElevation: number;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  resizeDraggingRef: React.RefObject<boolean>;
}

/**
 * Left-click behavior:
 *
 * 1. Draw tool active → tool handles everything, no orbit
 * 2. Select tool active → selectTool handles everything (select, move, marquee), no orbit
 * 3. Resize handle drag → handled by ResizeHandles3D (skipped here)
 *
 * Middle = pan, right = dolly, scroll = zoom (always via OrbitControls)
 */
export function useInteraction3D({ toolCtx, hitElementIdRef, floorElevation: _floorElevation, controlsRef, resizeDraggingRef }: UseInteraction3DOptions) {
  const { camera, gl, scene } = useThree();
  const state = useEditorState();
  const stateRef = useRef(state);
  stateRef.current = state;

  const raycasterRef = useRef(new Raycaster());

  // Track whether our tool system owns the current gesture
  const toolOwnsGestureRef = useRef(false);

  const toNDC = useCallback((clientX: number, clientY: number): Vector2 => {
    const rect = gl.domElement.getBoundingClientRect();
    return new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }, [gl]);

  const findHitElementId = useCallback((ndc: Vector2): string | null => {
    raycasterRef.current.setFromCamera(ndc, camera);
    raycasterRef.current.params.Line = { threshold: 0.5 };
    const intersections = raycasterRef.current.intersectObjects(scene.children, true);
    for (const hit of intersections) {
      const id = resolveElementId(hit);
      if (id) return id;
    }
    return null;
  }, [camera, scene]);

  useEffect(() => {
    const canvas = gl.domElement;

    // We use capture phase to fire BEFORE OrbitControls.
    // This lets us disable orbit before it processes the event.

    const handlePointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (resizeDraggingRef.current) return;

      const tool = stateRef.current.activeTool;
      const isDrawTool = tool.startsWith('draw_');

      const ndc = toNDC(e.clientX, e.clientY);
      const elementId = findHitElementId(ndc);
      hitElementIdRef.current = elementId;

      if (isDrawTool || tool === 'select' || tool === 'relocate') {
        // Draw tools and select tool: take over gesture, disable orbit
        toolOwnsGestureRef.current = true;
        if (controlsRef.current) controlsRef.current.enabled = false;

        const handler = getToolHandler(tool);
        handler.onPointerDown?.(toolCtx, e as unknown as React.PointerEvent);
        return;
      }

      if (tool === 'orbit') {
        // Orbit tool: only take gesture if clicking an element; otherwise let OrbitControls handle it
        if (elementId) {
          toolOwnsGestureRef.current = true;
          if (controlsRef.current) controlsRef.current.enabled = false;
          const handler = getToolHandler(tool);
          handler.onPointerDown?.(toolCtx, e as unknown as React.PointerEvent);
        }
        return;
      }

      // pan/zoom tools: leave orbit enabled
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (resizeDraggingRef.current) return;
      const tool = stateRef.current.activeTool;
      if (tool === 'pan' || tool === 'zoom') return;

      if (toolOwnsGestureRef.current) {
        // Tool owns this gesture — route to tool handler
        const handler = getToolHandler(tool);
        handler.onPointerMove?.(toolCtx, e as unknown as React.PointerEvent);
      } else {
        // Not in a tool gesture — do hover detection only
        const ndc = toNDC(e.clientX, e.clientY);
        hitElementIdRef.current = findHitElementId(ndc);

        // Dispatch hover
        const handler = getToolHandler(tool);
        handler.onPointerMove?.(toolCtx, e as unknown as React.PointerEvent);
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (resizeDraggingRef.current) return;

      if (toolOwnsGestureRef.current) {
        const tool = stateRef.current.activeTool;
        const handler = getToolHandler(tool);
        handler.onPointerUp?.(toolCtx, e as unknown as React.PointerEvent);
      }

      toolOwnsGestureRef.current = false;

      // Re-enable orbit for next interaction
      if (controlsRef.current) controlsRef.current.enabled = true;
    };

    // capture: true ensures we fire before OrbitControls
    canvas.addEventListener('pointerdown', handlePointerDown, { capture: true });
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', handlePointerUp);

    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
    };
  }, [gl, camera, scene, toNDC, findHitElementId, toolCtx, hitElementIdRef, controlsRef]);

  // Keyboard shortcuts
  useEffect(() => {
    const stRef = stateRef;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      const dispatch = toolCtx.dispatch;

      switch (e.key) {
        case 'v': case 'V':
          if (!e.ctrlKey && !e.metaKey) dispatch({ type: 'SET_TOOL', tool: 'select' });
          break;
        case 'o': case 'O':
          if (!e.ctrlKey && !e.metaKey) dispatch({ type: 'SET_TOOL', tool: 'orbit' });
          break;
        case 'z': case 'Z':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            dispatch(e.shiftKey ? { type: 'REDO' } : { type: 'UNDO' });
          }
          break;
        case 'y': case 'Y':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            dispatch({ type: 'REDO' });
          }
          break;
        case 'Delete': case 'Backspace':
          if (stRef.current.selectedIds.size > 0) {
            dispatch({ type: 'DELETE_ELEMENTS', ids: Array.from(stRef.current.selectedIds) });
          }
          break;
        case 'Escape':
          if (stRef.current.activeTool === 'relocate') {
            dispatch({ type: 'SET_TOOL', tool: 'select' });
            dispatch({ type: 'SET_DRAWING_STATE', state: null });
            dispatch({ type: 'SET_DRAWING_TARGET', target: null });
          } else if (stRef.current.drawingState?.points.length) {
            dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
          } else if (stRef.current.activeTool.startsWith('draw_')) {
            dispatch({ type: 'SET_TOOL', tool: 'select' });
            dispatch({ type: 'SET_DRAWING_STATE', state: null });
            dispatch({ type: 'SET_DRAWING_TARGET', target: null });
          } else {
            dispatch({ type: 'CLEAR_SELECTION' });
          }
          break;
        case 'a': case 'A':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const s = stRef.current;
            if (s.document) {
              const allIds = Array.from(s.document.elements.keys()).map(id =>
                s.document!.levelId ? `${s.document!.levelId}:${id}` : id
              );
              dispatch({ type: 'SELECT', ids: allIds });
            }
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toolCtx.dispatch]);
}
