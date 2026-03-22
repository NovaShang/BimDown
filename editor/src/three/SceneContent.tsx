import { useRef, useEffect } from 'react';
import { OrbitControls, Bounds, useBounds, ContactShadows } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import FloorGroup from './FloorGroup.tsx';
import { useEditorState } from '../state/EditorContext.tsx';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { TOUCH, MOUSE } from 'three';

function TrackpadOrbitControls() {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const gl = useThree(s => s.gl);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };

    const canvas = gl.domElement;

    const handleWheel = (e: WheelEvent) => {
      // Pinch-to-zoom (ctrlKey) → let OrbitControls handle as zoom
      if (e.ctrlKey || e.metaKey) return;
      // Mouse wheel (line/page mode) or pure vertical scroll → let OrbitControls zoom
      if (e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) > 0)) return;
      // Trackpad two-finger scroll (pixel mode with deltaX) → pan
      e.preventDefault();
      e.stopPropagation();

      const camera = controls.object;
      const offset = camera.position.clone().sub(controls.target);
      const distance = offset.length();
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
      mouseButtons={{ LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.DOLLY }}
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
      requestAnimationFrame(() => bounds.refresh().clip().fit());
    }
  }, [currentLevel, bounds]);

  return null;
}

export default function SceneContent() {
  return (
    <>
      {/* APS-style lighting: strong ambient + multi-directional fills */}
      <ambientLight intensity={0.9} />
      <directionalLight position={[60, 100, 60]} intensity={1.2} color="#ffffff" />
      <directionalLight position={[-40, 60, -30]} intensity={0.4} color="#c4d4e8" />
      <directionalLight position={[0, -20, 40]} intensity={0.2} color="#e8e0d4" />
      <hemisphereLight args={['#dce8f5', '#a8b0b8', 0.5]} />

      <TrackpadOrbitControls />

      <Bounds fit clip margin={1.5}>
        <FitOnLevelChange />
        <FloorGroup />
      </Bounds>

      {/* Ground plane with contact shadows */}
      <ContactShadows
        position={[0, -0.01, 0]}
        opacity={0.35}
        scale={200}
        blur={2}
        far={50}
        color="#4a5568"
      />

      {/* Subtle ground grid */}
      <gridHelper args={[200, 100, '#c8cdd3', '#d8dce2']} />
    </>
  );
}
