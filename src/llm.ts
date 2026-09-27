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

export function buildSystemPrompt(memory: Memory): string {
	const lines = [
		"You are Recall, a friendly and concise assistant running on Cloudflare Workers AI.",
		"You have long-term memory about the user that persists across the conversation.",
		"Use it naturally when relevant, but never invent facts that are not in memory or the chat.",
		"Answer in Markdown-free plain text unless the user asks for code.",
	];
	if (memory.summary) {
		lines.push("", "Summary of the conversation so far:", memory.summary);
	}
	if (memory.facts.length > 0) {
		lines.push("", "Known facts about the user:", ...memory.facts.map((f) => `- ${f}`));
	}
	return lines.join("\n");
}

/** Extracts the token text from one Workers AI SSE line (`data: {"response":"..."}`). */
export function parseSseToken(line: string): string {
	const trimmed = line.trim();
	if (!trimmed.startsWith("data:")) return "";
	const payload = trimmed.slice(5).trim();
	if (!payload || payload === "[DONE]") return "";
	try {
		const parsed = JSON.parse(payload) as { response?: unknown };
		return typeof parsed.response === "string" ? parsed.response : "";
	} catch {
		return "";
	}
}
