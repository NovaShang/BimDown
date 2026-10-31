import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const STORAGE_KEY = 'bim-tour-done';

interface TourStep {
  targetSelector: string;
  labelKey: string;
  position: 'top' | 'bottom' | 'left' | 'right';
}

const STEPS: TourStep[] = [
  { targetSelector: '[data-tour="topbar"]', labelKey: 'tour.step1', position: 'bottom' },
  { targetSelector: '[data-tour="toolbar"]', labelKey: 'tour.step2', position: 'top' },
  { targetSelector: '[data-tour="floors"]', labelKey: 'tour.step3', position: 'right' },
  { targetSelector: '[data-tour="viewbar"]', labelKey: 'tour.step4', position: 'top' },
];

export default function OnboardingTour() {
  const { t } = useTranslation();
  const [step, setStep] = useState(-1); // -1 = not started / dismissed
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Start tour if not done before
  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    // Delay to let the editor render first
    const timer = setTimeout(() => setStep(0), 800);
    return () => clearTimeout(timer);
  }, []);

  // Find target element rect for current step
  useEffect(() => {
    if (step < 0 || step >= STEPS.length) return;
    const el = document.querySelector(STEPS[step].targetSelector);
    if (el) {
      setRect(el.getBoundingClientRect());
    } else {
      setRect(null);
    }
  }, [step]);

  const finish = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, '1');
    setStep(-1);
  }, []);

  const next = useCallback(() => {
    if (step + 1 >= STEPS.length) {
      finish();
    } else {
      setStep(step + 1);
    }
  }, [step, finish]);

  // Keyboard: Enter → next, Escape → skip
  useEffect(() => {
    if (step < 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); next(); }
      if (e.key === 'Escape') { e.preventDefault(); finish(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [step, next, finish]);

  if (step < 0 || !rect) return null;

  const current = STEPS[step];
  const pad = 8;

  // Tooltip position relative to highlighted rect
  const tooltipStyle: React.CSSProperties = {};
  if (current.position === 'top') {
    tooltipStyle.left = rect.left + rect.width / 2;
    tooltipStyle.bottom = window.innerHeight - rect.top + pad;
    tooltipStyle.transform = 'translateX(-50%)';
  } else if (current.position === 'bottom') {
    tooltipStyle.left = rect.left + rect.width / 2;
    tooltipStyle.top = rect.bottom + pad;
    tooltipStyle.transform = 'translateX(-50%)';
  } else if (current.position === 'right') {
    tooltipStyle.left = rect.right + pad;
    tooltipStyle.top = rect.top + rect.height / 2;
    tooltipStyle.transform = 'translateY(-50%)';
  } else {
    tooltipStyle.right = window.innerWidth - rect.left + pad;
    tooltipStyle.top = rect.top + rect.height / 2;
    tooltipStyle.transform = 'translateY(-50%)';
  }

  return (
    <div className="fixed inset-0 z-[100]">
      {/* Semi-transparent overlay with cutout */}
      <svg className="absolute inset-0 h-full w-full" style={{ pointerEvents: 'auto' }}>
        <defs>
          <mask id="tour-mask">
            <rect width="100%" height="100%" fill="white" />
            <rect
              x={rect.left - pad} y={rect.top - pad}
              width={rect.width + pad * 2} height={rect.height + pad * 2}
              rx={12}
              fill="black"
            />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,0.5)" mask="url(#tour-mask)" />
      </svg>

      {/* Highlight ring */}
      <div
        className="absolute rounded-xl border-2 border-[var(--color-accent)] pointer-events-none transition-all duration-300"
        style={{
          left: rect.left - pad,
          top: rect.top - pad,
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
        }}
      />

      {/* Tooltip bubble */}
      <div
        className="absolute z-[101] w-64 glass-panel rounded-xl border border-border p-4 shadow-[var(--shadow-panel)] animate-in fade-in duration-200"
        style={tooltipStyle}
      >
        <p className="mb-3 text-[12px] leading-relaxed text-foreground">{t(current.labelKey)}</p>

        {/* Step dots */}
        <div className="mb-3 flex justify-center gap-1.5">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all ${i === step ? 'w-4 bg-[var(--color-accent)]' : 'w-1.5 bg-muted-foreground/30'}`}
            />
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between">
          <button
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            onClick={finish}
          >
            {t('tour.skip')}
          </button>
          <button
            className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-[11px] font-medium text-white hover:brightness-110 transition-all cursor-pointer"
            onClick={next}
          >
            {step + 1 >= STEPS.length ? t('tour.done') : t('tour.next')}
          </button>
        </div>
      </div>
    </div>
  );
}
