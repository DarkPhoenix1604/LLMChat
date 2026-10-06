# cf_ai_memory_chat — "Recall"

An AI chat assistant built entirely on Cloudflare that **remembers you**. Every conversation lives in its own Durable Object, replies stream from **Llama 3.3 70B on Workers AI**, and a **Cloudflare Workflow** runs in the background to distill the chat into long-term memory (a running summary plus a list of facts about the user). That memory is fed back into the system prompt on every turn.

You can also just **talk to it**. In voice conversation mode Recall listens hands-free, notices when you've finished speaking, answers out loud, and lets you interrupt it by talking over it. A pair of **animated robot eyes** gives it a face: they blink, glance away to think, nod while you talk, follow your cursor, and show the mood of what Recall is saying. Speech-to-text and text-to-speech both run on Workers AI (Deepgram Nova 3 and Aura 2). Typed replies render as Markdown with copyable code blocks, and a **Stop** button cuts any reply short.

## Stack

| Piece | How it's used |
| --- | --- |
| **LLM** | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on Workers AI. Used for streamed chat replies, and in JSON mode for memory extraction. |
| **Speech-to-text** | `@cf/deepgram/nova-3` on Workers AI transcribes voice conversation turns and dictation. |
| **Text-to-speech** | `@cf/deepgram/aura-2-en` on Workers AI speaks replies in voice conversation mode, streamed as MP3. |
| **Coordination** | A **Worker** routes the API. A **Durable Object** (`ChatSession`) coordinates each session. A **Workflow** (`MemoryWorkflow`) runs memory extraction as durable steps that are checkpointed and retried. |
| **Chat UI** | Plain HTML/CSS/JS modules (`public/`, no build step) served as Workers static assets. Tokens stream in over server-sent events and render as Markdown. Voice conversation mode does voice activity detection in the browser with an `AudioWorklet`, and draws Recall's eyes on a `<canvas>`. |
| **State** | Each `ChatSession` Durable Object stores the full transcript and the distilled memory in its built-in **SQLite** storage. |

## Architecture

```
Browser (public/app.js)
   │  POST /api/chat  (SSE stream back)
   ▼
Worker (src/index.ts) ──► ChatSession Durable Object (src/chat-session.ts)
                              │  SQLite: messages, memory
                              │  1. store user message
                              │  2. system prompt = persona + summary + facts
                              │  3. Workers AI (Llama 3.3), stream: true
                              │  4. relay stream → client, save reply when it ends
                              │     (or the partial reply, if the user pressed Stop)
                              │  5. every 6 messages → start MemoryWorkflow
                              ▼
                        MemoryWorkflow (src/memory-workflow.ts)
                          step 1: load conversation   (RPC → Durable Object)
                          step 2: distill memory       (Llama 3.3, JSON mode, 3 retries)
                          step 3: save memory          (RPC → Durable Object)
```

**Voice conversation mode** runs one turn like this. Everything after "you stop talking" is automatic:

```
mic ─► AudioWorklet ─► voice activity detection (browser)
        you stop talking for 1 s ─► 16 kHz WAV ─► POST /api/transcribe ─► Nova 3 ─► text
text ─► POST /api/chat { voice: true } ─► same Durable Object flow as above, short spoken-style reply
reply tokens ─► split at the first clause, then by sentence ─► GET /api/speak ─► Aura 2 MP3 ─► <audio>
talk over Recall ─► it pauses ─► your words are transcribed ─► reply stopped, yours sent
                                (or, if it was noise or Recall's own echo, it carries on)
```

Voice turns go through the same chat endpoint and Durable Object, so they're saved, shown as chat bubbles, and distilled into memory like typed messages. **Dictation** (the mic button) is the simpler version: one recording, transcribed into the message box so you can edit it before sending.

The session ID is a UUID generated in the browser and kept in `localStorage`. The Worker maps it to a Durable Object with `idFromName`, so reloading the page brings back both the transcript and the memory.

