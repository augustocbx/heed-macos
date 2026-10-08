import type {AiFeature} from '../../../shared/types/ai';
import {fail,type AiCall} from './contracts';
/** Hosted-only byte policy. These are upload bounds, never token-fit or billing proofs.
 * Chat retains retrieval's 5,500-byte system/data budget. Notes/tasks use the
 * existing AI HTTP boundary's 64 KiB envelope for complete system/data input.
 * Schema and serialized vendor framing have independent budgets; nothing is truncated.
 */
export const AI_INPUT_BYTES=65_536;
export const AI_SCHEMA_BYTES=16_384;
export const AI_WIRE_BYTES=262_144;
export const AI_CHAT_WIRE_BYTES=32_768;
export function validateCallBytes(call:Readonly<AiCall>,feature?:AiFeature):void {
 let data:string,schema:string;
 try{data=JSON.stringify(call.data);schema=JSON.stringify(call.schema??{});}catch{return fail('invalid-request');}
 if(typeof data!=='string'||typeof call.system!=='string')return fail('invalid-request');
 const limit=feature==='chat'||feature==='library-chat'?5500:AI_INPUT_BYTES;
 if(Buffer.byteLength(call.system)+Buffer.byteLength(data)>limit||Buffer.byteLength(schema)>AI_SCHEMA_BYTES)return fail('request-too-large');
}
export function featureWireBytes(feature:AiFeature):number{return feature==='chat'||feature==='library-chat'?AI_CHAT_WIRE_BYTES:AI_WIRE_BYTES;}
