import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { ChatThread, Session } from "@heed/shared";
import { MeetingChat } from "./MeetingChat";
import { chatApi } from "@/api/chat";
import { useLocaleStore } from "@/stores/locale";
vi.mock("@/api/chat",()=>({chatApi:{get:vi.fn(),models:vi.fn(),command:vi.fn()}}));
const session={id:"meeting-a",title:"Planning",transcriptRevision:"revision-a",transcriptFinalized:true} as Session;
const citation={id:"evidence-a",sessionId:"meeting-a",sourceRevision:"revision-a",segmentIndex:1,paragraphIndex:null,speaker:"Ana",quote:"Vamos revisar.",start:12,end:14};
const saved:ChatThread={sessionId:session.id,revision:"history-a",turns:[{id:"turn-a",requestId:"request-a",question:"Decision?",model:"local",sourceRevision:"revision-a",status:"completed",createdAt:"now",updatedAt:"now",attempts:1,answer:{claims:[{text:"Review was suggested.",citations:[citation]}],coverage:{complete:true,reviewedChunks:2,totalChunks:2,answerLimited:false}}}]};
beforeEach(()=>{vi.clearAllMocks();useLocaleStore.setState({locale:"en"});vi.mocked(chatApi.get).mockResolvedValue(saved);vi.mocked(chatApi.models).mockResolvedValue({models:["local"]});vi.mocked(chatApi.command).mockResolvedValue(saved);});

test("loads durable answers and navigates exact transcript citations",async()=>{
 const navigate=vi.fn();render(<MeetingChat session={session} onCitation={navigate}/>);
 expect(await screen.findByText("Review was suggested.")).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:/Ana/}));expect(navigate).toHaveBeenCalledWith(citation);
 expect(screen.getByText("Vamos revisar.")).toBeInTheDocument();
});

test("sends question independently from interface language and reuses request identity after transport failure",async()=>{
 vi.mocked(chatApi.command).mockRejectedValueOnce(new Error("network"));render(<MeetingChat session={session} onCitation={vi.fn()}/>);
 await screen.findByText("Review was suggested.");fireEvent.change(screen.getByLabelText("Local chat model"),{target:{value:"local"}});
 fireEvent.change(screen.getByLabelText("Question about this meeting"),{target:{value:"O orçamento foi aprovado?"}});fireEvent.click(screen.getByRole("button",{name:"Send question"}));
 await screen.findByRole("alert");fireEvent.click(screen.getByRole("button",{name:"Send question"}));await waitFor(()=>expect(chatApi.command).toHaveBeenCalledTimes(2));
 const first=vi.mocked(chatApi.command).mock.calls[0]![1];const second=vi.mocked(chatApi.command).mock.calls[1]![1];expect(first).toEqual(second);expect(first).toMatchObject({question:"O orçamento foi aprovado?",model:"local",expectedSourceRevision:"revision-a"});
});

test("stale and partial answers expose limits and cannot seek replacement source",async()=>{
 vi.mocked(chatApi.get).mockResolvedValue({...saved,turns:[{...saved.turns[0]!,stale:true,answer:{claims:[],coverage:{complete:false,reviewedChunks:2,totalChunks:9,answerLimited:false}}}]});
 render(<MeetingChat session={session} onCitation={vi.fn()}/>);
 expect(await screen.findByText("No supporting evidence found in the reviewed excerpts.")).toBeInTheDocument();expect(screen.getByText(/Reviewed 2 of 9/)).toBeInTheDocument();expect(screen.getByText(/This answer uses an older/)).toBeInTheDocument();
});

test("waiting turns can be cancelled and failed turns can be retried without appending a question",async()=>{
 vi.mocked(chatApi.get).mockResolvedValue({...saved,turns:[{...saved.turns[0]!,status:"waiting",answer:undefined}]});
 const view=render(<MeetingChat session={session} onCitation={vi.fn()}/>);fireEvent.click(await screen.findByRole("button",{name:"Cancel answer"}));await waitFor(()=>expect(chatApi.command).toHaveBeenCalledWith(session.id,{action:"cancel",turnId:"turn-a"}));
 view.unmount();vi.mocked(chatApi.get).mockResolvedValue({...saved,turns:[{...saved.turns[0]!,status:"failed",reason:"model-missing",answer:undefined}]});render(<MeetingChat session={session} onCitation={vi.fn()}/>);fireEvent.click(await screen.findByRole("button",{name:"Retry answer"}));await waitFor(()=>expect(chatApi.command).toHaveBeenCalledWith(session.id,{action:"retry",turnId:"turn-a"}));
});

