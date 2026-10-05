import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLocaleStore } from "./locale";
import { apiClient } from "@/api/client";
vi.mock("@/api/client",()=>({apiClient:{get:vi.fn(),post:vi.fn()}}));
beforeEach(()=>{vi.clearAllMocks();useLocaleStore.getState().sync("en");});
afterEach(()=>{useLocaleStore.getState().sync("en");});
it("persists the interface choice independently of transcription preferences",async()=>{
 localStorage.setItem("heed-language","pt");
 vi.mocked(apiClient.post).mockResolvedValue({locale:"de"});
 await useLocaleStore.getState().select("de");
 expect(apiClient.post).toHaveBeenCalledWith("/api/ui-locale",{locale:"de"});
 expect(localStorage.getItem("heed-locale")).toBe("de");expect(localStorage.getItem("heed-language")).toBe("pt");
});
it("serializes rapid choices and ignores an outdated response",async()=>{
 let resolveFirst!:(value:unknown)=>void;
 vi.mocked(apiClient.post).mockImplementationOnce(()=>new Promise(resolve=>{resolveFirst=resolve;})).mockResolvedValueOnce({locale:"fr"});
 const first=useLocaleStore.getState().select("de");
 const second=useLocaleStore.getState().select("fr");
 await Promise.resolve();
 expect(apiClient.post).toHaveBeenCalledTimes(1);
 resolveFirst({locale:"de"});await first;
 expect(useLocaleStore.getState().locale).not.toBe("de");
 await second;expect(useLocaleStore.getState().locale).toBe("fr");expect(apiClient.post).toHaveBeenCalledTimes(2);
});
it("a stale refresh cannot override a newer selection",async()=>{
 let resolveRead!:(value:unknown)=>void;
 vi.mocked(apiClient.get).mockImplementationOnce(()=>new Promise(resolve=>{resolveRead=resolve;}));
 const refresh=useLocaleStore.getState().refresh();
 vi.mocked(apiClient.post).mockResolvedValueOnce({locale:"pt-BR"});await useLocaleStore.getState().select("pt-BR");
 resolveRead({locale:"en"});await refresh;expect(useLocaleStore.getState().locale).toBe("pt-BR");
});
