import i18n from 'i18next';
import en from '../../i18n/en.json';
import zh from '../../i18n/zh.json';

export type DrawingLang = 'en' | 'zh';

/** Sheet language: explicit, else the UI language. */
export function drawingLang(lang?: string): DrawingLang {
  const l = lang || i18n.language || 'en';
  return l.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const dicts: Record<DrawingLang, Record<string, string>> = { en, zh };

/** A `drawing.*` (or other editor) string in the sheet language, falling back to English. */
export function drawingLabel(lang: DrawingLang, key: string, vars: Record<string, string> = {}): string {
  const s = dicts[lang][key] ?? dicts.en[key] ?? key;
  return s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}
