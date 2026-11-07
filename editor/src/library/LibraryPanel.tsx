/**
 * Component library: a toolbar slot that opens a searchable, categorized grid
 * of the built-in families (plan-symbol thumbnails, en/zh names). Picking one
 * starts placement in the `furniture` table; while placing, R / Shift+R rotate
 * by 90° and M mirrors.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useEditorDispatch, useEditorState } from '../state/EditorContext.tsx';
import { getDefaultDrawingAttrs } from '../model/drawingSchema.ts';
import { getElementModule } from '../elements/registry.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { Icon } from '../components/Icons.tsx';
import { cn } from '../lib/utils';
import {
  CATEGORY_LABELS, CATEGORY_ORDER, furnitureFamilies, furniturePlan, resolveFurniture,
  type FurnitureCategory, type FurnitureFamily,
} from './furnitureLibrary.generated.ts';
import { filterFamilies } from './search.ts';
import { renderPrims } from './FurnitureSymbol.tsx';
import { furniturePlacementAttrs } from '../elements/furniture.tsx';
import { SANITARY_STARTER_KEYS, getStarter, type EquipmentStarter } from '../elements/equipment_starters.ts';
import { STARTER_KEY_ATTR } from '../elements/equipment.tsx';
import { terminalSymbol } from '../mep/planSymbols.tsx';

/** Sanitary fixtures: MEP terminal templates (with their pipe ports) offered in the architecture library. */
const FIXTURES: EquipmentStarter[] = SANITARY_STARTER_KEYS.map(k => getStarter(k)!).filter(Boolean);
const FIXTURE_CATEGORY = 'sanitary';
const FIXTURE_LABEL = { en: 'Sanitary fixtures', zh: '卫浴洁具' };

function fixtureMatches(s: EquipmentStarter, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [s.key, s.label_en, s.label_zh, s.type_enum, 'sanitary plumbing fixture 卫浴 洁具'].some(x => x.toLowerCase().includes(q));
}

/** Plan-symbol thumbnail of a fixture (the MEP terminal symbol), fitted to a square. */
function FixtureThumb({ starter, size = 44 }: { starter: EquipmentStarter; size?: number }) {
  const { w, d } = starter.default_size;
  const s = Math.max(w, d) * 1.16;
  return (
    <svg width={size} height={size} viewBox={`${-s / 2} ${-s / 2} ${s} ${s}`} aria-hidden>
      <g transform="scale(1,-1)">{terminalSymbol(starter.type_enum, w, d, 'currentColor', 'var(--bg-input, #fff)')}</g>
    </svg>
  );
}

const TABLE = 'furniture';
const DISCIPLINE = 'architecture';

const pick = (o: { en: string; zh: string }, lang: string) => (lang.startsWith('zh') ? o.zh : o.en);

/** Plan-symbol thumbnail, fitted to a square. */
export function FamilyThumb({ family, size = 44 }: { family: FurnitureFamily; size?: number }) {
  const r = resolveFurniture({ family: family.id });
  const { w, d } = r.params;
  const pad = Math.max(w, d) * 0.08;
  const s = Math.max(w, d) + 2 * pad;
  return (
    <svg width={size} height={size} viewBox={`${-s / 2} ${-s / 2} ${s} ${s}`} aria-hidden>
      <g transform="scale(1,-1)">
        {renderPrims(furniturePlan(r), { stroke: 'currentColor', width: s / size, paper: 'var(--bg-input, #fff)' })}
      </g>
    </svg>
  );
}

/** R / Shift+R rotate, M mirrors the component being placed (capture phase, so
 *  the canvas shortcuts — R = room — don't fire). */
function usePlacementKeys(active: boolean, fixture = false) {
  const dispatch = useEditorDispatch();
  const attrs = useEditorState().drawingAttrs;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      // A fixture rotates with R (no mirror)
      if (fixture ? k !== 'r' : !getElementModule(TABLE)?.placeKeys?.includes(k.toUpperCase())) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const a = attrs;
      if (k === 'r') {
        const rot = (parseFloat(a.rotation || '0') || 0) + (e.shiftKey ? -90 : 90);
        dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...a, rotation: String(((rot % 360) + 360) % 360) } });
      } else {
        dispatch({ type: 'SET_DRAWING_ATTRS', attrs: { ...a, mirror: a.mirror === 'true' ? 'false' : 'true' } });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, fixture, attrs, dispatch]);
}

