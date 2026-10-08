import {AiBudget} from './budget';
import type {AiConnections} from './connections';
import {AiPlanner} from './planning';
import {AiAuthorizations} from './authorization';
import {AiRuntime} from './runtime';
import type {AiAdapterRequest} from './contracts';
import type {AiResult} from '../../../shared/types/ai';
/** Both the server and authored checker use this private ledger and policy.
 * Resource admission remains unavailable until the owned runtime policy is installed.
 */
export function createAiInference(connections:AiConnections,generate?:(input:AiAdapterRequest)=>Promise<AiResult>){
 let budget:AiBudget|undefined;
 try{budget=new AiBudget({appDir:connections.appDir});}catch{/* Preserve private state for recovery; local operation does not require a ledger. */}
 const planner=new AiPlanner(connections,Date.now,budget??null),authorizations=new AiAuthorizations(planner);
 return {planner,authorizations,budget,runtime:new AiRuntime({planner,authorizations,connections,budget,generate})};
}
