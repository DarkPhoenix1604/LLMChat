const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const emptyEl = $("empty");
const form = $("composer");
const input = $("input");
const sendBtn = $("send");

function getSessionId() {
	let id = localStorage.getItem("recall-session");
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem("recall-session", id);
	}
	return id;
}
let sessionId = getSessionId();

function addBubble(role, text = "") {
	emptyEl.hidden = true;
	const el = document.createElement("div");
	el.className = `msg ${role}`;
	el.textContent = text;
	messagesEl.appendChild(el);
	messagesEl.scrollTop = messagesEl.scrollHeight;
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

async function sendMessage(text) {
	addBubble("user", text);
	const bubble = addBubble("assistant");
	bubble.classList.add("pending");
	sendBtn.disabled = true;

	try {
		const res = await fetch("/api/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId, message: text }),
		});
		if (!res.ok || !res.body) {
			const err = await res.json().catch(() => ({}));
			throw new Error(err.error || `Request failed (${res.status})`);
		}

		// Parse the Workers AI server-sent events: `data: {"response":"token"}`
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
					const token = JSON.parse(payload).response;
					if (typeof token === "string") {
						bubble.textContent += token;
						messagesEl.scrollTop = messagesEl.scrollHeight;
					}
				} catch {
					/* partial or non-JSON line */
				}
			}
		}
	} catch (err) {
		bubble.remove();
		addBubble("error", err.message);
	} finally {
		bubble.classList.remove("pending");
		sendBtn.disabled = false;
		input.focus();
		// The Durable Object may have just started a memory workflow.
		setTimeout(() => loadSession(), 800);
	}
}

form.addEventListener("submit", (e) => {
	e.preventDefault();
	const text = input.value.trim();
	if (!text || sendBtn.disabled) return;
	input.value = "";
	input.style.height = "";
	sendMessage(text);
});

input.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		form.requestSubmit();
	}
});
input.addEventListener("input", () => {
	input.style.height = "auto";
	input.style.height = `${input.scrollHeight}px`;
});

$("refresh").addEventListener("click", async () => {
	$("refresh").disabled = true;
	await fetch("/api/memory/refresh", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId }),
	});
	$("refresh").disabled = false;
	loadSession();
});

$("reset").addEventListener("click", async () => {
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