export default function LibraryButton({ disciplineColor }: { disciplineColor: string }) {
  const { t, i18n } = useTranslation();
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const [open, setOpen] = useState(false);
  // Tooltip always controlled (suppressed while the dropdown is open)
  const [tipOpen, setTipOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<FurnitureCategory | 'all' | typeof FIXTURE_CATEGORY>('all');
  const buttonRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const lang = i18n.language;

  const placing = state.drawingTarget?.tableName === TABLE && state.activeTool === 'draw_point';
  const placingFixture = state.drawingTarget?.tableName === 'terminal' && state.activeTool === 'draw_point'
    && SANITARY_STARTER_KEYS.includes(state.drawingAttrs[STARTER_KEY_ATTR] ?? '');
  usePlacementKeys(placing);
  usePlacementKeys(placingFixture, true);

  const families = useMemo(() => (category === FIXTURE_CATEGORY ? [] : filterFamilies(query, category)), [query, category]);
  const fixtures = useMemo(() => (category === 'all' || category === FIXTURE_CATEGORY ? FIXTURES.filter(f => fixtureMatches(f, query)) : []), [query, category]);
  const categories = useMemo(() => CATEGORY_ORDER.filter(c => furnitureFamilies().some(f => f.category === c)), []);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (r) setAnchor({ left: r.left + r.width / 2, bottom: window.innerHeight - r.top + 8 });
    };
    place();
    const outside = (e: MouseEvent) => {
      const n = e.target as Node;
      if (buttonRef.current?.contains(n) || panelRef.current?.contains(n)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', outside);
    window.addEventListener('resize', place);
    window.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      window.removeEventListener('resize', place);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);

  const startPlacing = (f: FurnitureFamily) => {
    const attrs = {
      ...getDefaultDrawingAttrs(TABLE, state.currentLevel, state.project?.levels),
      ...furniturePlacementAttrs(f.id),
      rotation: '0',
    };
    dispatch({ type: 'SET_TOOL', tool: 'draw_point' });
    dispatch({ type: 'SET_DRAWING_TARGET', target: { tableName: TABLE, discipline: DISCIPLINE } });
    dispatch({ type: 'SET_DRAWING_ATTRS', attrs });
    dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
    setOpen(false);
  };

  // A sanitary fixture is an MEP terminal with its ports (MEP connects it later).
  const startFixture = (f: EquipmentStarter) => {
    const attrs = {
      ...getDefaultDrawingAttrs('terminal', state.currentLevel, state.project?.levels),
      [STARTER_KEY_ATTR]: f.key,
      rotation: '0',
    };
    dispatch({ type: 'SET_TOOL', tool: 'draw_point' });
    dispatch({ type: 'SET_DRAWING_TARGET', target: { tableName: 'terminal', discipline: 'mep' } });
    dispatch({ type: 'SET_DRAWING_ATTRS', attrs });
    dispatch({ type: 'SET_DRAWING_STATE', state: { points: [], cursor: null } });
    setOpen(false);
  };

  const left = anchor ? Math.max(200, Math.min(anchor.left, window.innerWidth - 200)) : 0;

  return (
    <div ref={buttonRef} className="relative flex" data-testid="library-button">
      <Tooltip open={!open && tipOpen} onOpenChange={setTipOpen}>
        <TooltipTrigger
          className={cn(
            'flex h-auto w-11 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border-none py-1.5 transition-all',
            placing || open ? 'text-[var(--tool-color)]' : 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
          style={{
            '--tool-color': disciplineColor,
            background: placing || open ? `color-mix(in srgb, ${disciplineColor} 20%, transparent)` : undefined,
          } as React.CSSProperties}
          onClick={() => setOpen(o => !o)}
        >
          <span className="relative text-base leading-none"><Icon name="furniture" /></span>
          <span className="whitespace-nowrap text-[9px] leading-none">{t('library.button')}</span>
        </TooltipTrigger>
        <TooltipContent side="top">{t('library.tooltip')}</TooltipContent>
      </Tooltip>

      {open && anchor && createPortal(
        <div ref={panelRef} data-testid="library-panel"
          className="fixed z-50 flex w-[380px] max-w-[calc(100vw-1rem)] -translate-x-1/2 flex-col glass-panel rounded-xl border border-border shadow-[var(--shadow-panel)] animate-in fade-in slide-in-from-bottom-1 duration-150"
          style={{ left, bottom: anchor.bottom, maxHeight: `min(520px, calc(100vh - ${anchor.bottom + 16}px))` }}
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-3 pb-2 pt-2.5">
            <span className="text-[12px] font-semibold">{t('library.title')}</span>
            <span className="ml-auto text-[10px] text-muted-foreground">{t('library.count', { count: families.length + fixtures.length })}</span>
          </div>
          <div className="px-3 pt-2">
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { if (families[0]) startPlacing(families[0]); else if (fixtures[0]) startFixture(fixtures[0]); } }}
              placeholder={t('library.search')}
              className="h-7 w-full rounded-md border border-input bg-[var(--bg-input)] px-2 text-[12px] outline-none focus:border-[var(--color-accent)]"
              data-testid="library-search"
            />
          </div>
          <div className="flex flex-wrap gap-1 px-3 pt-2">
            {(['all', ...categories, FIXTURE_CATEGORY] as const).map(c => (
              <button key={c}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px] transition-colors',
                  category === c ? 'border-transparent text-white' : 'border-border text-muted-foreground hover:text-foreground',
                )}
                style={category === c ? { background: disciplineColor } : undefined}
                onClick={() => setCategory(c)}
              >
                {c === 'all' ? t('library.all') : c === FIXTURE_CATEGORY ? pick(FIXTURE_LABEL, lang) : pick(CATEGORY_LABELS[c], lang)}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-2">
            {families.length + fixtures.length === 0 ? (
              <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">{t('library.empty')}</div>
            ) : (
              <div className="grid grid-cols-4 gap-1">
                {families.map(f => {
                  const active = placing && state.drawingAttrs.family === f.id;
                  const [w, d, h] = f.size;
                  return (
                    <button key={f.id} data-family={f.id}
                      title={`${pick(f, lang)} — ${w}×${d}×${h} m`}
                      className={cn(
                        'flex flex-col items-center gap-1 rounded-lg border px-1 pb-1.5 pt-2 text-center transition-colors',
                        active ? 'border-[var(--tool-color)] bg-accent' : 'border-transparent hover:bg-accent',
                      )}
                      style={{ '--tool-color': disciplineColor } as React.CSSProperties}
                      onClick={() => startPlacing(f)}
                    >
                      <span className="text-foreground/75"><FamilyThumb family={f} /></span>
                      <span className="line-clamp-2 text-[10px] leading-tight">{pick(f, lang)}</span>
                    </button>
                  );
                })}
                {fixtures.map(f => {
                  const active = placingFixture && state.drawingAttrs[STARTER_KEY_ATTR] === f.key;
                  const { w, d } = f.default_size;
                  return (
                    <button key={`fx-${f.key}`} data-fixture={f.key}
                      title={`${lang.startsWith('zh') ? f.label_zh : f.label_en} — ${w}×${d} m · ${t('library.fixtureTip')}`}
                      className={cn(
                        'flex flex-col items-center gap-1 rounded-lg border px-1 pb-1.5 pt-2 text-center transition-colors',
                        active ? 'border-[var(--tool-color)] bg-accent' : 'border-transparent hover:bg-accent',
                      )}
                      style={{ '--tool-color': disciplineColor } as React.CSSProperties}
                      onClick={() => startFixture(f)}
                    >
                      <span className="text-foreground/75"><FixtureThumb starter={f} /></span>
                      <span className="line-clamp-2 text-[10px] leading-tight">{lang.startsWith('zh') ? f.label_zh : f.label_en}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="border-t border-border/60 px-3 py-1.5 text-[10px] text-muted-foreground">{t('library.hint')}</div>
        </div>,
        document.body,
      )}
    </div>
  );
}