### API

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/chat` | `{ sessionId, message, voice? }` | `text/event-stream` from Workers AI, one `data: {...}` chunk per token. `voice: true` asks for a short reply meant to be read aloud. |
| `GET` | `/api/session` | `?sessionId=` | `{ messages, memory, workflow }` |
| `POST` | `/api/memory/refresh` | `{ sessionId }` | `202 { workflowId }` (starts the workflow right away), or `409` if the chat is empty |
| `POST` | `/api/transcribe` | WAV audio (`content-type: audio/wav`, up to 4 MB, about a minute) | `{ text }` |
| `GET` | `/api/speak` | `?text=` (up to 1000 characters) | `audio/mpeg`, streamed |
| `POST` | `/api/reset` | `{ sessionId }` | `{ ok: true }` |

The endpoints that call Workers AI are rate limited per IP. Per minute, `/api/chat` allows 20 requests, `/api/transcribe` 30, `/api/speak` 60 (a spoken reply is usually 2–3 clips), and `/api/memory/refresh` 5. Requests over the limit get a `429` with `Retry-After: 60`.

### How the eyes behave

The eyes in [`public/eyes.js`](public/eyes.js) are procedural, with nothing pre-animated. They're modelled on what research says about eyes in conversation:

| Behaviour | What the eyes do | Based on |
| --- | --- | --- |
| **Blinking** | Close in 80 ms, stay shut 60 ms, open in 150 ms. Every 2–6 s at rest and 1.5–3.5 s while speaking, but held back to every 5–9 s while you're talking. Recall blinks when you finish a sentence and at its own phrase boundaries; about 15% of blinks are double blinks. | Real blinks close in ~80 ms, stay shut 50–100 ms and open in ~150 ms. Blink rate rises in conversation (~26/min vs ~17/min at rest), driven by speaking. Listeners hold blinks while taking in speech and blink at the ends of sentences. |
| **Saccades** | Gaze jumps quickly between fixations, with small micro-saccades every 0.3–1.1 s in between. Big gaze shifts sometimes come with a blink. | Eyes are never perfectly still. Cozmo's eyes are "always shifting and in motion". |
| **Gaze aversion** | Looks up and away while thinking, sometimes searching to the other side. Glances away as it starts a reply and now and then mid-reply, then looks back at you to hand the turn over. Breaks eye contact briefly after 3–5 s of mutual gaze while listening. | People look up when thinking, look away when starting to speak and mid-speech to hold the floor, and use eye contact to give the turn back. Mutual gaze gets uncomfortable after 3–5 s. Agents that do this are seen as thinking and regulate turn-taking better. |
| **Expressions** | Built from eyelids and eye shape: wide when listening, narrowed when thinking, a raised lower lid (pupil-less "^") when happy, drooping outer lids when sad, bigger eyes and smaller pupils when surprised, a head tilt with one eye bigger when curious, heavy lids when sleepy. | Cozmo-style procedural faces with per-eye size, corners and upper and lower lids: narrowed when thinking, wide when looking at someone. RoboEyes moods. |
| **Tone** | The model starts each voice reply with a hidden `[mood]` tag, which sets the expression while Recall speaks (a keyword guess is the fallback). The eyes bounce slightly with Recall's voice, widen with yours, nod at your short pauses like a listener's "mm-hm", tilt when you ask a question, laugh when the reply laughs, and shake in confusion when Recall heard sound but no words. | Backchannel nods and listener blinks; RoboEyes "laugh" and "confused" animations. |
| **Pet mode** | From the original pet-eyes demo: pupils follow the pointer anywhere on the page. When the pointer is far to one side, the eye on that side grows ("curiosity"). A click boops Recall (happy, or wakes it up). After 8 s of silence it looks around, after 40 s it gets sleepy, and after 75 s it falls asleep with drifting z's until you talk or click. | RoboEyes curiosity, idle and auto-blink modes. |

Motion respects `prefers-reduced-motion`, which turns off nods, shakes and bounces. Research sources: [blink timing](https://abratabia.com/ai-talking-characters/facial-animation.php), [blinking while speaking vs listening](https://pmc.ncbi.nlm.nih.gov/articles/PMC8500445/), [conversational gaze aversion for virtual agents (Andrist et al.)](https://peopleandrobots.wisc.edu/publications/conversational-gaze-aversion-for-virtual-agents-inproceedings/), [gaze aversion for robots](https://spectrum.ieee.org/what-robot-behavior-makes-people-feel-uncomfortable), [Cozmo's procedural face](https://pycozmo.readthedocs.io/en/latest/external/offboard_functions.html), [Anki's animation approach](https://www.designnews.com/electronics-test/cozmo-vector-how-anki-designs-robots-emotional-intelligence), [FluxGarage RoboEyes](https://github.com/FluxGarage/RoboEyes).

## Running it

**Requirements:** Node.js 18+ and a Cloudflare account. Workers AI has a free tier. Workers AI always runs remotely, so you need to log in even for local dev.

```bash
npm install
npx wrangler login      # needed for Workers AI, even in local dev
npm run dev             # http://localhost:8787
```

### Deploy

```bash
npm run deploy
```

Wrangler creates the Worker, the Durable Object namespace (SQLite-backed), and the Workflow, then prints your `*.workers.dev` URL.

### Try it

1. Open the app and introduce yourself: *"Hi, I'm Sam. I'm building a Rust game engine and I prefer short answers."*
2. Chat for a few turns. After 6 messages the **Memory** panel shows `workflow: running`, then `complete`, and fills in a summary and facts. You can also click **Update memory now**.
3. Ask *"What do you remember about me?"* or *"What should I work on next?"*. The reply uses the distilled memory.
4. Reload the page. The conversation and memory are still there, because they live in the Durable Object.
5. Ask for some code. The reply renders as Markdown, and code blocks have a **Copy** button. Ask for something long and press **Stop** partway: the partial reply stays, and that's what gets saved.
6. Click the **waveform** button (or **Start a voice conversation** on a new chat) and just talk. Recall's eyes show what it's doing. Move the mouse and they follow it, click them for a "boop", double-click to make them take over the chat column, or stay quiet for a minute and watch them fall asleep. Pause when you're done and Recall answers out loud. Talk over it to interrupt. **End** or Esc stops. The browser asks for microphone access the first time, and voice only works on `localhost` or HTTPS. Headphones work best; with laptop speakers, echo cancellation and an echo check stop Recall from interrupting itself.
7. The **mic** button is dictation: click, talk, click again, and the transcript lands in the message box.
8. **New chat** clears the session.

Other useful commands: `npm run typecheck` checks types, and `npm run types` regenerates `worker-configuration.d.ts` after you edit `wrangler.jsonc`.

## Project layout

```
src/
  index.ts            Worker entry: API routing and validation; exports the DO and Workflow classes
  chat-session.ts     ChatSession Durable Object: SQLite state, streaming LLM chat, starts the workflow
  memory-workflow.ts  MemoryWorkflow: load → distill with the LLM → save, each a durable step
  llm.ts              Model id, system prompt builder, SSE token parser
  voice.ts            Speech-to-text (Nova 3) and text-to-speech (Aura 2)
