// /src/index.js

import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";

import { elevenLabsTextToSpeech } from "./elevenLabsTts.js";
import { playMp3InVoiceChannel } from "./discordVoice.js";

import { UNIVERSE_SYSTEM } from "./universeSystem.js";
import { NPC_BY_CHANNEL } from "./havenPortConfig.js";
import { DISCORD_CHANNEL_TO_NPC_KEY } from "./channelMap.js";

import {
  initMongoHistory,
  appendHistory,
  getRecentHistory,
  closeMongoHistory,
} from "./mongoHistory.js";

/**
 * @fileoverview
 * Discord NPC chatbot entrypoint.
 *
 * Responsibilities:
 * - Connect to Discord and listen for messages in mapped channels.
 * - Route each message to the appropriate NPC persona (system prompt).
 * - Persist conversation history to MongoDB (per channel).
 * - Call OpenAI Responses API with trimmed history to generate replies.
 * - Optionally synthesize and play TTS in the user's voice channel (ElevenLabs).
 *
 * Notes:
 * - Mongo stores the full conversation; we only retrieve the last N turns for inference.
 * - TTS can be globally disabled via env var / CLI flag to save credits.
 */

// -----------------------------
// Config
// -----------------------------

/**
 * Keep only the last N turns *in the model prompt* so token usage stays sane.
 * Mongo can store more than N — we just only retrieve N for inference.
 * @type {number}
 */
const MAX_TURNS = 16;

/**
 * OpenAI model used for NPC replies.
 * @type {string}
 */
const OPENAI_MODEL = "gpt-4o-mini";

/**
 * Max tokens for the assistant response.
 * @type {number}
 */
const MAX_OUTPUT_TOKENS = 250;

/**
 * How long to stay connected after playing TTS audio.
 * @type {number}
 */
const DISCONNECT_AFTER_MS = 12_000;

/**
 * Global toggle to enable/disable all voice output (TTS).
 *
 * Priority (highest to lowest):
 * 1) CLI flag: --no-tts / --tts
 * 2) Env var: DISCORD_TTS_ENABLED ("true"/"false"/"1"/"0")
 * 3) Default: enabled
 *
 * Examples:
 * - Disable voice:  node src/index.js --no-tts
 * - Enable voice:   node src/index.js --tts
 * - Disable voice:  DISCORD_TTS_ENABLED=false node src/index.js
 *
 * @type {boolean}
 */
const TTS_ENABLED = resolveTtsEnabled({
  argv: process.argv.slice(2),
  envValue: process.env.DISCORD_TTS_ENABLED,
  defaultValue: true,
});

// -----------------------------
// Clients
// -----------------------------

/**
 * Discord client instance.
 * @type {Client<boolean>}
 */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

/**
 * OpenAI API client instance.
 * @type {OpenAI}
 */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -----------------------------
// Logging
// -----------------------------

/**
 * Minimal structured logger for grep-friendly logs in production.
 *
 * @param {string} type - Event type identifier (e.g., "openai.request").
 * @param {Record<string, any>} payload - Additional event metadata.
 * @returns {void}
 */
function logEvent(type, payload) {
  const ts = new Date().toISOString();
  // Keep the log format stable for downstream parsing.
  console.log(`[${ts}] ${type}`, payload);
}

// -----------------------------
// Helpers
// -----------------------------

/**
 * Parse a truthy/falsey environment value.
 *
 * Accepted truthy: "true", "1", "yes", "y", "on"
 * Accepted falsey: "false", "0", "no", "n", "off"
 *
 * Any other value returns undefined.
 *
 * @param {string | undefined} value
 * @returns {boolean | undefined}
 */
function parseBool(value) {
  if (value == null) return undefined;
  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;

  return undefined;
}

/**
 * Resolve whether TTS is enabled using CLI args and env var.
 *
 * CLI flags:
 * - --no-tts : disables voice
 * - --tts    : enables voice
 *
 * @param {{
 *   argv: string[],
 *   envValue: string | undefined,
 *   defaultValue: boolean
 * }} params
 * @returns {boolean}
 */
function resolveTtsEnabled({ argv, envValue, defaultValue }) {
  // CLI flags override everything
  if (argv.includes("--no-tts")) return false;
  if (argv.includes("--tts")) return true;

  // Env var next
  const envParsed = parseBool(envValue);
  if (typeof envParsed === "boolean") return envParsed;

  // Default
  return defaultValue;
}

/**
 * Resolve an NPC config for a Discord channel, with structured error reporting.
 *
 * @param {string} discordChannelId
 * @returns {{ npcKey: string | null, npc: any | null, error?: string }}
 */
function resolveNpcForChannel(discordChannelId) {
  const npcKey = DISCORD_CHANNEL_TO_NPC_KEY[discordChannelId] ?? null;
  if (!npcKey) return { npcKey: null, npc: null, error: "channel_not_mapped" };

  const npc = NPC_BY_CHANNEL[npcKey] ?? null;
  if (!npc) return { npcKey, npc: null, error: "npc_config_missing" };

  return { npcKey, npc };
}

/**
 * Persist a single chat turn to Mongo.
 *
 * @param {{
 *   channelId: string,
 *   role: "user" | "assistant",
 *   content: string,
 *   npcKey: string,
 *   authorTag: string,
 *   discordMessageId: string | null,
 *   ts: Date
 * }} entry
 * @returns {Promise<void>}
 */
async function persistTurn(entry) {
  await appendHistory(entry);
}

/**
 * Generate an NPC reply using OpenAI Responses API.
 *
 * @param {{
 *   npcSystem: string,
 *   history: Array<{ role: "user" | "assistant", content: string }>,
 * }} params
 * @returns {Promise<{ replyText: string, usage: any }>}
 */
