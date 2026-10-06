import { DurableObject } from "cloudflare:workers";
import { MODEL, buildSystemPrompt, parseSseToken, stripMoodTag, type ChatMessage, type Memory } from "./llm";

/** How many recent messages are sent to the LLM as short-term context. */
const CONTEXT_WINDOW = 20;
/** Kick off the memory workflow every N stored messages (user + assistant). */
const MEMORY_EVERY = 6;

/**
 * One instance per chat session. Owns all state for that session in its
 * SQLite storage: the raw transcript plus the distilled long-term memory.
 */
export class ChatSession extends DurableObject<Env> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				role       TEXT    NOT NULL,
				content    TEXT    NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS memory (
				id         INTEGER PRIMARY KEY CHECK (id = 1),
				summary    TEXT    NOT NULL DEFAULT '',
				facts      TEXT    NOT NULL DEFAULT '[]',
				updated_at INTEGER,
				workflow_id TEXT
			);
			INSERT OR IGNORE INTO memory (id) VALUES (1);
		`);
	}

	/**
	 * Stores the user message, streams the LLM reply back, and persists it when the stream ends.
	 * `voice` asks for a short, spoken-style reply, because it will be read aloud.
	 */
	async chat(sessionId: string, userMessage: string, voice = false): Promise<ReadableStream<Uint8Array>> {
		this.addMessage("user", userMessage);

		const messages = [
			{ role: "system" as const, content: buildSystemPrompt(this.getMemory(), { voice }) },
			...this.getMessages(CONTEXT_WINDOW).map(({ role, content }) => ({ role, content })),
		];

		const aiStream = (await this.env.AI.run(MODEL, {
			messages,
			stream: true,
			max_tokens: voice ? 300 : 1024,
		})) as ReadableStream<Uint8Array>;

		return this.relayReply(sessionId, aiStream, voice);
	}

	getMessages(limit = 100): ChatMessage[] {
		const rows = this.sql
			.exec<{ role: string; content: string; created_at: number }>(
				"SELECT role, content, created_at FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
				limit,
			)
			.toArray();
		return rows.map((r) => ({
			role: r.role as ChatMessage["role"],
			content: r.content,
			createdAt: r.created_at,
		}));
	}

	getMemory(): Memory {
		const row = this.sql
			.exec<{ summary: string; facts: string; updated_at: number | null }>(
				"SELECT summary, facts, updated_at FROM memory WHERE id = 1",
			)
			.one();
		return { summary: row.summary, facts: JSON.parse(row.facts) as string[], updatedAt: row.updated_at };
	}

	/** Called by MemoryWorkflow once it has distilled the conversation. */
	saveMemory(summary: string, facts: string[]): void {
		this.sql.exec(
			"UPDATE memory SET summary = ?, facts = ?, updated_at = ? WHERE id = 1",
			summary,
			JSON.stringify(facts),
			Date.now(),
		);
	}

	getWorkflowId(): string | null {
		return this.sql.exec<{ workflow_id: string | null }>("SELECT workflow_id FROM memory WHERE id = 1").one()
			.workflow_id;
	}

	/**
	 * Starts a MemoryWorkflow run for this session and remembers its id.
	 * Returns null for an empty chat: with nothing to distill, the LLM tends to invent memory.
	 */
	async refreshMemory(sessionId: string): Promise<string | null> {
		if (this.messageCount() === 0) return null;
		const instance = await this.env.MEMORY_WORKFLOW.create({ params: { sessionId } });
		this.sql.exec("UPDATE memory SET workflow_id = ? WHERE id = 1", instance.id);
		return instance.id;
	}

	reset(): void {
		this.sql.exec("DELETE FROM messages");
		this.sql.exec("UPDATE memory SET summary = '', facts = '[]', updated_at = NULL, workflow_id = NULL WHERE id = 1");
	}

	private addMessage(role: ChatMessage["role"], content: string): void {
		this.sql.exec("INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)", role, content, Date.now());
	}

	private messageCount(): number {
		return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n;
	}

	/**
	 * Passes the Workers AI stream through to the browser while collecting the reply text, and
	 * saves the reply when the stream ends. If the browser cancels (Stop button, closed tab),
	 * generation is cancelled too and the partial reply the user saw is saved instead.
	 */
	private relayReply(sessionId: string, source: ReadableStream<Uint8Array>, voice: boolean): ReadableStream<Uint8Array> {
		const reader = source.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let reply = "";
		let saved = false;
		const save = async () => {
			if (saved) return;
			saved = true;
			const text = reply + parseSseToken(buffer);
			await this.saveReply(sessionId, voice ? stripMoodTag(text) : text);
		};

		return new ReadableStream<Uint8Array>({
			pull: async (controller) => {
				const { done, value } = await reader.read().catch(async (err) => {
					await save();
					throw err;
				});
				if (done) {
					controller.close();
					await save();
					return;
				}
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) reply += parseSseToken(line);
				controller.enqueue(value);
			},
			cancel: async (reason) => {
				await reader.cancel(reason).catch(() => {});
				await save();
			},
		});
	}

	private async saveReply(sessionId: string, reply: string): Promise<void> {
		if (!reply.trim()) return;

		this.addMessage("assistant", reply.trim());

		if (this.messageCount() % MEMORY_EVERY === 0) {
			await this.refreshMemory(sessionId);
		}
	}
}
