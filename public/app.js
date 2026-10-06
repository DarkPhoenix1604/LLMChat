import { renderMarkdown } from "/markdown.js";
import { MAX_SECONDS, startRecording, transcribe, voiceSupported } from "/voice.js";
import { conversationSupported, createConversation } from "/conversation.js";
import { createEyes } from "/eyes.js";

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const emptyEl = $("empty");
const form = $("composer");
const input = $("input");
const sendBtn = $("send");
const stopBtn = $("stop");
const micBtn = $("mic");
const talkBtn = $("talk");

function getSessionId() {
	let id = localStorage.getItem("recall-session");
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem("recall-session", id);
	}
	return id;
}
let sessionId = getSessionId();

function scrollToBottom() {
	messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** True unless the user has scrolled up to read earlier messages. */
function isNearBottom() {
	return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
}

/** Hides the [mood] tag that opens voice replies (it's for the eyes), including a half-streamed one. */
function hideMoodTag(text) {
	if (/^\s*\[[a-z]{0,12}$/i.test(text)) return "";
	return text.replace(/^\s*\[[a-z]{2,12}\](?!\()\s*/i, "");
}

function setBubbleText(el, role, text) {
	// Assistant replies are Markdown; everything else is shown exactly as typed.
	if (role === "assistant") el.replaceChildren(renderMarkdown(text));
	else el.textContent = text;
}

function addBubble(role, text = "") {
	emptyEl.hidden = true;
	const el = document.createElement("div");
	el.className = role === "assistant" ? "msg assistant md" : `msg ${role}`;
	setBubbleText(el, role, text);
	messagesEl.appendChild(el);
	scrollToBottom();
	return el;
}

function renderMemory(memory, workflow) {
	$("summary").textContent = memory.summary || "—";
	const facts = $("facts");
	facts.replaceChildren(
		...memory.facts.map((f) => {
			const li = document.createElement("li");
			li.textContent = f;
			return li;
		}),
	);
	$("memory-updated").textContent = memory.updatedAt
		? `Last updated ${new Date(memory.updatedAt).toLocaleTimeString()}`
		: "Nothing remembered yet.";

	const badge = $("wf-status");
	badge.hidden = !workflow;
	if (workflow) {
		badge.textContent = `workflow: ${workflow.status}`;
		badge.className = `badge ${workflow.status}`;
	}
	return workflow && ["queued", "running", "waiting"].includes(workflow.status);
}

let pollTimer = null;
async function loadSession({ renderMessages = false } = {}) {
	const res = await fetch(`/api/session?sessionId=${encodeURIComponent(sessionId)}`);
	if (!res.ok) return;
	const data = await res.json();
	if (renderMessages) {
		messagesEl.querySelectorAll(".msg").forEach((m) => m.remove());
		emptyEl.hidden = data.messages.length > 0;
		for (const m of data.messages) addBubble(m.role, m.content);
	}
	const inFlight = renderMemory(data.memory, data.workflow);
	clearTimeout(pollTimer);
	// Keep polling while a workflow is running so the memory panel updates live.
	if (inFlight) pollTimer = setTimeout(() => loadSession(), 2000);
}

/**
 * Token text from one Workers AI SSE payload. Prefers the OpenAI-style delta, because the
 * `response` field turns numeric tokens into numbers (a "1" arrives as `1`).
 */
function tokenFrom(payload) {
	const data = JSON.parse(payload);
	const delta = data.choices?.[0]?.delta?.content;
	if (typeof delta === "string") return delta;
	return typeof data.response === "string" || typeof data.response === "number" ? String(data.response) : "";
}

/** Set while a reply is streaming; aborting it is what the Stop button does. */
let streaming = null;

function setStreaming(controller) {
	streaming = controller;
	sendBtn.hidden = Boolean(controller);
	stopBtn.hidden = !controller;
}

/**
 * Sends a message and streams the reply into a new bubble. `voice` asks for a short spoken-style
 * reply, and `onToken` sees each token as it arrives (conversation mode reads them aloud).
 */
async function sendMessage(text, { voice = false, onToken } = {}) {
	addBubble("user", text);
	const bubble = addBubble("assistant");
	bubble.classList.add("pending");
	const controller = new AbortController();
	setStreaming(controller);

	// Re-render the Markdown at most once per frame while tokens stream in.
	let reply = "";
	let error = null;
	let frame = 0;
	const render = () => {
		frame = 0;
		const stick = isNearBottom();
		setBubbleText(bubble, "assistant", voice ? hideMoodTag(reply) : reply);
		if (stick) scrollToBottom();
	};

	try {
		const res = await fetch("/api/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId, message: text, voice }),
			signal: controller.signal,
		});
		if (!res.ok || !res.body) {
			const err = await res.json().catch(() => ({}));
			throw new Error(err.error || `Request failed (${res.status})`);
		}

		// Parse the Workers AI server-sent events: `data: {...}` lines, one token each
		const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += value;
			const lines = buffer.split("\n");
			buffer = lines.pop();
			for (const line of lines) {
				const payload = line.replace(/^data:\s*/, "").trim();
				if (!payload || payload === "[DONE]") continue;
				try {
					const token = tokenFrom(payload);
					if (token) {
						reply += token;
						onToken?.(token);
						frame ||= requestAnimationFrame(render);
					}
				} catch {
					/* partial or non-JSON line */
				}
			}
		}
	} catch (err) {
		if (err.name === "AbortError") {
			// Stopped by the user: keep whatever arrived. The server saves the same partial reply.
			if (reply) bubble.classList.add("stopped");
			else bubble.remove();
		} else {
			error = err.message;
			bubble.remove();
			addBubble("error", err.message);
		}
	} finally {
		cancelAnimationFrame(frame);
		if (bubble.isConnected) render();
		bubble.classList.remove("pending");
		// After an interruption, the next message may already be streaming; leave its state alone.
		if (streaming === controller) setStreaming(null);
		if (!voice) input.focus();
		// The Durable Object may have just started a memory workflow.
		setTimeout(() => loadSession(), 800);
	}
	return { reply, error };
}

form.addEventListener("submit", (e) => {
	e.preventDefault();
	const text = input.value.trim();
	if (!text || streaming) return;
	input.value = "";
	input.style.height = "";
	sendMessage(text);
});

stopBtn.addEventListener("click", () => streaming?.abort());

input.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		form.requestSubmit();
	}
});
function autoGrow() {
	input.style.height = "auto";
	input.style.height = `${input.scrollHeight}px`;
}
input.addEventListener("input", autoGrow);

