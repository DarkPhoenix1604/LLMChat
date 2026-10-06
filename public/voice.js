// Voice input: record with MediaRecorder, convert to 16 kHz mono WAV in the browser, then
// transcribe with Whisper on the server. Converting here means the server only ever sees WAV,
// whatever format this browser records in (WebM in Chrome, MP4 in Safari, Ogg in Firefox).

const SAMPLE_RATE = 16000;
export const MAX_SECONDS = 60;

export const voiceSupported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

/** Starts recording from the microphone. Resolves to a `stop()` function that returns a WAV blob. */
export async function startRecording() {
	const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
	const recorder = new MediaRecorder(stream);
	const chunks = [];
	recorder.ondataavailable = (e) => chunks.push(e.data);
	const stopped = new Promise((resolve) => (recorder.onstop = resolve));
	recorder.start();

	return async function stop() {
		if (recorder.state !== "inactive") recorder.stop();
		await stopped;
		stream.getTracks().forEach((t) => t.stop());
		const recording = new Blob(chunks, { type: recorder.mimeType });
		if (recording.size === 0) throw new Error("That recording was too short.");
		return toWav(recording);
	};
}

/** Uploads a WAV clip and returns the transcript. */
export async function transcribe(wav) {
	const res = await fetch("/api/transcribe", {
		method: "POST",
		headers: { "content-type": "audio/wav" },
		body: wav,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || `Transcription failed (${res.status})`);
	return data.text;
}

async function toWav(blob) {
	const ctx = new AudioContext();
	let decoded;
	try {
		decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
	} catch {
		throw new Error("Couldn't read that recording. Please try again.");
	} finally {
		ctx.close();
	}
	return audioBufferToWav(decoded);
}

/** Downmixes and resamples to 16 kHz mono (what Whisper works in, and small to upload), as WAV. */
export async function audioBufferToWav(audio) {
	const offline = new OfflineAudioContext(1, Math.ceil(audio.duration * SAMPLE_RATE), SAMPLE_RATE);
	const source = offline.createBufferSource();
	source.buffer = audio;
	source.connect(offline.destination);
	source.start();
	const samples = (await offline.startRendering()).getChannelData(0);
	return encodeWav(samples);
}

/** 16-bit PCM WAV: a 44-byte header followed by the samples. */
function encodeWav(samples) {
	const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
	const ascii = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
	ascii(0, "RIFF");
	view.setUint32(4, 36 + samples.length * 2, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, SAMPLE_RATE, true);
	view.setUint32(28, SAMPLE_RATE * 2, true); // bytes per second
	view.setUint16(32, 2, true); // bytes per sample frame
	view.setUint16(34, 16, true); // bits per sample
	ascii(36, "data");
	view.setUint32(40, samples.length * 2, true);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
	}
	return new Blob([view], { type: "audio/wav" });
}
