// scripts/listElevenVoices.js
import "dotenv/config";

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) throw new Error("Missing ELEVENLABS_API_KEY");

const res = await fetch("https://api.elevenlabs.io/v1/voices", {
  headers: { "xi-api-key": API_KEY },
});

if (!res.ok) {
  const text = await res.text();
  throw new Error(`ElevenLabs error ${res.status}: ${text}`);
}

const data = await res.json();

for (const v of data.voices ?? []) {
  console.log(`${v.name} => ${v.voice_id}`);
}