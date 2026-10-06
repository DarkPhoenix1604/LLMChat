export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	createdAt: number;
}

export interface Memory {
	summary: string;
	facts: string[];
	updatedAt: number | null;
}

export function buildSystemPrompt(memory: Memory, { voice = false } = {}): string {
	const lines = [
		"You are Recall, a friendly and concise assistant running on Cloudflare Workers AI.",
		"You have long-term memory about the user that persists across the conversation.",
		"Use it naturally when relevant, but never invent facts that are not in memory or the chat.",
		voice
			? "The user is talking to you by voice and your reply will be read aloud. Answer in one to three short, natural spoken sentences, and ask a follow-up question when it keeps the conversation going. Don't use Markdown, lists, code, emoji, or URLs. Start every reply with one mood tag for how you'd say it: [happy], [excited], [curious], [thinking], [sad], [surprised] or [neutral]. The tag animates your face and is never read aloud."
			: "Use Markdown when it helps: short lists, **bold** for key terms, and fenced code blocks with a language tag.",
	];
	if (memory.summary) {
		lines.push("", "Summary of the conversation so far:", memory.summary);
	}
	if (memory.facts.length > 0) {
		lines.push("", "Known facts about the user:", ...memory.facts.map((f) => `- ${f}`));
	}
	return lines.join("\n");
}

/** Voice replies open with a one-word [mood] tag for the animated eyes. It isn't part of the reply. */
export function stripMoodTag(reply: string): string {
	return reply.replace(/^\s*\[[a-z]{2,12}\](?!\()\s*/i, "");
}

/**
 * Extracts the token text from one Workers AI SSE line. Chunks carry the token twice: as an
 * OpenAI-style `choices[0].delta.content` and as `response`. The delta is preferred because
 * `response` turns numeric tokens into JSON numbers (a "1" arrives as `1`).
 */
export function parseSseToken(line: string): string {
	const trimmed = line.trim();
	if (!trimmed.startsWith("data:")) return "";
	const payload = trimmed.slice(5).trim();
	if (!payload || payload === "[DONE]") return "";
	try {
		const parsed = JSON.parse(payload) as {
			response?: unknown;
			choices?: { delta?: { content?: unknown } }[];
		};
		const delta = parsed.choices?.[0]?.delta?.content;
		if (typeof delta === "string") return delta;
		const { response } = parsed;
		return typeof response === "string" || typeof response === "number" ? String(response) : "";
	} catch {
		return "";
	}
}
