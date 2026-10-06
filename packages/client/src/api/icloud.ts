export const ICLOUD_ISSUE_GUIDANCE={
 'unavailable':'Check iCloud sign-in, folder permissions, download status, cloud space and the local storage limit; then retry.',
 'account-unavailable':'Sign in to iCloud and enable iCloud Drive in macOS settings; then retry.',
 'account-changed':'The iCloud account changed. Restore the reviewed account or choose the folder again; keep the private pending copies.',
 'bookmark-stale':'Choose the iCloud folder again to renew access; keep the private pending copies.',
 'folder-unavailable':'Restore access to the reviewed iCloud folder; then retry without creating a replacement library.',
 'permission-denied':'Allow access to the reviewed iCloud folder in macOS settings or choose it again; then retry.',
 'hydration-pending':'Wait for iCloud to download the required files; then retry. Private pending copies stay protected.',
} as const;
export type ICloudIssue=keyof typeof ICLOUD_ISSUE_GUIDANCE;
export function icloudIssue(value:unknown):ICloudIssue {return typeof value==='string'&&Object.hasOwn(ICLOUD_ISSUE_GUIDANCE,value)?value as ICloudIssue:'unavailable';}
export class ICloudRequestError extends Error {constructor(readonly issue:ICloudIssue){super('iCloud operation unavailable');}}
async function failureIssue(response:Response):Promise<ICloudIssue>{
 const reader=response.body?.getReader();if(!reader)return 'unavailable';let size=0;const chunks:Uint8Array[]=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4096)return 'unavailable';chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||Object.keys(value).some(key=>!['issue','error'].includes(key)))return 'unavailable';return icloudIssue(value.issue);}catch{return 'unavailable';}finally{await reader.cancel().catch(()=>{});}
}
export interface ICloudSnapshot {issue?:ICloudIssue|null;recoveryRequired?:boolean;connection:{id:string;name:string;destinationId:string;enabled:boolean;pending:number;status:string;observations:Record<string,number>}|null;syncing:boolean;error:string|null;preview:{token:string;count:number;bytes:number}|null;remoteChecksumVerified:false;confirmation:'local-only'}
export interface ICloudSelection {receipt:string;needsCreation:boolean;status:string;confirmation:'local-only'}
export const icloudApi={async request<T=ICloudSnapshot>(body?:Record<string,unknown>):Promise<T>{const response=await fetch('/api/icloud',{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});if(!response.ok)throw new ICloudRequestError(await failureIssue(response));return response.json();}};