async function generateNpcReply({ npcSystem, history }) {
  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: UNIVERSE_SYSTEM },
      { role: "system", content: npcSystem },
      ...history,
    ],
    max_output_tokens: MAX_OUTPUT_TOKENS,
  });

  const replyText = response.output_text?.trim() || "…";
  return { replyText, usage: response.usage ?? null };
}

/**
 * Attempt TTS playback for an NPC reply if:
 * - Global TTS is enabled
 * - User is in a voice channel
 * - NPC has ElevenLabs voice configured
 *
 * @param {{
 *   message: import("discord.js").Message,
 *   npc: any,
 *   replyText: string,
 * }} params
 * @returns {Promise<void>}
 */
async function maybeSpeakReply({ message, npc, replyText }) {
  if (!TTS_ENABLED) {
    logEvent("tts.skipped", { reason: "disabled_globally", npcName: npc?.name });
    return;
  }

  const voiceChannel = message.member?.voice?.channel;

  const canSpeak =
    !!voiceChannel &&
    npc?.voice?.provider === "elevenlabs" &&
    !!npc?.voice?.voiceId;

  if (!canSpeak) return;

  logEvent("tts.request", {
    npcName: npc.name,
    voiceId: npc.voice.voiceId,
    channelId: voiceChannel.id,
  });

  const mp3Buffer = await elevenLabsTextToSpeech({
    text: replyText,
    voiceId: npc.voice.voiceId,
    settings: npc.voice.settings,
  });

  await playMp3InVoiceChannel({
    guild: message.guild,
    voiceChannel,
    mp3Buffer,
    onLog: (type, payload) => logEvent(type, payload),
    disconnectAfterMs: DISCONNECT_AFTER_MS,
  });
}

// -----------------------------
// Lifecycle
// -----------------------------

/**
 * Attach graceful shutdown handlers once at startup.
 * Ensures Mongo connection is closed on process termination.
 *
 * @returns {void}
 */
function attachGracefulShutdown() {
  const shutdown = async (signal) => {
    try {
      logEvent("shutdown", { signal });
      await closeMongoHistory();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/**
 * Boot sequence:
 * - Initialize Mongo history connection
 * - Attach shutdown hooks
 * - Login to Discord
 *
 * @returns {Promise<void>}
 */
async function boot() {
  await initMongoHistory();
  attachGracefulShutdown();

  logEvent("boot.config", {
    model: OPENAI_MODEL,
    ttsEnabled: TTS_ENABLED,
    maxTurns: MAX_TURNS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  // Let discord.js surface login errors via rejection below.
  await client.login(process.env.DISCORD_TOKEN);
}

// -----------------------------
// Discord Events
// -----------------------------

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const discordChannelId = message.channel.id;

  // Log inbound message early for traceability, even if we ignore it.
  logEvent("discord.message.in", {
    channelId: discordChannelId,
    channelName: message.channel?.name,
    author: message.author.tag,
    content: message.content,
  });

  const { npcKey, npc, error } = resolveNpcForChannel(discordChannelId);

  if (error === "channel_not_mapped") {
    logEvent("discord.message.ignored", { reason: "channel_not_mapped" });
    return;
  }

  if (error === "npc_config_missing") {
    logEvent("discord.message.error", { reason: "npc_config_missing", npcKey });
    await message.reply(`NPC config missing for key: ${npcKey}`);
    return;
  }

  logEvent("discord.message.routed", { npcKey, npcName: npc.name });

  try {
    // 1) Persist user message
    await persistTurn({
      channelId: discordChannelId,
      role: "user",
      content: message.content,
      npcKey,
      authorTag: message.author.tag,
      discordMessageId: message.id,
      ts: new Date(),
    });

    // 2) Load last N turns for this channel (Mongo is source of truth)
    const channelHistory = await getRecentHistory(discordChannelId, MAX_TURNS);

    // 3) Typing indicator while we call OpenAI
    await message.channel.sendTyping();

    logEvent("openai.request", {
      model: OPENAI_MODEL,
      npcName: npc.name,
      historyTurns: channelHistory.length,
      lastUserMessage: message.content,
    });

    // 4) Generate reply
    const { replyText, usage } = await generateNpcReply({
      npcSystem: npc.system,
      history: channelHistory,
    });

    logEvent("openai.response", {
      npcName: npc.name,
      replyPreview: replyText.slice(0, 200),
      usage,
    });

    // 5) Persist assistant reply
    await persistTurn({
      channelId: discordChannelId,
      role: "assistant",
      content: replyText,
      npcKey,
      authorTag: client.user?.tag || "bot",
      discordMessageId: null,
      ts: new Date(),
    });

    // 6) Send Discord reply
    logEvent("discord.message.out", {
      channelId: discordChannelId,
      npcName: npc.name,
      replyPreview: replyText.slice(0, 200),
    });

    await message.reply(replyText);

    // 7) Best-effort TTS (never fail the message flow)
    try {
      await maybeSpeakReply({ message, npc, replyText });
    } catch (ttsErr) {
      logEvent("tts.error", { npcName: npc.name, error: String(ttsErr) });
    }
  } catch (err) {
    console.error("[ERROR]", err);
    try {
      await message.reply("Something went wrong generating that response.");
    } catch {
      // swallow — we don't want error handling to throw
    }
  }
});

// Updated event name (fixes deprecation warning)
client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Start everything
boot().catch((err) => {
  console.error("[BOOT ERROR]", err);
  process.exit(1);
});