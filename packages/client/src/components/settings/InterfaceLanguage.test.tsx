import { tr } from "@/lib/i18n";
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
  fireEvent.change(screen.getByRole("combobox", {name:tr("Interface language")}),{target:{value:locale}});
  await waitFor(()=>expect(screen.getByRole("heading",{level:1})).toHaveTextContent(heading));
  expect(localStorage.getItem("heed-language")).toBe("pt");
 }
 expect(fetchMock.mock.calls.filter(([url])=>String(url).endsWith("/api/ui-locale"))).toHaveLength(4);
});
it("keeps the previous locale and shows an error when saving is rejected",async()=>{
 vi.stubGlobal("fetch",vi.fn(async(url:unknown)=>new Response(JSON.stringify(String(url).endsWith("/api/ui-locale") ? {error:"Unavailable"} : {controllerConnected:false}),{status:String(url).endsWith("/api/ui-locale") ? 503 : 200})));
 render(<PermissionsPage/>);
 fireEvent.change(screen.getByRole("combobox", {name:tr("Interface language")}),{target:{value:"fr"}});
 expect(await screen.findByRole("alert")).toHaveTextContent("Could not save interface language");
 expect(useLocaleStore.getState().locale).toBe("en");
});

vi.mock('@/api/automaticNotes', () => ({ automaticNotesApi: {
 settings: vi.fn(async () => ({ enabled: false, model: null, templateId: 'general', language: 'meeting' })),
 models: vi.fn(async () => ({ models: [] })),
} }));
vi.mock('@/api/templates', () => ({ templatesApi: { list: vi.fn(async () => [{ id: 'general', name: 'General', prompt: '' }]) } }));

vi.mock("./MeetingDetectionSettings", () => ({ MeetingDetectionSettings: () => null }));
vi.mock("@/api/storage",()=>({storageApi:{status:vi.fn(async()=>({limitBytes:2_000_000_000,usedBytes:0,reservedBytes:0,protectedBytes:0,reclaimableBytes:0,availableBytes:2_000_000_000,categories:{text:0,media:0,indexes:0,staging:0}}))}}));
vi.mock('./StorageLibrarySettings',()=>({StorageLibrarySettings:()=>null}));
