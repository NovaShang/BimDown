interface MarqueeSelectionProps {
  marquee: { x1: number; y1: number; x2: number; y2: number };
}

export default function MarqueeSelection({ marquee }: MarqueeSelectionProps) {
  const x = Math.min(marquee.x1, marquee.x2);
  const y = Math.min(marquee.y1, marquee.y2);
  const w = Math.abs(marquee.x2 - marquee.x1);
  const h = Math.abs(marquee.y2 - marquee.y1);

  if (w < 2 && h < 2) return null;

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        border: '1px solid var(--color-accent, #0891b2)',
        background: 'var(--accent-dim, rgba(8,145,178,0.12))',
        pointerEvents: 'none',
      }}
    />
  );
}
