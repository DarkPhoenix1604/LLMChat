export { ChatSession } from "./chat-session";
export { MemoryWorkflow } from "./memory-workflow";

const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_MESSAGE_LENGTH = 4000;

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function sessionStub(env: Env, sessionId: string) {
	return env.CHAT_SESSION.get(env.CHAT_SESSION.idFromName(sessionId));
}

async function readBody(request: Request): Promise<{ sessionId?: unknown; message?: unknown }> {
	try {
		return (await request.json()) as { sessionId?: unknown; message?: unknown };
	} catch {
		return {};
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;

		// POST /api/chat  { sessionId, message }  ->  text/event-stream of LLM tokens
		if (pathname === "/api/chat" && request.method === "POST") {
			const { sessionId, message } = await readBody(request);
			if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
				return json({ error: "Invalid sessionId" }, 400);
			}
			if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE_LENGTH) {
				return json({ error: `Message must be 1-${MAX_MESSAGE_LENGTH} characters` }, 400);
			}
			let stream: ReadableStream<Uint8Array>;
			try {
				stream = await sessionStub(env, sessionId).chat(sessionId, message.trim());
			} catch (err) {
				console.error("chat failed", err);
				return json({ error: "The AI model is unavailable right now. Please try again." }, 502);
			}
			return new Response(stream, {
				headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
			});
		}

		// GET /api/session?sessionId=...  ->  transcript, memory, and latest workflow status
		if (pathname === "/api/session" && request.method === "GET") {
			const sessionId = url.searchParams.get("sessionId") ?? "";
			if (!SESSION_ID.test(sessionId)) return json({ error: "Invalid sessionId" }, 400);
			const stub = sessionStub(env, sessionId);
			const [messages, memory, workflowId] = await Promise.all([
				stub.getMessages(),
				stub.getMemory(),
				stub.getWorkflowId(),
			]);
			let workflow: { id: string; status: string } | null = null;
			if (workflowId) {
				try {
					const status = await (await env.MEMORY_WORKFLOW.get(workflowId)).status();
					workflow = { id: workflowId, status: status.status };
				} catch {
					workflow = { id: workflowId, status: "unknown" };
				}
			}
			return json({ messages, memory, workflow });
		}

		// POST /api/memory/refresh  { sessionId }  ->  start the memory workflow now
		if (pathname === "/api/memory/refresh" && request.method === "POST") {
			const { sessionId } = await readBody(request);
			if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
				return json({ error: "Invalid sessionId" }, 400);
			}
			const id = await sessionStub(env, sessionId).refreshMemory(sessionId);
			return json({ workflowId: id }, 202);
		}

		// POST /api/reset  { sessionId }  ->  wipe transcript and memory
		if (pathname === "/api/reset" && request.method === "POST") {
			const { sessionId } = await readBody(request);
			if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
				return json({ error: "Invalid sessionId" }, 400);
			}
			await sessionStub(env, sessionId).reset();
			return json({ ok: true });
		}

		if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
