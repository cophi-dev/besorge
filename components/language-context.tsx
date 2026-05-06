"use client";

import { createContext, useContext } from "react";

export type AppLanguage = "en" | "de";

type LanguageContextValue = {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
};

export const LanguageContext = createContext<LanguageContextValue | null>(null);

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within LanguageContext.Provider");
  }
  return context;
}
