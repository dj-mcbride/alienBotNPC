// /src/elevenLabsTts.js
import "dotenv/config";

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;

if (!ELEVEN_API_KEY) {
  throw new Error("Missing ELEVENLABS_API_KEY in environment.");
}

/**
 * Generates speech audio (MP3) from ElevenLabs.
 * @returns {Promise<Buffer>} MP3 audio bytes
 */
export async function elevenLabsTextToSpeech({
  text,
  voiceId,
  settings,
  modelId = "eleven_multilingual_v2",
  outputFormat = "mp3_44100_128",
}) {
  if (!text?.trim()) throw new Error("TTS text is empty.");
  if (!voiceId) throw new Error("Missing ElevenLabs voiceId.");

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${encodeURIComponent(
    outputFormat,
  )}`;

  const body = {
    text,
    model_id: modelId,
    voice_settings: settings ?? {
      stability: 0.5,
      similarity_boost: 0.8,
      style: 0.3,
      use_speaker_boost: true,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${errText}`);
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}