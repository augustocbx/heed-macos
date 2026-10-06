/** Model flags alone cannot establish that a listener is the Heed sidecar. */
export function isTranscriptionHealth(value:unknown):value is Record<string,any> {
 if(!value||typeof value!=='object')return false;
 const data=value as Record<string,unknown>;
 return data.service==='heed-transcription'&&data.protocolVersion===1&&typeof data.checkoutRoot==='string'&&data.checkoutRoot.length>0&&Number.isSafeInteger(data.pid)&&Number(data.pid)>0&&typeof data.whisper==='boolean'&&typeof data.pyannote==='boolean'&&typeof data.ready==='boolean';
}
