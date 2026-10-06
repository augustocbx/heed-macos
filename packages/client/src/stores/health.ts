import { create } from "zustand";
import type { HealthResponse } from "@heed/shared";
import { healthApi } from "@/api/health.ts";

interface HealthState {
	health: HealthResponse;
 diagnosticsUnavailable:boolean;
	check: (refresh?:boolean) => Promise<void>;
}
let sequence=0;
export const useHealthStore = create<HealthState>((set) => ({
	health: { ollama: false, whisper: false, pyannote: false },
 diagnosticsUnavailable:false,
	check: async (refresh=false) => {
  const current=++sequence;
  let services:HealthResponse['services'];
		try {
   services=await healthApi.diagnostics(refresh);
   const health:HealthResponse=services.find(item=>item.service==='api')?.state==='ready'?await healthApi.check(refresh):{ollama:false,whisper:false,pyannote:false};
   if(!['ollama','whisper','pyannote'].every(key=>typeof health[key as keyof HealthResponse]==='boolean'))throw Error('Health unavailable');
   if(services.find(item=>item.service==='transcription')?.state!=='ready'){health.whisper=false;health.pyannote=false;health.whisper_info=null;health.pyannote_info=null;health.languages=undefined;}
   if(current===sequence)set({ health:{...health,services},diagnosticsUnavailable:false });
		} catch {
   if(current===sequence)set({ health: { ollama: false, whisper: false, pyannote: false,services },diagnosticsUnavailable:services===undefined });
		}
	},
}));