test("a poll started during a save cannot overwrite the committed turn",async()=>{
 const {act}=await import("@testing-library/react");vi.useFakeTimers();
 let finishCommand:(value:ChatThread)=>void=()=>{};let finishPoll:(value:ChatThread)=>void=()=>{};
 vi.mocked(chatApi.command).mockImplementation(()=>new Promise(resolve=>{finishCommand=resolve;}));vi.mocked(chatApi.get).mockResolvedValueOnce(saved).mockImplementation(()=>new Promise(resolve=>{finishPoll=resolve;}));
 try{
  render(<MeetingChat session={session} onCitation={vi.fn()}/>);await act(async()=>{});
  fireEvent.change(screen.getByLabelText("Local chat model"),{target:{value:"local"}});fireEvent.change(screen.getByLabelText("Question about this meeting"),{target:{value:"New question?"}});fireEvent.click(screen.getByRole("button",{name:"Send question"}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  const newer={...saved,revision:"newer",turns:[...saved.turns,{...saved.turns[0]!,id:"turn-b",question:"New question?",status:"waiting" as const,answer:undefined}]};
  await act(async()=>{finishCommand(newer);});expect(screen.getByText("New question?")).toBeInTheDocument();
  await act(async()=>{finishPoll(saved);});expect(screen.getByText("New question?")).toBeInTheDocument();
 }finally{vi.useRealTimers();}
});

test("existing failure messages follow interface locale changes without altering meeting content",async()=>{
 const {act}=await import("@testing-library/react");vi.mocked(chatApi.models).mockRejectedValue(new Error("ollama-unavailable"));render(<MeetingChat session={session} onCitation={vi.fn()}/>);
 expect(await screen.findByRole("alert")).toHaveTextContent("Local chat unavailable.");
 act(()=>useLocaleStore.setState({locale:"fr"}));expect(screen.getByRole("alert")).toHaveTextContent("Discussion locale indisponible.");expect(screen.getByText("Review was suggested.")).toBeInTheDocument();
});


test("polling updates the active AI blocker without replacing saved history",async()=>{
 const {act}=await import("@testing-library/react");vi.useFakeTimers();
 try{
 const waiting = { ...saved.turns[0]!, id: "waiting-turn", question: "What changed?", status: "waiting" as const, answer: undefined, waitingReason: "tasks" as const };
 vi.mocked(chatApi.get).mockResolvedValue({...saved,turns:[saved.turns[0]!,waiting]});
 render(<MeetingChat session={session} onCitation={vi.fn()}/>);
 await act(async()=>{});
 expect(screen.getByText("Waiting for task suggestions to finish.")).toBeInTheDocument();
 expect(screen.queryByText("Chat becomes available after the final transcript is saved.")).not.toBeInTheDocument();
 vi.mocked(chatApi.get).mockResolvedValue({...saved,turns:[saved.turns[0]!,{...waiting,waitingReason:"recording" as const}]});
 await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
 expect(screen.getByText("Waiting for recording to finish.")).toBeInTheDocument();
 expect(screen.queryByText("Waiting for task suggestions to finish.")).not.toBeInTheDocument();
 expect(screen.getByText("Review was suggested.")).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:"Cancel answer"}));
 await act(async()=>{});
 expect(chatApi.command).toHaveBeenCalledWith(session.id,{action:"cancel",turnId:"waiting-turn"});
 }finally{vi.useRealTimers();}
});

