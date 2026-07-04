/**
 * Locale state (zustand) + the useT() hook every component consumes.
 */
import { create } from "zustand";
import { detectLocale, translate, type Locale } from "./messages";

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: detectLocale(),
  setLocale: (locale) => {
    try {
      localStorage.setItem("hotclip-locale", locale);
    } catch {
      /* persisting the choice is best-effort */
    }
    set({ locale });
  },
}));

/** Returns a t(key, params?) bound to one namespace and the current locale. */
export function useT(namespace: string): (key: string, params?: Record<string, string | number>) => string {
  const locale = useLocaleStore((s) => s.locale);
  return (key, params) => translate(locale, namespace, key, params);
}
