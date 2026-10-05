import { expect, test } from "bun:test";
import { automaticNotesSettings, validateNotesSettings } from "./notes-settings";

test("automatic generation is opt-in and preserves explicit preferences", () => {
 expect(automaticNotesSettings({})).toEqual({enabled:false,templateId:"general",model:null,language:"meeting"});
 expect(automaticNotesSettings({automatic_notes:{enabled:true,templateId:"custom",model:"local:1b",language:"pt"}})).toEqual({enabled:true,templateId:"custom",model:"local:1b",language:"pt"});
 expect(automaticNotesSettings({automatic_notes:{enabled:"true",model:"local:1b"}}).enabled).toBe(false);
});

test("enabling requires the selected installed local model and a complete template", () => {
 const chosen = {enabled:true,templateId:"custom",model:"local:1b",language:"meeting"};
 expect(() => validateNotesSettings(chosen, {id:"custom",prompt:"Summarize"}, ["local:1b"])).not.toThrow();
 expect(() => validateNotesSettings({...chosen,model:null}, {id:"custom",prompt:"Summarize"}, ["local:1b"])).toThrow();
 expect(() => validateNotesSettings(chosen, null, ["local:1b"])).toThrow();
 expect(() => validateNotesSettings(chosen, {id:"custom",prompt:"Summarize"}, [])).toThrow();
 expect(() => validateNotesSettings({...chosen,language:"auto"}, {id:"custom",prompt:"Summarize"}, ["local:1b"])).toThrow();
});

test("disabling works while Ollama or the selected template is unavailable", () => {
 expect(validateNotesSettings({enabled:false,templateId:"custom",model:"removed:1b",language:"fr"}, null, [])).toEqual({enabled:false,templateId:"custom",model:"removed:1b",language:"fr"});
 expect(() => validateNotesSettings({enabled:true,templateId:"../../outside",model:"local",language:"en"}, null, [])).toThrow();
});
