export const STT_MODEL = "@cf/deepgram/nova-3";
export const TTS_MODEL = "@cf/deepgram/aura-2-en";

/** About 60 seconds of the 16 kHz mono WAV the browser uploads, with headroom. */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
/** The browser sends replies a sentence or a few at a time, so this is plenty. */
export const MAX_SPEECH_CHARS = 1000;

/**
 * Transcribes a short voice clip with Deepgram Nova 3 on Workers AI. Nova 3 was chosen over
 * Whisper for latency: about 0.5 s for a sentence versus 1.5 to 5 s, which matters in a voice
 * conversation. It also returns an empty transcript for silence instead of inventing words.
 */
export async function transcribe(ai: Ai, audio: ArrayBuffer, contentType: string): Promise<string> {
	const result = await ai.run(STT_MODEL, {
		// The model only accepts the audio body as a stream, not an ArrayBuffer.
		audio: { body: new Response(audio).body!, contentType },
		smart_format: true,
	});
	return result.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
}

/** Speaks text with Deepgram Aura 2 on Workers AI and returns the MP3 audio as a stream. */
export async function synthesize(ai: Ai, text: string): Promise<ReadableStream> {
	// Typed as a string, but at runtime the binding returns the audio bytes as a stream.
	const result: unknown = await ai.run(TTS_MODEL, { text, speaker: "thalia", encoding: "mp3" });
	if (!(result instanceof ReadableStream)) throw new Error("Unexpected text-to-speech result");
	return result;
}
