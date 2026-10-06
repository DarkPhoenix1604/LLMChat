// Hands-free voice conversation. Listens continuously, detects when you start and stop
// talking, transcribes what you said, sends it, and speaks the reply sentence by sentence
// while it streams. Talking over Recall interrupts it.

import { audioBufferToWav, transcribe } from "/voice.js";

// Voice activity detection, evaluated on ~43 ms chunks of microphone audio.
const MIN_LEVEL = 0.01; // RMS below this always counts as silence
const NOISE_MULTIPLIER = 3; // speech has to be this much louder than the room
const START_MS = 150; // sustained speech that starts an utterance
const END_SILENCE_MS = 1000; // a pause this long ends it
const MIN_SPEECH_MS = 350; // shorter bursts (a cough, a click) are ignored
const MAX_UTTERANCE_MS = 30000;
const PREROLL_MS = 600; // audio kept from before speech was detected, so the first word isn't clipped
const BARGE_IN_MS = 300; // talking over Recall for this long interrupts it...
const BARGE_IN_MULTIPLIER = 2; // ...if it's this much louder than the normal speech threshold

const FIRST_CLAUSE_CHARS = 20; // before a full sentence arrives, a clause this long can be spoken
const BATCH_CHARS = 140; // when clips are already waiting to play, batch sentences into fewer TTS requests
const MAX_SPEECH_CHARS = 1000; // server limit per /api/speak request

const STATUS = {
	listening: "Listening…",
	hearing: "Hearing you…",
	thinking: "Thinking…",
	speaking: "Speaking… talk to interrupt",
};

// Copies raw microphone samples off the audio thread in 2048-sample chunks.
const TAP_WORKLET = `
class Tap extends AudioWorkletProcessor {
	constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
	process([input]) {
		const ch = input[0];
		if (ch) for (let i = 0; i < ch.length; i++) {
			this.buf[this.n++] = ch[i];
			if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(2048); this.n = 0; }
		}
		return true;
	}
}
registerProcessor("tap", Tap);`;

export const conversationSupported = Boolean(navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode);

/**
 * ui:       { panel, status } elements, and `face`: the animated eyes (see eyes.js), which get the
 *           conversation state, audio levels and cues such as pauses, questions and the reply's mood
 * chat:     (text, onToken) => Promise<{ reply, error }>, sends a voice-mode message and streams the reply
 * stopChat: () => void, aborts the reply that is streaming
 * onEnd:    () => void, called once the conversation has closed
 */
