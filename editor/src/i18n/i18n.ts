import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'
import zh from './zh.json'

// Only bootstrap when nobody else has initialized i18next yet. When the
// editor is consumed as a library (e.g. by the BimClaw web app), the host
// already calls .init() with its own merged resources; re-initializing
// here would wipe them out, leaving every UI string in the host as a
// bare i18n key. The host's i18n.ts is responsible for importing the
// editor's en.json / zh.json and merging them into its own resources.
if (!i18n.isInitialized) {
  const saved = localStorage.getItem('bimdown-lang')
  const detected = navigator.language.startsWith('zh') ? 'zh' : 'en'

  i18n.use(initReactI18next).init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
    },
    lng: saved || detected,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
}

export default i18n