public/
  index.html, styles.css   Page and styles (light and dark)
  app.js              Chat UI: streaming, Stop, memory panel, dictation, starter chips
  conversation.js     Voice conversation mode: voice activity detection, spoken replies, barge-in
  eyes.js             Recall's animated eyes: blinks, gaze, expressions, mood, pet interactions
  markdown.js         Small Markdown renderer that builds DOM nodes (no innerHTML)
  voice.js            Microphone recording, WAV encoding, transcription upload
wrangler.jsonc        Bindings: AI, Durable Object + migration, Workflow, rate limiters, static assets
```

## Design notes

- **Short-term and long-term memory are separate.** Only the last 20 messages go to the model verbatim. Older context reaches it through the workflow-maintained summary and facts, so prompts stay bounded however long the chat gets.
- **Why a Workflow for memory?** Extraction is a slow, multi-step LLM job that can fail. Running it as a Workflow keeps it off the chat's critical path, retries the LLM step with exponential backoff, and checkpoints each step so a retry doesn't reload or rewrite state.
- **Streaming and persistence together.** The Durable Object relays the Workers AI stream to the browser through its own `ReadableStream`, collecting the text as it goes, and saves the reply when the stream ends. If the browser cancels (Stop, or a closed tab), the cancel propagates back through the Worker. The Durable Object then cancels generation, which saves tokens, and stores the partial reply. Because of that round trip, the saved text can run a few words past where the user pressed Stop.
- **Token parsing.** Each Workers AI chunk carries the token twice: as an OpenAI-style `choices[0].delta.content` and as `response`. Both parsers read the delta, because `response` turns numeric tokens into JSON numbers, so the "1" of a numbered list would arrive as `1` and get dropped.
- **Safety.** Session IDs, message lengths, and audio uploads are validated at the edge. The Markdown renderer builds DOM nodes directly, so it only creates text nodes and a fixed set of elements. It never uses `innerHTML`, and only `http(s)` URLs become links, so model output can't inject HTML or `javascript:` links.
- **Voice in WAV.** Browsers record in different formats (WebM in Chrome, MP4 in Safari, Ogg in Firefox). Instead of sending those to the server, the browser converts audio to 16 kHz mono WAV, so the server only ever sees one format, and a minute of audio stays under 2 MB.
- **Conversation latency.** Measured end to end, Recall starts answering about 3–4 s after you stop talking. That's 1 s of silence to decide you're done, about 1 s to transcribe, about 0.5 s until the model's first clause, and about 1 s of text-to-speech. Three choices keep it there:
  - Nova 3 instead of Whisper: 0.4–1.1 s per sentence versus 1.5–5 s, and silence comes back empty rather than as invented filler.
  - The first spoken chunk is cut at the first clause, so Recall starts talking before the sentence is finished.
  - Later sentences go to text-to-speech as soon as they're complete, and are batched only when clips are already queued.
- **Barge-in without talking to itself.** The browser's echo cancellation handles most of Recall's own voice. Interrupting needs speech twice as loud as the normal threshold, held for 300 ms. Recall pauses rather than stops, and if the transcript is mostly words Recall just said (speaker echo) or empty (noise), it carries on where it paused.
- **Voice detection in the browser.** An `AudioWorklet` streams raw microphone samples. Speech starts when the level stays above an adaptive noise floor for 150 ms, and the turn ends after 1 s of silence. 600 ms of audio from before detection is kept, so the first word isn't clipped. No audio leaves the browser until a turn is complete.
- **Abuse protection.** Cloudflare's rate-limiting binding caps the AI endpoints per client IP. It uses IP rather than session ID because the browser generates session IDs and could rotate them freely.
- **No made-up memory.** Memory is never distilled from an empty transcript, where the LLM would invent facts. The Durable Object refuses to start a run for an empty chat. The Workflow also stops before the LLM step if the chat was reset after the run was queued.
