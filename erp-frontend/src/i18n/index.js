import { useStore } from '../store/useStore'
import { dict } from './dict'

// useT() -> t(englishString) returns the active-language label.
// English is the source language; 'id' looks up the dictionary and
// falls back to the English string when a key is missing.
export function useT() {
  const lang = useStore((s) => s.lang)
  return (s) => {
    if (s == null) return s
    if (lang === 'en') return s
    return dict[lang]?.[s] ?? s
  }
}
