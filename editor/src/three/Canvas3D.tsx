import { Canvas } from '@react-three/fiber';
import SceneContent from './SceneContent.tsx';

export default function Canvas3D() {
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Canvas
        shadows="soft"
        camera={{ position: [30, 40, 30], fov: 50, near: 0.1, far: 2000 }}
        gl={{ antialias: true, toneMapping: 4 /* ACESFilmicToneMapping */ }}
        raycaster={{ params: { Line: { threshold: 0.5 } } }}
      >
        <color attach="background" args={['#e8ecf1']} />
        <fog attach="fog" args={['#e8ecf1', 200, 600]} />
        <SceneContent />
      </Canvas>
    </div>
  );
}
