import { useTranslation } from 'react-i18next';
import { setTempHide, tempHideCss, useTempHide } from '../state/tempHide.ts';

/** Temporary hide / isolate in effect: its CSS, a cyan frame and a reset button (Revit's). */
export default function TempHideFrame() {
  const { t } = useTranslation();
  const th = useTempHide();
  if (!th) return null;
  return (
    <>
      <style>{tempHideCss(th)}</style>
      <div data-testid="temp-hide-frame" className="pointer-events-none absolute inset-1 z-10 rounded border-2 border-cyan-500/80">
        <button type="button" onPointerDown={e => e.stopPropagation()} onClick={() => setTempHide(null)}
          className="pointer-events-auto absolute left-1/2 top-1 -translate-x-1/2 cursor-pointer rounded border-none bg-cyan-600 px-2 py-0.5 text-[11px] font-medium text-white">
          {t('tempHide.active')} · {t('tempHide.reset')}
        </button>
      </div>
    </>
  );
}
