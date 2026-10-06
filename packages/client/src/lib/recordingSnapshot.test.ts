import { beforeEach, expect, it } from "vitest";
import { useRecordingStore } from "@/stores/recording";
import type { RecordingSnapshot, Session } from "@heed/shared";
import { applyRecordingSnapshot } from "./recordingSnapshot";

const snapshot=(patch:Partial<RecordingSnapshot>={}):RecordingSnapshot=>({meetingId:"meeting-1",state:"recording",revision:1,startedAt:100,path:"test.wav",seconds:31,mode:"both",segments:[{id:1,speaker:"Me",text:"Preview",start:1,end:2,channel:"mic"}],speakerNames:{Me:"Ana"},session:null,error:null,maintenance:false,...patch});
beforeEach(()=>{useRecordingStore.getState().reset();useRecordingStore.setState({dismissedMeetingId:null});});
it("reattaches to elapsed time, live text and durable manual names",()=>{
  applyRecordingSnapshot(snapshot());
  expect(useRecordingStore.getState()).toMatchObject({recording:true,seconds:31,transcript:"Preview",speakerNames:{Me:"Ana"}});
});
it("shows finalization independently of actual recording",()=>{
  applyRecordingSnapshot(snapshot({state:"finalizing"}));
  expect(useRecordingStore.getState().recording).toBe(false);expect(useRecordingStore.getState().processing).toBe(true);
});
it("uses the backend saved session and never acknowledges provisional transcript as saved",()=>{
  const session={id:"meeting-1",duration:45,language:"pt",transcript:"Texto final",segments:[{speaker:"Ana",text:"Texto final",start:4,end:5}],speakers:["Ana"],files:{wav:"test.wav"},transcriptFinalized:true} as Session;
  applyRecordingSnapshot(snapshot({state:"completed",session,seconds:45}));
  expect(useRecordingStore.getState()).toMatchObject({currentSessionId:"meeting-1",transcript:"Texto final",seconds:45,resultLanguage:"pt",processing:false,recording:false});
});
it("late snapshots cannot overwrite a newer revision",()=>{
  applyRecordingSnapshot(snapshot({revision:6,seconds:36}));applyRecordingSnapshot(snapshot({revision:5,seconds:35}));
  expect(useRecordingStore.getState().seconds).toBe(36);
});
it("a delayed previous meeting cannot replace a newer active meeting",()=>{
  applyRecordingSnapshot(snapshot({revision:10}));
  applyRecordingSnapshot(snapshot({meetingId:"meeting-2",revision:20,seconds:12}));
  applyRecordingSnapshot(snapshot({state:"completed",revision:11}));
  expect(useRecordingStore.getState()).toMatchObject({coordinatorMeetingId:"meeting-2",coordinatorRevision:20,recording:true,seconds:12});
});
it("authoritative idle clears recovery in another tab and ignores a delayed failed reply",()=>{
  applyRecordingSnapshot(snapshot({state:"failed",revision:5,error:"Invalid audio"}));
  applyRecordingSnapshot(snapshot({state:"idle",meetingId:null,path:null,revision:6,segments:[],speakerNames:{}}));
  applyRecordingSnapshot(snapshot({state:"failed",revision:5,error:"Invalid audio"}));
  expect(useRecordingStore.getState()).toMatchObject({coordinatorMeetingId:null,coordinatorRevision:6,coordinatorState:"idle",coordinatorPath:null,recording:false,processing:false,transcript:""});
});
it("repeated completion polls preserve edits made to the saved result",()=>{
  const session={id:"meeting-1",title:"Meeting",createdAt:"2026-10-05",aiNotes:"",summary:"",tags:[],pinned:false,transcript:"done",segments:[],speakers:[],duration:8,language:"en",transcriptFinalized:true};
  const complete=snapshot({state:"completed",session});applyRecordingSnapshot(complete);
  useRecordingStore.setState({speakerNames:{"Speaker 1":"Ana"},notesText:"Edited notes"});applyRecordingSnapshot(complete);
  expect(useRecordingStore.getState().speakerNames).toEqual({"Speaker 1":"Ana"});expect(useRecordingStore.getState().notesText).toBe("Edited notes");
});
it("reset preserves an empty idle screen when the previous completed meeting is polled again",()=>{
  const complete=snapshot({state:"completed",session:{id:"meeting-1",title:"Meeting",createdAt:"2026-10-05",aiNotes:"",summary:"",tags:[],pinned:false,transcript:"done",segments:[],speakers:[],duration:8,language:"en",transcriptFinalized:true}});
  applyRecordingSnapshot(complete);useRecordingStore.getState().reset();applyRecordingSnapshot(complete);
  expect(useRecordingStore.getState().transcript).toBe("");expect(useRecordingStore.getState().seconds).toBe(0);
});
