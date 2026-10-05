import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PermissionsPage } from "./PermissionsPage";
import { useLocaleStore } from "@/stores/locale";
beforeEach(()=>{useLocaleStore.getState().sync("en");});
afterEach(()=>{useLocaleStore.getState().sync("en");vi.unstubAllGlobals();});
it("changes interface language through settings while leaving transcription language unchanged",async()=>{
 localStorage.setItem("heed-language","pt");
 const fetchMock=vi.fn(async(url:unknown,init?:RequestInit)=>new Response(JSON.stringify(String(url).endsWith("/api/ui-locale") ? {locale:JSON.parse(String(init?.body)).locale} : {controllerConnected:true,pending:false,permissions:{microphone:"authorized",screenCapture:true,slackLogs:true,slackAutoRecord:true}})));
 vi.stubGlobal("fetch",fetchMock);
 render(<PermissionsPage/>);
 for(const [locale,heading] of [["pt-BR","Configurações"],["fr","Paramètres"],["de","Einstellungen"],["en","Settings"]]){
  fireEvent.change(screen.getByRole("combobox"),{target:{value:locale}});
  await waitFor(()=>expect(screen.getByRole("heading",{level:1})).toHaveTextContent(heading));
  expect(localStorage.getItem("heed-language")).toBe("pt");
 }
 expect(fetchMock.mock.calls.filter(([url])=>String(url).endsWith("/api/ui-locale"))).toHaveLength(4);
});
it("keeps the previous locale and shows an error when saving is rejected",async()=>{
 vi.stubGlobal("fetch",vi.fn(async(url:unknown)=>new Response(JSON.stringify(String(url).endsWith("/api/ui-locale") ? {error:"Unavailable"} : {controllerConnected:false}),{status:String(url).endsWith("/api/ui-locale") ? 503 : 200})));
 render(<PermissionsPage/>);
 fireEvent.change(screen.getByRole("combobox"),{target:{value:"fr"}});
 expect(await screen.findByRole("alert")).toHaveTextContent("Could not save interface language");
 expect(useLocaleStore.getState().locale).toBe("en");
});
