import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'
import zh from './zh.json'

const saved = localStorage.getItem('bimclaw-lang')
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

export default i18n
