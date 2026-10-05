# Heed — product strategy ideas

> Historical upstream strategy notes for Junior. Strategy first, code later. These are proposals, not a list of shipped features. Some take time; each describes the idea, its competitive rationale, and the refactoring work that could support it.

## Strategic context

The transcription market includes Granola, Otter, Fathom, Fireflies, Meetily, and Hyprnote. The original strategy identified three structural weaknesses in cloud-centered products:

1. **Cloud processing.** Meeting audio is sent to a provider's servers. This can limit adoption by lawyers, clinicians, therapists, financial professionals, executives, journalists protecting sources, and people handling confidential information. A local architecture offers a different approach.
2. **Bots or accounts.** A bot joining a meeting or an account requirement adds friction and a visible social signal.
3. **Provider-controlled data and paid features.** Users depend on the provider's storage, policies, and feature tiers.

Heed's proposed positioning takes the opposite approach: local processing, Apple Neural Engine transcription with Parakeet, FluidAudio diarization without a token, speaker recognition across sessions, no cloud account or meeting bot, and open source code. The strategy is to move from a meeting transcriber toward **private conversational memory that becomes more useful with use**.

The guiding principle is to create a different product category rather than compete only on cloud notes: privacy, user-controlled data, and local computing become the foundation.

---

## Tier 1 — capabilities that become more useful with use

These proposals create increasing value in the user's local archive. A local open source app cannot rely on a social-network moat, but it can make the user's own data more useful.

### 1. Personal voice identity graph: who, what, and when

Extend cross-session voice RAG into a private relationship graph. A recurring voice becomes a local contact with topics discussed, commitments made, the most recent conversation, and sentiment. Store it under `~/.heed-app`.

- **Competitive rationale:** a locally stored relationship history gives users control over sensitive conversational data.
- **Refactoring support:** append-only speaker turns provide the event history; stable voice identity provides the contact key. The graph can be computed from those events.

### 2. Semantic search across conversations, filtered by voice

Use local embeddings across transcript history. A question such as “What did Carlos promise about the budget?” searches by meaning, voice identity, date, and topic.

- **Competitive rationale:** combine cross-meeting semantic search with recognized speakers while keeping the archive local.
- **Supporting work:** voice RAG and the deterministic pipeline provide the inputs. The proposed experience is personal conversational search organized by person.

### 3. Retrospective processing with better models

Reprocess retained recordings with newer models: diarization, transcription, and voice recognition can improve without recording the meeting again.

- **Competitive rationale:** local compute can improve the archive without a provider charging for each processing run.
- **Supporting work:** engine ports/adapters in `engines.py`, tested pure functions from RF-7, and contract types from RF-1 provide replacement points.

---

## Tier 2 — local product differentiators

### 4. Live, on-device meeting assistant with Ollama and MCP

Extend local AI notes into a private assistant during the meeting: capture action items as they are agreed, remind users of commitments, identify unanswered questions or contradictory statements, and report speaking time.

- **Competitive rationale:** keep participant audio and live assistance on the user's machine, with no external API cost for inference.

### 5. Verifiable privacy

Go beyond a claim of local processing: provide network activity visibility, reproducible signed builds, and an audit mode that organizations can inspect. Explore professional audiences with confidentiality requirements.

- **Competitive rationale:** make privacy inspectable through architecture and evidence.
- **Proposed positioning:** emphasize that meeting content remains under the user's control. Legal and regulatory requirements would need their own assessment; local storage alone is not a compliance certification.

### 6. Capture with minimal friction

Provide a global shortcut, menu bar controls, meeting-app detection, one-action capture, and microphone-only capture for in-person conversations.

- **Supporting work:** ScreenCaptureKit capture and the meeting detector provide starting points. The remaining work includes user experience and platform-specific integration.

### 7. Heed as an MCP server

Expose the user's local meeting archive to Claude Desktop or another local assistant. Questions such as “What did the team decide about the launch?” could be answered from the local archive.

- **Competitive rationale:** make Heed a source of conversational infrastructure for other tools, with voice identity available as part of the archive.

---

## Tier 3 — longer-term proposals

### 8. Ambient conversational log

Explore always-on, low-power voice activity detection that transcribes only when it detects a real conversation, building a personal log locally.

- **Proposed positioning:** a personal conversational archive stored on the user's machine rather than a provider's server.

### 9. Device synchronization over a local network or private iCloud storage

Synchronize voices and transcripts between the user's devices over a LAN or end-to-end encrypted storage, without a Heed-operated server.

- **Competitive rationale:** offer multiple-device access while preserving user control over storage.

### 10. An archive whose value grows

Combine voice identity, relationship history, semantic search, retrospective processing, and optional ambient capture. Each retained conversation makes the user's archive more useful. The proposed advantage is value in data the user controls, rather than dependency on a provider holding it.

---

## Proposed sequence

1. **Before launch:** complete real-time voice enrollment and low-friction capture (#6).
2. **Immediately after launch:** develop verifiable privacy (#5) and explain it clearly to professional audiences.
3. **Next three to six months:** local semantic search (#2), voice identity graph (#1), and retrospective processing (#3).
4. **Ecosystem:** MCP access (#7) and the live assistant (#4).
5. **Longer term:** ambient capture (#8) and local device synchronization (#9).

## Why the refactoring work matters

These proposals are harder to build safely on large files with global mutable state and little test coverage. The refactoring introduced typed contracts, tests around pure diarization and voice logic, engine adapters, speaker-turn history, and process supervision. Those provide the seams for improving models, building search and identity features, and running long-lived capture without orphaned child processes.
