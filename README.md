# cf_ai_memory_chat — "Recall"

An AI chat assistant built entirely on Cloudflare that **remembers you**. Every conversation lives in its own Durable Object, replies stream from **Llama 3.3 70B on Workers AI**, and a **Cloudflare Workflow** runs in the background to distill the chat into long-term memory (a running summary plus a list of facts about the user). That memory is fed back into the system prompt on every turn.

## How it covers the assignment

| Requirement | Implementation |
| --- | --- |
| **LLM** | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on Workers AI. Used for streamed chat replies, and in JSON mode for memory extraction. |
| **Workflow / coordination** | A **Worker** routes the API. A **Durable Object** (`ChatSession`) coordinates each session. A **Workflow** (`MemoryWorkflow`) runs memory extraction as durable steps that are checkpointed and retried. |
| **User input (chat)** | Chat UI (`public/`) served as Workers static assets. Tokens stream in over server-sent events. |
| **Memory / state** | Each `ChatSession` Durable Object stores the full transcript and the distilled memory in its built-in **SQLite** storage. |

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
                              │  4. tee stream → client + save assistant reply
                              │  5. every 6 messages → start MemoryWorkflow
                              ▼
                        MemoryWorkflow (src/memory-workflow.ts)
                          step 1: load conversation   (RPC → Durable Object)
                          step 2: distill memory       (Llama 3.3, JSON mode, 3 retries)
                          step 3: save memory          (RPC → Durable Object)
```

The session ID is a UUID generated in the browser and kept in `localStorage`. The Worker maps it to a Durable Object with `idFromName`, so reloading the page brings back both the transcript and the memory.

### API

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/chat` | `{ sessionId, message }` | `text/event-stream` of `data: {"response": "<token>"}` |
| `GET` | `/api/session` | `?sessionId=` | `{ messages, memory, workflow }` |
| `POST` | `/api/memory/refresh` | `{ sessionId }` | `{ workflowId }` (starts the workflow right away) |
| `POST` | `/api/reset` | `{ sessionId }` | `{ ok: true }` |

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
5. **New chat** clears the session.

Other useful commands: `npm run typecheck` checks types, and `npm run types` regenerates `worker-configuration.d.ts` after you edit `wrangler.jsonc`.

## Project layout

```
src/
  index.ts            Worker entry: API routing and validation; exports the DO and Workflow classes
  chat-session.ts     ChatSession Durable Object: SQLite state, streaming LLM chat, starts the workflow
  memory-workflow.ts  MemoryWorkflow: load → distill with the LLM → save, each a durable step
  llm.ts              Model id, system prompt builder, SSE token parser
public/
  index.html, app.js, styles.css   Chat UI with a live memory panel
wrangler.jsonc        Bindings: AI, Durable Object + migration, Workflow, static assets
PROMPTS.md            AI prompts used while building this project
```

## Design notes

- **Short-term and long-term memory are separate.** Only the last 20 messages go to the model verbatim. Older context reaches it through the workflow-maintained summary and facts, so prompts stay bounded however long the chat gets.
- **Why a Workflow for memory?** Extraction is a slow, multi-step LLM job that can fail. Running it as a Workflow keeps it off the chat's critical path, retries the LLM step with exponential backoff, and checkpoints each step so a retry doesn't reload or rewrite state.
- **Streaming and persistence together.** The Durable Object `tee()`s the Workers AI stream. One branch goes to the browser and the other is read in `ctx.waitUntil` to save the complete reply.
- **Safety.** Session IDs and message lengths are validated at the edge. The UI renders model output with `textContent`, never `innerHTML`.
