import { createContext, useContext, useEffect, useState } from 'react'
import { dict } from './dict'

const STORAGE_KEY = 'oscenia-lang'
const DEFAULT_LANG = 'en'

const LanguageContext = createContext(null)

function getInitialLang() {
  if (typeof window === 'undefined') return DEFAULT_LANG
  const saved = window.localStorage.getItem(STORAGE_KEY)
  if (saved && dict[saved]) return saved
  // Fall back to the browser preference if it's Indonesian.
  const nav = window.navigator?.language?.toLowerCase() || ''
  if (nav.startsWith('id')) return 'id'
  return DEFAULT_LANG
}

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(getInitialLang)

  useEffect(() => {
    document.documentElement.lang = lang
    window.localStorage.setItem(STORAGE_KEY, lang)
  }, [lang])

  const setLang = (next) => {
    if (dict[next]) setLangState(next)
  }

  return (
    <LanguageContext.Provider value={{ lang, setLang, t: dict[lang] }}>
      {children}
    </LanguageContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useI18n() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useI18n must be used within LanguageProvider')
  return ctx
}
