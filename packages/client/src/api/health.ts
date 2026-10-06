import type { HealthResponse,ServiceDiagnostic } from "@heed/shared";
import { apiClient } from "./client.ts";

export const healthApi = {
	check: (refresh=false) => apiClient.get<HealthResponse>(`/api/health${refresh?'?refresh=1':''}`),
 diagnostics:async(refresh=false):Promise<ServiceDiagnostic[]>=>{
  // Same-origin UI diagnostics still work when the API port belongs to another app.
  const response=await fetch(`/.well-known/heed-services${refresh?'?refresh=1':''}`,{cache:'no-store',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw Error('Service diagnostics unavailable');
  const raw=await response.text();if(raw.length>8192)throw Error('Service diagnostics unavailable');
  const value=JSON.parse(raw);const roles=new Set<string>();
  if(!Array.isArray(value)||value.length!==3)throw Error('Service diagnostics unavailable');
  for(const item of value){
   if(!item||Object.keys(item).some(key=>!['service','port','state','application'].includes(key))||!['api','ui','transcription'].includes(item.service)||roles.has(item.service)||!Number.isInteger(item.port)||item.port<1||item.port>65535||!['ready','stopped','starting','unhealthy','conflict','unavailable'].includes(item.state)||item.application!==undefined&&(item.state!=='conflict'||typeof item.application!=='string'||!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(item.application)))throw Error('Service diagnostics unavailable');
   roles.add(item.service);
  }
  return value;
 },
};