export function createConversation({ ui, chat, stopChat, onEnd }) {
	let state = "off";
	let stream = null;
	let micCtx = null;
	let playCtx = null;
	let outAnalyser = null;
	let frame = 0;

	let noiseFloor = 0.003;
	let chunkMs = 0;
	let preroll = [];
	let voicedMs = 0;
	let utterance = [];
	let utteranceMs = 0;
	let speechMs = 0;
	let silenceMs = 0;
	let pauseCued = false;
	let bargedIn = false;
	let transcribing = false;
	let turn = null; // { speaker } for the reply being spoken

	function setState(next, message) {
		state = next;
		ui.face.setState(next);
		ui.status.textContent = message ?? STATUS[next] ?? "";
	}

	async function start() {
		if (state !== "off") return;
		// Create the audio contexts before any await so they count as started by the click.
		micCtx = new AudioContext();
		playCtx = new AudioContext();
		ui.panel.hidden = false;
		ui.face.start();
		setState("thinking", "Starting the microphone…");
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "text/javascript" }));
			await micCtx.audioWorklet.addModule(url);
			URL.revokeObjectURL(url);
		} catch (err) {
			end();
			throw err;
		}
		if (state === "off") return; // ended while waiting for permission

		const tap = new AudioWorkletNode(micCtx, "tap");
		tap.port.onmessage = (e) => onChunk(e.data);
		// The tap has to reach the destination to keep running; a zero gain keeps it silent.
		const mute = micCtx.createGain();
		mute.gain.value = 0;
		micCtx.createMediaStreamSource(stream).connect(tap).connect(mute).connect(micCtx.destination);

		outAnalyser = playCtx.createAnalyser();
		outAnalyser.fftSize = 1024;
		outAnalyser.connect(playCtx.destination);

		frame = requestAnimationFrame(animate);
		setState("listening");
	}

	function end() {
		if (state === "off") return;
		state = "off";
		cancelAnimationFrame(frame);
		turn?.speaker.cancel();
		turn = null;
		stopChat();
		stream?.getTracks().forEach((t) => t.stop());
		micCtx?.close();
		playCtx?.close();
		stream = micCtx = playCtx = outAnalyser = null;
		preroll = [];
		utterance = [];
		voicedMs = 0;
		bargedIn = false;
		transcribing = false;
		ui.face.setState("off");
		ui.face.stop();
		ui.panel.hidden = true;
		onEnd?.();
	}

	function onChunk(samples) {
		if (state !== "listening" && state !== "hearing" && state !== "speaking") return;
		chunkMs = (samples.length / micCtx.sampleRate) * 1000;
		const level = rms(samples);
		const threshold = Math.max(MIN_LEVEL, noiseFloor * NOISE_MULTIPLIER);

		if (state === "hearing") {
			utterance.push(samples);
			utteranceMs += chunkMs;
			if (level > threshold) {
				speechMs += chunkMs;
				silenceMs = 0;
				pauseCued = false;
			} else {
				silenceMs += chunkMs;
				// A short pause after some speech: the eyes give a listener's nod.
				if (!pauseCued && silenceMs >= 250 && speechMs >= 800) {
					pauseCued = true;
					ui.face.cue("pause");
				}
			}
			ui.face.setLevel(level, "in");
			if (silenceMs >= END_SILENCE_MS || utteranceMs >= MAX_UTTERANCE_MS) endUtterance();
			return;
		}

		// Listening, or Recall is speaking: keep a short pre-roll and wait for speech.
		preroll.push(samples);
		while (preroll.length * chunkMs > PREROLL_MS) preroll.shift();
		const speaking = state === "speaking";
		if (level > (speaking ? threshold * BARGE_IN_MULTIPLIER : threshold)) {
			voicedMs += chunkMs;
			if (voicedMs >= (speaking ? BARGE_IN_MS : START_MS)) beginUtterance();
		} else {
			voicedMs = 0;
			if (!speaking) noiseFloor = noiseFloor * 0.95 + level * 0.05;
		}
		if (!speaking) ui.face.setLevel(level, "in");
	}

	function beginUtterance() {
		if (state === "speaking") {
			// Pause Recall mid-word. If this turns out to be noise or its own echo, it carries on.
			bargedIn = true;
			turn?.speaker.pause();
			ui.face.cue("barge-in");
		} else {
			ui.face.cue("speech-start");
		}
		utterance = preroll;
		utteranceMs = preroll.length * chunkMs;
		speechMs = voicedMs;
		silenceMs = 0;
		preroll = [];
		voicedMs = 0;
		setState("hearing");
	}

	async function endUtterance() {
		const chunks = utterance;
		const wasBargeIn = bargedIn;
		utterance = [];
		bargedIn = false;
		if (speechMs < MIN_SPEECH_MS) return carryOn(wasBargeIn);

		setState("thinking");
		transcribing = true;
		let text = "";
		try {
			text = await transcribe(await audioBufferToWav(toAudioBuffer(chunks)));
		} catch (err) {
			transcribing = false;
			if (state !== "off") carryOn(wasBargeIn, err.message);
			return;
		}
		transcribing = false;
		if (state === "off") return;
		if (!text && !wasBargeIn) ui.face.cue("confused"); // heard speech but no words came out of it
		if (!text || (wasBargeIn && isEcho(text, turn?.speaker.text ?? ""))) return carryOn(wasBargeIn);
		if (/\?\s*$/.test(text)) ui.face.cue("question");

		if (wasBargeIn) {
			turn?.speaker.cancel();
			turn = null;
			stopChat();
		}
		respond(text);
	}

	/** Goes back to what was happening before a false start: Recall's reply, or listening. */
	function carryOn(wasBargeIn, message) {
		if (wasBargeIn && turn) {
			turn.speaker.resume();
			setState("speaking");
		} else {
			setState("listening", message);
		}
	}

	async function respond(text) {
		setState("thinking");
		const speaker = createSpeaker();
		const myTurn = { speaker };
		turn = myTurn;
		// Voice replies open with a [mood] tag for the eyes; it's taken off before anything is spoken.
		const moodTag = readMoodTag((mood) => ui.face.cue("mood", mood));
		const { error } = await chat(text, (token) => speaker.push(moodTag.read(token)));
		speaker.push(moodTag.flush());
		speaker.end();
		await speaker.done;
		if (turn !== myTurn) return; // interrupted, or the conversation ended
		turn = null;
		ui.face.cue("reply-end");
		if (!transcribing && state !== "hearing") setState("listening", error ?? undefined);
	}

	/**
	 * Turns reply text into speech as it streams in. Each chunk becomes an <audio> element that
	 * starts downloading immediately and plays while the MP3 is still arriving, so a long sentence
	 * starts in about half a second instead of after the whole clip is generated. Clips play in order.
	 */
	function createSpeaker() {
		const clips = []; // <audio> elements waiting to play, in reply order
		let current = null; // the one playing (or paused by a barge-in)
		let pending = ""; // streamed text not yet sent to text-to-speech
		let spoken = ""; // everything queued so far, used to recognise Recall's own echo
		let first = true;
		let queued = 0;
		let ended = false;
		let cancelled = false;
		let paused = false;
		let finish;
		const done = new Promise((resolve) => (finish = resolve));

		function push(token) {
			pending += token;
			// Speak the first chunk as early as possible so Recall starts talking quickly. After that,
			// send each sentence right away while nothing is waiting to play, or batch them if clips are queued.
			const cut = first ? firstCut(pending) : sentenceCut(pending, clips.length ? BATCH_CHARS : 1);
			if (cut) {
				queue(pending.slice(0, cut));
				pending = pending.slice(cut);
				first = false;
			}
		}

		function end() {
			ended = true;
			queue(pending);
			pending = "";
			if (!current) next();
		}

		function queue(text) {
			const clean = speakable(text);
			if (!clean || cancelled) return;
			spoken += ` ${clean}`;
			const audio = new Audio(`/api/speak?text=${encodeURIComponent(clean.slice(0, MAX_SPEECH_CHARS))}`);
			audio.preload = "auto";
			playCtx.createMediaElementSource(audio).connect(outAnalyser);
			const index = queued++;
			let started = false;
			audio.onplaying = () => {
				if (state === "thinking" && !transcribing) setState("speaking");
				if (started) return; // resumed after a false barge-in
				started = true;
				ui.face.cue("phrase", { index, text: clean });
			};
			clips.push(audio);
			if (!current) next();
		}

		function next() {
			if (cancelled || paused) return;
			current = clips.shift() ?? null;
			if (!current) {
				if (ended) finish();
				return;
			}
			const audio = current;
			let advanced = false;
			const advance = () => {
				if (advanced || cancelled || audio !== current) return;
				advanced = true;
				current = null;
				next();
			};
			audio.onended = advance;
			audio.onerror = () => {
				ui.status.textContent = "Couldn't play part of the reply aloud.";
				advance();
			};
			// A rejection without a media error is just play() being cut short by pause().
			audio.play().catch(() => audio.error && audio.onerror());
		}

		function pause() {
			paused = true;
			current?.pause();
		}

		function resume() {
			paused = false;
			if (current) current.play().catch(() => {});
			else next();
		}

		function cancel() {
			cancelled = true;
			for (const audio of [current, ...clips]) {
				if (!audio) continue;
				audio.pause();
				audio.removeAttribute("src"); // stops the download
				audio.load();
			}
			current = null;
			clips.length = 0;
			finish();
		}

		return {
			push,
			end,
			pause,
			resume,
			cancel,
			done,
			get text() {
				return spoken;
			},
		};
	}

	const outSamples = new Float32Array(1024);
	function animate() {
		if (state === "off") return;
		if (state === "speaking") {
			outAnalyser.getFloatTimeDomainData(outSamples);
			ui.face.setLevel(rms(outSamples), "out");
		}
		frame = requestAnimationFrame(animate);
	}

	function toAudioBuffer(chunks) {
		const length = chunks.reduce((n, c) => n + c.length, 0);
		const buffer = new AudioBuffer({ length, sampleRate: micCtx.sampleRate, numberOfChannels: 1 });
		const data = buffer.getChannelData(0);
		let offset = 0;
		for (const c of chunks) {
			data.set(c, offset);
			offset += c.length;
		}
		return buffer;
	}

	return {
		start,
		end,
		get active() {
			return state !== "off";
		},
	};
}

