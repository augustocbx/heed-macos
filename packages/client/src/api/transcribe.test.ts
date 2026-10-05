import { afterEach, expect, it, vi } from "vitest";
import { transcribe } from "./transcribe";
afterEach(() => vi.unstubAllGlobals());
it("requests full recording recovery and waits for the detected-language session to save", async () => {
 const fetchMock = vi.fn().mockResolvedValue(new Response('event: result\ndata: {"text":"Bom dia","metadata":{"language":"pt"}}\n\n'));
 vi.stubGlobal("fetch", fetchMock);
 const onResult = vi.fn(async () => {});
 await transcribe({url:"audio.wav", language:"auto", diarize:true, recording_finalize:true}, {onResult});
 const form = fetchMock.mock.calls[0][1].body as FormData;
 expect(form.get("recording_finalize")).toBe("true");
 expect(onResult).toHaveBeenCalledWith(expect.objectContaining({metadata:{language:"pt"}}));
});
it("leaves recovery audio recoverable when session saving fails", async () => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('event: result\ndata: {"text":"Hello"}\n\n')));
 await expect(transcribe({url:"audio.wav",language:"auto",diarize:true,recording_finalize:true}, {onResult:async () => {throw new Error("Save failed");}})).rejects.toThrow("Save failed");
});
it("rejects recovery streams that end without the authoritative result", async () => {
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response('event: step\ndata: {"message":"Processing"}\n\n')));
 await expect(transcribe({url:"audio.wav",language:"auto",diarize:true,recording_finalize:true})).rejects.toThrow("without a final transcript");
});
