import type {ChatCommand,ChatTurn} from './chat';
export interface LibraryChatScope {mode:'labels'|'all';labels:string[];match:'any'|'all';}
export interface LibraryChatSource {sessionId:string;title:string;tags:string[];sourceRevision:string;}
export interface LibraryChatSnapshot {key:string;scope:LibraryChatScope;sources:LibraryChatSource[];}
export interface LibraryChatPreview {snapshot:LibraryChatSnapshot;ready:boolean;matchingCount:number;unavailableCount:number;availableLabels:string[];}
export interface LibraryChatTurn extends ChatTurn {snapshot:LibraryChatSnapshot;}
export interface LibraryChatThread {id:string;revision:string;scope:LibraryChatScope;turns:LibraryChatTurn[];}
export interface LibraryChatContext {preview:LibraryChatPreview;thread:LibraryChatThread;}
export type LibraryChatCommand=ChatCommand;
