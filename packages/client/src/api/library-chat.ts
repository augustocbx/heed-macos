import type {LibraryChatScope,LibraryChatContext,LibraryChatThread,ChatCommand,Session} from '@heed/shared';
import {apiClient} from './client';
export const libraryChatApi={
 context:(scope:LibraryChatScope)=>apiClient.post<LibraryChatContext>('/api/library-chat/context',{scope}),
 command:(scope:LibraryChatScope,command:ChatCommand)=>apiClient.post<LibraryChatThread>('/api/library-chat/command',{scope,command}),
 source:(scope:LibraryChatScope,snapshotKey:string,evidenceId:string)=>apiClient.post<Session>('/api/library-chat/source',{scope,snapshotKey,evidenceId}),
};
