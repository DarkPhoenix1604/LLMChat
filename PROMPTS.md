# AI Prompts Used

This project was built with AI-assisted coding: **Claude Code** (Claude Opus 5.5) in VS Code. Below are the prompts I gave the assistant, in order, followed by the prompts the app itself sends to the LLM at runtime.

---

## 1. Development prompts (Claude Code)

### Prompt 1: initial build

> We plan to fast track candidates who complete an assignment to build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components:
> LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
> Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
> User input via chat or voice (recommend using Pages or Realtime)
> Memory or state
> Find additional documentation here.
> Note: AI-assisted coding is encouraged, but you have to submit prompt history.

**What the assistant did with this prompt:**
- Designed the app ("Recall"): a Worker for the API, one Durable Object per chat session holding SQLite state, Llama 3.3 on Workers AI for streamed replies, and a Workflow that distills the conversation into long-term memory.
- Scaffolded `package.json`, `wrangler.jsonc`, and `tsconfig.json`, then ran `wrangler types`.
- Wrote `src/index.ts`, `src/chat-session.ts`, `src/memory-workflow.ts`, `src/llm.ts`, and the UI in `public/`.
- Type-checked with `tsc` and smoke-tested the endpoints under `wrangler dev`: static assets, validation, SQLite persistence, reset, and workflow start/status.
- Found that a failed model call returned a raw stack trace, and changed it to a clean 502 JSON error.
- Wrote `README.md` and this file.

<!-- Add each later prompt below as "Prompt N", with a one-line note on what changed. -->

---

## 2. Runtime prompts (sent to Llama 3.3 by the app)

### Chat system prompt (`src/llm.ts` → `buildSystemPrompt`)

```
You are Recall, a friendly and concise assistant running on Cloudflare Workers AI.
You have long-term memory about the user that persists across the conversation.
Use it naturally when relevant, but never invent facts that are not in memory or the chat.
Answer in Markdown-free plain text unless the user asks for code.

Summary of the conversation so far:
<summary from memory>

Known facts about the user:
- <fact 1>
- <fact 2>
```

### Memory extraction prompt (`src/memory-workflow.ts` → `EXTRACTION_PROMPT`)

This prompt is sent with a JSON-schema `response_format` (`{ summary: string, facts: string[] }`):

```
You maintain long-term memory for a chat assistant.
Given the existing memory and the latest conversation, return JSON with:
- "summary": 2-4 sentences describing what the conversation has been about.
- "facts": up to 12 short, durable facts about the user (name, preferences, goals, projects, constraints).
Merge with existing facts, drop ones that were contradicted, and never include facts about the assistant.
Respond with JSON only.
```

The user message sent with it contains the existing summary, the existing facts, and the last 40 messages of the transcript.