const retrievalCoverage = {
  version: 1 as const,
  strategy: "lexical" as const,
  selectedMeetings: 1,
  selectedEvidence: 30,
  indexedMeetings: 1,
  indexedEvidence: 20,
  searchedMeetings: 1,
  searchedEvidence: 20,
  matchingRowsVisited: 4,
  matchedEvidence: 2,
  retrievedMeetings: 1,
  retrievedEvidence: 6,
  suppliedMeetings: 1,
  suppliedEvidence: 3,
  citedMeetings: 1,
  citedEvidence: 1,
  indexComplete: false,
  lookupComplete: false,
  generationComplete: false,
  partialReasons: [
    "index-missing",
    "context-budget",
  ] as import("@heed/shared").RetrievalPartialReason[],
};
test("versioned coverage keeps lexical zero hits qualified even if legacy complete is true", async () => {
  const retrieval = {
    ...retrievalCoverage,
    selectedMeetings: 1,
    indexedMeetings: 1,
    searchedMeetings: 1,
    indexedEvidence: 30,
    searchedEvidence: 30,
    matchingRowsVisited: 0,
    indexComplete: true,
    lookupComplete: true,
    matchedEvidence: 0,
    retrievedEvidence: 0,
    retrievedMeetings: 0,
    suppliedEvidence: 0,
    suppliedMeetings: 0,
    citedEvidence: 0,
    citedMeetings: 0,
    partialReasons: [],
  };
  vi.mocked(chatApi.get).mockResolvedValue({
    ...saved,
    turns: [
      {
        ...saved.turns[0]!,
        answer: {
          claims: [],
          coverage: {
            complete: true,
            reviewedChunks: 0,
            totalChunks: 0,
            answerLimited: false,
            retrieval,
          },
        },
      },
    ],
  });
  render(<MeetingChat session={session} onCitation={vi.fn()} />);
  expect(
    await screen.findByText(
      "No lexical matches found. This does not establish that the topic is absent from the selected transcripts.",
    ),
  ).toBeVisible();
  expect(screen.queryByText("Not found in this meeting.")).toBeNull();
  expect(screen.queryByText(/Reviewed .* transcript chunks/)).toBeNull();
  expect(
    screen.getByText(
      "Meetings: 1 selected · 1 indexed · 1 searched · 0 retrieved · 0 supplied · 0 cited.",
    ),
  ).toBeVisible();
});
test("partial unknown counts show specific limits and preserve escaped stale citation evidence", async () => {
  const retrieval = {
    ...retrievalCoverage,
    strategy: "fallback" as const,
    searchedEvidence: null,
    partialReasons: [
      "fallback-limit",
      "context-budget",
    ] as import("@heed/shared").RetrievalPartialReason[],
  };
  const quote = { ...citation, quote: "<img src=x onerror=alert(1)> João" };
  vi.mocked(chatApi.get).mockResolvedValue({
    ...saved,
    turns: [
      {
        ...saved.turns[0]!,
        stale: true,
        answer: {
          claims: [{ text: "Literal supported claim.", citations: [quote] }],
          coverage: {
            complete: false,
            reviewedChunks: 1,
            totalChunks: 4,
            answerLimited: false,
            retrieval,
          },
        },
      },
    ],
  });
  render(<MeetingChat session={session} onCitation={vi.fn()} />);
  expect(
    await screen.findByText(
      "Transcript excerpts: 30 selected · 20 indexed · unknown searched · 2 matched · 6 retrieved · 3 supplied · 1 cited.",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Fallback examined only a bounded part of the selected transcripts.",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(
      "The model context budget limited the supplied input. Ask a narrower question.",
    ),
  ).toBeVisible();
  expect(screen.getByText(quote.quote)).toBeInTheDocument();
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByRole("button", { name: /Ana/ })).toBeDisabled();
  expect(
    screen.queryByText(/Evidence was sampled across the recording/),
  ).toBeNull();
});
test("retrieval readiness stays cancellable and capacity failure is actionable", async () => {
  vi.mocked(chatApi.get).mockResolvedValue({
    ...saved,
    turns: [
      {
        ...saved.turns[0]!,
        status: "waiting",
        waitingReason: "retrieval",
        answer: undefined,
      },
    ],
  });
  const view = render(<MeetingChat session={session} onCitation={vi.fn()} />);
  expect(
    await screen.findByText(
      "Waiting for the local transcript catalog to become ready.",
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancel answer" }));
  await waitFor(() =>
    expect(chatApi.command).toHaveBeenCalledWith(session.id, {
      action: "cancel",
      turnId: "turn-a",
    }),
  );
  view.unmount();
  vi.mocked(chatApi.get).mockResolvedValue({
    ...saved,
    turns: [
      {
        ...saved.turns[0]!,
        status: "failed",
        reason: "retrieval-capacity",
        answer: undefined,
      },
    ],
  });
  render(<MeetingChat session={session} onCitation={vi.fn()} />);
  expect(
    await screen.findByText(
      "The local transcript catalog reached its capacity. Reduce the stored meeting collection and refresh chat.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry answer" })).toBeEnabled();
});

test.each(["retrieval-not-ready", "question-context-too-large"] as const)(
  "controlled %s errors retain refresh and retry controls",
  async (reason) => {
    vi.mocked(chatApi.get).mockResolvedValue({
      ...saved,
      turns: [
        { ...saved.turns[0]!, status: "failed", reason, answer: undefined },
      ],
    });
    render(<MeetingChat session={session} onCitation={vi.fn()} />);
    const expected =
      reason === "retrieval-not-ready"
        ? "Local transcripts are still being discovered. Wait, then refresh chat."
        : "This question or its required evidence exceeds the local model input budget. Ask a shorter or narrower question.";
    expect(await screen.findByText(expected)).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh chat" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Retry answer" })).toBeEnabled();
  },
);

test("empty generated answer describes supplied evidence, not retrieved excerpts omitted by context limits", async () => {
  vi.mocked(chatApi.get).mockResolvedValue({
    ...saved,
    turns: [
      {
        ...saved.turns[0]!,
        answer: {
          claims: [],
          coverage: {
            complete: false,
            reviewedChunks: 1,
            totalChunks: 4,
            answerLimited: false,
            retrieval: retrievalCoverage,
          },
        },
      },
    ],
  });
  render(<MeetingChat session={session} onCitation={vi.fn()} />);
  expect(
    await screen.findByText(
      "No supporting evidence found in the supplied excerpts.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByText(
      "No supporting evidence found in the retrieved excerpts.",
    ),
  ).toBeNull();
});