// Any one-word tag counts (the eyes ignore moods they don't know), but not a Markdown link.
const MOOD_TAG = /^\s*\[([a-z]{2,12})\](?!\()\s*/i;

/**
 * Takes the leading [mood] tag off a streamed reply, reporting the mood, and passes the rest
 * through. Text is held back only while it still looks like the start of a tag.
 */
function readMoodTag(onMood) {
	let head = "";
	let done = false;
	return {
		read(token) {
			if (done) return token;
			head += token;
			const tag = head.match(MOOD_TAG);
			if (tag) {
				done = true;
				onMood(tag[1].toLowerCase());
				return head.slice(tag[0].length);
			}
			if (/^\s*\[[a-z]{0,12}$/i.test(head)) return ""; // could still become a tag
			done = true;
			return head;
		},
		flush() {
			if (done) return "";
			done = true;
			return head;
		},
	};
}

function rms(samples) {
	let sum = 0;
	for (const s of samples) sum += s * s;
	return Math.sqrt(sum / samples.length);
}

const SENTENCE_END = /[.!?…]+["'”’)\]]*\s+|\n+/g;
const SENTENCE_OR_CLAUSE_END = /[.!?…]+["'”’)\]]*\s+|\n+|[,;:]\s+/g;

/** End of the first sentence, or of a long enough clause, so Recall can start talking early. */
function firstCut(text) {
	for (const m of text.matchAll(SENTENCE_OR_CLAUSE_END)) {
		const end = m.index + m[0].length;
		if (!/^[,;:]/.test(m[0]) || end >= FIRST_CLAUSE_CHARS) return end;
	}
	return 0;
}

/** End of the last complete sentence at or past `minChars`, or 0 if there isn't one yet. */
function sentenceCut(text, minChars) {
	let cut = 0;
	for (const m of text.matchAll(SENTENCE_END)) {
		const end = m.index + m[0].length;
		if (end >= minChars) cut = end;
	}
	return cut;
}

/** Strips Markdown and URLs, which sound wrong read aloud. */
function speakable(text) {
	return text
		.replace(/```[\s\S]*?(```|$)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/https?:\/\/\S+/g, "")
		.replace(/[*_`#>|~]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** True when what the mic heard is mostly Recall's own words: speaker echo, not the user. */
function isEcho(heard, spoken) {
	const words = (s) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
	const said = words(heard);
	const recall = new Set(words(spoken));
	return said.length > 0 && said.filter((w) => recall.has(w)).length / said.length >= 0.7;
}
