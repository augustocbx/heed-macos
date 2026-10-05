import { create } from "zustand";
import { normalizeLocale, storedLocale, type Locale } from "@/lib/locale.ts";
import { apiClient } from "@/api/client.ts";
let selectionGeneration = 0;
let selectionQueue:Promise<void> = Promise.resolve();
function persist(locale: Locale) {
 try {localStorage.setItem("heed-locale",locale);} catch { /* Server preference still persists. */ }
 if (typeof document !== "undefined") document.documentElement.lang = locale;
}
interface LocaleState {locale:Locale; refresh:()=>Promise<void>; select:(locale:Locale)=>Promise<void>; sync:(locale:unknown)=>void}
export const useLocaleStore = create<LocaleState>((set) => ({
 locale:storedLocale(),
 sync:(value) => {selectionGeneration++;const locale=normalizeLocale(value);persist(locale);set({locale});},
 refresh:async () => {
  const generation=selectionGeneration;
  try {const data=await apiClient.get<{locale:Locale}>("/api/ui-locale");if(generation===selectionGeneration){const locale=normalizeLocale(data.locale);persist(locale);set({locale});}} catch { /* Keep the local preference while the service reconnects. */ }
 },
 select:async (value) => {
  const locale=normalizeLocale(value);
  const generation=++selectionGeneration;
  // Serialize writes so a slower earlier choice cannot become the server preference.
  const pending=selectionQueue.then(()=>apiClient.post<{locale:Locale}>("/api/ui-locale",{locale}));
  selectionQueue=pending.then(()=>{},()=>{});
  const data=await pending;
  if(generation!==selectionGeneration) return;
  const chosen=normalizeLocale(data.locale);persist(chosen);set({locale:chosen});
 },
}));