// Copy buttons on code blocks (delegated, since replies re-render while streaming).
messagesEl.addEventListener("click", async (e) => {
	const btn = e.target.closest(".copy");
	if (!btn) return;
	try {
		await navigator.clipboard.writeText(btn.closest(".code-block").querySelector("code").textContent);
		btn.textContent = "Copied";
	} catch {
		btn.textContent = "Copy failed";
	}
	setTimeout(() => (btn.textContent = "Copy"), 1500);
});

// Voice input: click the mic to start, click again (or hit the time limit) to transcribe.
let stopRecording = null;
let recordTimer = null;
const defaultPlaceholder = input.placeholder;

micBtn.hidden = !voiceSupported;

micBtn.addEventListener("click", async () => {
	if (stopRecording) return finishRecording();
	try {
		stopRecording = await startRecording();
	} catch (err) {
		addBubble("error", err.name === "NotAllowedError" ? "Microphone access was blocked." : err.message);
		return;
	}
	micBtn.classList.add("recording");
	micBtn.setAttribute("aria-label", "Stop recording");
	input.placeholder = "Listening… click the mic again when you're done";
	recordTimer = setTimeout(finishRecording, MAX_SECONDS * 1000);
});

async function finishRecording() {
	clearTimeout(recordTimer);
	const stop = stopRecording;
	stopRecording = null;
	micBtn.classList.remove("recording");
	micBtn.setAttribute("aria-label", "Record a voice message");
	micBtn.disabled = true;
	input.placeholder = "Transcribing…";
	try {
		const text = await transcribe(await stop());
		if (!text) throw new Error("I didn't catch anything. Try again?");
		// Drop the transcript into the box so it can be checked before sending.
		input.value = input.value.trim() ? `${input.value.trim()} ${text}` : text;
		autoGrow();
	} catch (err) {
		addBubble("error", err.message);
	} finally {
		micBtn.disabled = false;
		input.placeholder = defaultPlaceholder;
		input.focus();
	}
}

// Conversation mode: hands-free back-and-forth by voice. The panel, with Recall's animated eyes,
// replaces the composer. Double-clicking the eyes lets them take over the whole chat column.
const chatColumn = document.querySelector(".chat");
const eyes = createEyes($("eyes"), {
	onDoubleClick: () => chatColumn.classList.toggle("voice-expanded"),
});
const conversation = createConversation({
	ui: { panel: $("voice"), status: $("voice-status"), face: eyes },
	chat: (text, onToken) => sendMessage(text, { voice: true, onToken }),
	stopChat: () => streaming?.abort(),
	onEnd: () => {
		chatColumn.classList.remove("voice-expanded");
		form.hidden = false;
		input.focus();
		scrollToBottom();
	},
});

talkBtn.hidden = !conversationSupported;
document.querySelector('.chip[data-action="talk"]').hidden = !conversationSupported;

async function startConversation() {
	streaming?.abort();
	form.hidden = true;
	try {
		await conversation.start();
	} catch (err) {
		form.hidden = false;
		addBubble("error", err.name === "NotAllowedError" ? "Microphone access was blocked." : err.message);
	}
}

talkBtn.addEventListener("click", startConversation);
$("voice-end").addEventListener("click", () => conversation.end());
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && conversation.active) conversation.end();
});

// Starter suggestions on the empty screen.
emptyEl.addEventListener("click", (e) => {
	const chip = e.target.closest(".chip");
	if (!chip) return;
	if (chip.dataset.action === "talk") return startConversation();
	input.value = chip.textContent;
	form.requestSubmit();
});

$("refresh").addEventListener("click", async () => {
	$("refresh").disabled = true;
	const res = await fetch("/api/memory/refresh", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId }),
	});
	$("refresh").disabled = false;
	if (!res.ok) {
		// e.g. 409 for an empty chat, 429 when rate limited
		const err = await res.json().catch(() => ({}));
		$("memory-updated").textContent = err.error || `Memory update failed (${res.status})`;
		return;
	}
	loadSession();
});

$("reset").addEventListener("click", async () => {
	conversation.end();
	streaming?.abort();
	await fetch("/api/reset", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId }),
	});
	localStorage.removeItem("recall-session");
	sessionId = getSessionId();
	loadSession({ renderMessages: true });
});

loadSession({ renderMessages: true });
