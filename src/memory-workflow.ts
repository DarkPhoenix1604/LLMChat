import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { MODEL } from "./llm";

export interface MemoryWorkflowParams {
	sessionId: string;
}

interface Distilled {
	summary: string;
	facts: string[];
}

const EXTRACTION_PROMPT = `You maintain long-term memory for a chat assistant.
Given the existing memory and the latest conversation, return JSON with:
- "summary": 2-4 sentences describing what the conversation has been about.
- "facts": up to 12 short, durable facts about the user (name, preferences, goals, projects, constraints).
Merge with existing facts, drop ones that were contradicted, and never include facts about the assistant.
Respond with JSON only.`;

/**
 * Durable background job: load the transcript from the session's Durable Object,
 * ask Llama 3.3 to distill it into a summary + fact list, then write it back.
 * Each step is checkpointed and retried independently.
 */
export class MemoryWorkflow extends WorkflowEntrypoint<Env, MemoryWorkflowParams> {
	async run(event: WorkflowEvent<MemoryWorkflowParams>, step: WorkflowStep): Promise<Distilled> {
		const { sessionId } = event.payload;
		const session = () => this.env.CHAT_SESSION.get(this.env.CHAT_SESSION.idFromName(sessionId));

		const snapshot = await step.do("load conversation", async () => {
			const stub = session();
			const memory = await stub.getMemory();
			const messages = await stub.getMessages(40);
			return {
				summary: memory.summary,
				facts: [...memory.facts],
				transcript: messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n"),
			};
		});

		const distilled = await step.do(
			"distill memory with llm",
			{ retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" },
			async (): Promise<Distilled> => {
				const result = (await this.env.AI.run(MODEL, {
					messages: [
						{ role: "system", content: EXTRACTION_PROMPT },
						{
							role: "user",
							content: [
								`Existing summary: ${snapshot.summary || "(none)"}`,
								`Existing facts: ${JSON.stringify(snapshot.facts)}`,
								"",
								"Conversation:",
								snapshot.transcript,
							].join("\n"),
						},
					],
					response_format: {
						type: "json_schema",
						json_schema: {
							type: "object",
							properties: {
								summary: { type: "string" },
								facts: { type: "array", items: { type: "string" } },
							},
							required: ["summary", "facts"],
						},
					},
					max_tokens: 800,
				})) as { response?: unknown };
				return parseDistilled(result.response);
			},
		);

		await step.do("save memory", async () => {
			await session().saveMemory(distilled.summary, distilled.facts);
		});

		return distilled;
	}
}

/** JSON mode usually returns an object, but fall back to pulling JSON out of a string. */
function parseDistilled(raw: unknown): Distilled {
	let value = raw;
	if (typeof value === "string") {
		const match = value.match(/\{[\s\S]*\}/);
		if (!match) throw new Error("LLM did not return JSON");
		value = JSON.parse(match[0]);
	}
	const obj = value as Partial<Distilled>;
	if (typeof obj?.summary !== "string" || !Array.isArray(obj.facts)) {
		throw new Error("LLM returned JSON with the wrong shape");
	}
	return {
		summary: obj.summary.trim(),
		facts: obj.facts.filter((f): f is string => typeof f === "string" && f.trim() !== "").slice(0, 12),
	};
}
