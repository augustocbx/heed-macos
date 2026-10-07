import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRecordingStore } from "@/stores/recording";
import { recordingApi } from "@/api/recording";
import { setLocale } from "@/lib/i18n";
import { RecordingRecovery } from "./RecordingRecovery";
beforeEach(()=>{setLocale("en");useRecordingStore.getState().reset();useRecordingStore.setState({coordinatorMeetingId:"failed-meeting",coordinatorState:"failed",coordinatorPath:"audio.wav",coordinatorError:"ASR unavailable"});});
afterEach(()=>vi.restoreAllMocks());
it("exposes retry for retained audio and acknowledges only a backend saved session",async()=>{
  const session={id:"failed-meeting",title:"Recovered",createdAt:"2026-10-05",duration:9,language:"pt",transcript:"Olá",segments:[{speaker:"Ana",text:"Olá",start:1,end:2}],speakers:["Ana"],aiNotes:"",summary:"",tags:[],pinned:false,transcriptFinalized:true};
  vi.spyOn(recordingApi,"retry").mockResolvedValue({meetingId:"failed-meeting",state:"completed",revision:9,path:"audio.wav",startedAt:1,seconds:9,mode:"both",segments:session.segments,speakerNames:{},session,error:null,maintenance:false});
  render(<RecordingRecovery/>);expect(screen.getByRole("alert")).toHaveTextContent("Retained audio");
  await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Retry finalization"})));
  expect(useRecordingStore.getState().currentSessionId).toBe("failed-meeting");expect(screen.queryByRole("button",{name:"Retry finalization"})).toBeNull();
});
it("keeps retained audio retryable after a failed recovery",async()=>{
  vi.spyOn(recordingApi,"retry").mockRejectedValue(new Error("Still offline"));
  render(<RecordingRecovery/>);await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Retry finalization"})));
  expect(screen.getByRole("button",{name:"Retry finalization"})).toBeEnabled();expect(useRecordingStore.getState().coordinatorPath).toBe("audio.wav");expect(useRecordingStore.getState().currentSessionId).toBeNull();
});

it("preserves audio and leaves failed recovery after the backend acknowledges abandonment",async()=>{
 const reply={meetingId:null,state:"idle" as const,revision:10,path:null,startedAt:null,seconds:0,mode:"both" as const,segments:[],speakerNames:{},session:null,error:null,maintenance:false};
 vi.spyOn(recordingApi,"abandon").mockResolvedValue(reply);render(<RecordingRecovery/>);
 expect(screen.getByRole("alert")).toHaveTextContent("The audio stays available in Recovery.");
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Keep audio and leave recovery"})));
 expect(recordingApi.abandon).toHaveBeenCalledWith("failed-meeting");expect(useRecordingStore.getState()).toMatchObject({coordinatorState:"idle",coordinatorPath:null,coordinatorRevision:10,recording:false,processing:false});
});
it("failed abandonment leaves retained audio and retry controls available",async()=>{
 vi.spyOn(recordingApi,"abandon").mockRejectedValue(new Error("Storage unavailable"));render(<RecordingRecovery/>);
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"Keep audio and leave recovery"})));
 expect(screen.getByRole("alert")).toHaveTextContent("Could not leave recovery. The audio is still retained.");expect(screen.getByRole("button",{name:"Retry finalization"})).toBeEnabled();expect(useRecordingStore.getState().coordinatorPath).toBe("audio.wav");
});
it.each([["pt-BR","Manter áudio e sair da recuperação"],["fr","Conserver l’audio et quitter la récupération"],["de","Audio behalten und Wiederherstellung verlassen"]])("localizes the safe recovery exit in %s",(locale,label)=>{setLocale(locale as never);render(<RecordingRecovery/>);expect(screen.getByRole("button",{name:label})).toBeInTheDocument();});
it('transcript-only recovery requires explicit discard confirmation and cannot keep an archive',async()=>{useRecordingStore.setState({meetingMode:'transcript-only',audioCleanup:{status:'pending',requestedAt:'2026-10-07'}});vi.spyOn(recordingApi,'discard').mockResolvedValue({meetingId:null,state:'idle',revision:10,path:null,startedAt:null,seconds:0,mode:'both',segments:[],speakerNames:{},session:null,error:null,maintenance:false});render(<RecordingRecovery/>);expect(screen.queryByRole('button',{name:'Keep audio and leave recovery'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Discard temporary audio'}));expect(recordingApi.discard).not.toHaveBeenCalled();expect(screen.getByText(/unsaved meeting cannot be recovered/)).toBeInTheDocument();await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Confirm discard'})));expect(recordingApi.discard).toHaveBeenCalledWith('failed-meeting');});
