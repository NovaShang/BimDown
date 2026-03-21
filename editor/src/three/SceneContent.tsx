import { useRef, useEffect } from 'react';
import { OrbitControls, Bounds, useBounds } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import FloorGroup from './FloorGroup.tsx';
import { useEditorState } from '../state/EditorContext.tsx';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { TOUCH } from 'three';

function TrackpadOrbitControls() {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const gl = useThree(s => s.gl);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    // Configure touch: one finger orbit, two fingers pan
    controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };

    // Trackpad: remap two-finger scroll (wheel events) to pan instead of zoom.
    // Pinch-to-zoom still works because it fires wheel events with ctrlKey=true.
    const canvas = gl.domElement;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return; // pinch-to-zoom, let OrbitControls handle
      e.preventDefault();
      e.stopPropagation();

      // Manual pan: shift camera target + position
      const camera = controls.object;
      const offset = camera.position.clone().sub(controls.target);
      const distance = offset.length();

      // Scale pan speed by distance for consistent feel
      const panSpeed = distance * 0.001;
      const right = camera.up.clone().crossVectors(camera.up, offset).normalize();
      const up = offset.clone().cross(right).normalize();

      const panX = e.deltaX * panSpeed;
      const panY = -e.deltaY * panSpeed;

      const panDelta = right.multiplyScalar(panX).add(up.multiplyScalar(panY));
      controls.target.add(panDelta);
      camera.position.add(panDelta);
      controls.update();
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [gl]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      screenSpacePanning
      enableDamping
      dampingFactor={0.1}
    />
  );
}

function FitOnLevelChange() {
  const bounds = useBounds();
  const { currentLevel } = useEditorState();
  const prevLevel = useRef(currentLevel);

  useEffect(() => {
    if (currentLevel !== prevLevel.current) {
      prevLevel.current = currentLevel;
      // Delay to let geometry update first
      requestAnimationFrame(() => bounds.refresh().clip().fit());
    }
  }, [currentLevel, bounds]);

  return null;
}

export default function SceneContent() {
  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[50, 80, 50]} intensity={0.8} />
      <TrackpadOrbitControls />
      <Bounds fit clip margin={1.5}>
        <FitOnLevelChange />
        <FloorGroup />
      </Bounds>
      <gridHelper args={[200, 200, '#333333', '#2a2a2a']} />
    </>
  );
}
