import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  ChannelType,
} from "discord.js";
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
 */

// -----------------------------
// Config
// -----------------------------

const MAX_TURNS = 16;
const OPENAI_MODEL = "gpt-4o-mini";
const MAX_OUTPUT_TOKENS = 250;
const DISCONNECT_AFTER_MS = 12_000;

const TTS_ENABLED = resolveTtsEnabled({
  argv: process.argv.slice(2),
  envValue: process.env.DISCORD_TTS_ENABLED,
  defaultValue: true,
});

// -----------------------------
// Clients
// -----------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -----------------------------
// Logging
// -----------------------------

function logEvent(type, payload) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${type}`, payload);
}

// -----------------------------
// Voice debug state
// -----------------------------

/**
 * Tracks active voice-join attempts so we only log the relevant
 * voice gateway events while a TTS attempt is in flight.
 *
 * key: guildId
 * value: {
 *   guildId: string,
 *   channelId: string,
 *   channelName: string | null,
 *   npcName: string | null,
 *   startedAt: string
 * }
 */
const pendingVoiceDebugByGuild = new Map();

function beginPendingVoiceDebug({ guildId, channelId, channelName, npcName }) {
  pendingVoiceDebugByGuild.set(guildId, {
    guildId,
    channelId,
    channelName: channelName ?? null,
    npcName: npcName ?? null,
    startedAt: new Date().toISOString(),
  });
}

function endPendingVoiceDebug(guildId) {
  pendingVoiceDebugByGuild.delete(guildId);
}

function getPendingVoiceDebug(guildId) {
  return pendingVoiceDebugByGuild.get(guildId) ?? null;
}

// -----------------------------
// Helpers
// -----------------------------

function parseBool(value) {
  if (value == null) return undefined;
  const v = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;

  return undefined;
}

function resolveTtsEnabled({ argv, envValue, defaultValue }) {
  if (argv.includes("--no-tts")) return false;
  if (argv.includes("--tts")) return true;

  const envParsed = parseBool(envValue);
  if (typeof envParsed === "boolean") return envParsed;

  return defaultValue;
}

function resolveNpcForChannel(discordChannelId) {
  const npcKey = DISCORD_CHANNEL_TO_NPC_KEY[discordChannelId] ?? null;
  if (!npcKey) return { npcKey: null, npc: null, error: "channel_not_mapped" };

  const npc = NPC_BY_CHANNEL[npcKey] ?? null;
  if (!npc) return { npcKey, npc: null, error: "npc_config_missing" };

  return { npcKey, npc };
}

async function persistTurn(entry) {
  await appendHistory(entry);
}

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

function getChannelTypeName(channel) {
  if (!channel) return null;

  switch (channel.type) {
    case ChannelType.GuildVoice:
      return "GuildVoice";
    case ChannelType.GuildStageVoice:
      return "GuildStageVoice";
    case ChannelType.GuildText:
      return "GuildText";
    case ChannelType.GuildCategory:
      return "GuildCategory";
    default:
      return `Unknown(${channel.type})`;
  }
}

function getBotVoiceChannelPermissions(guild, voiceChannel) {
  const me = guild?.members?.me;
  const perms = me ? voiceChannel?.permissionsFor(me) : null;

  return {
    botUserId: me?.id ?? null,
    botTag: me?.user?.tag ?? null,
    canViewChannel: perms?.has(PermissionFlagsBits.ViewChannel) ?? null,
    canConnect: perms?.has(PermissionFlagsBits.Connect) ?? null,
    canSpeak: perms?.has(PermissionFlagsBits.Speak) ?? null,
    canUseVAD: perms?.has(PermissionFlagsBits.UseVAD) ?? null,
    canMuteMembers: perms?.has(PermissionFlagsBits.MuteMembers) ?? null,
    canMoveMembers: perms?.has(PermissionFlagsBits.MoveMembers) ?? null,
    canRequestToSpeak: perms?.has(PermissionFlagsBits.RequestToSpeak) ?? null,
  };
}

/**
 * Attempt TTS playback for an NPC reply if:
 * - Global TTS is enabled
 * - User is in a voice channel
 * - NPC has ElevenLabs voice configured
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

  const guildId = message.guild?.id ?? null;

  logEvent("voice.target.channel", {
    guildId,
    channelId: voiceChannel.id,
    channelName: voiceChannel.name ?? null,
    channelType: getChannelTypeName(voiceChannel),
    parentId: voiceChannel.parentId ?? null,
    parentName: voiceChannel.parent?.name ?? null,
    memberCount: voiceChannel.members?.size ?? null,
    userVoiceChannelId: message.member?.voice?.channelId ?? null,
    npcName: npc.name,
  });

  logEvent("voice.target.permissions", {
    guildId,
    channelId: voiceChannel.id,
    channelName: voiceChannel.name ?? null,
    ...getBotVoiceChannelPermissions(message.guild, voiceChannel),
  });

  logEvent("tts.request", {
    npcName: npc.name,
    voiceId: npc.voice.voiceId,
    channelId: voiceChannel.id,
  });

  let mp3Buffer;
  try {
    mp3Buffer = await elevenLabsTextToSpeech({
      text: replyText,
      voiceId: npc.voice.voiceId,
      settings: npc.voice.settings,
    });
  } catch (err) {
    logEvent("tts.elevenlabs.error", {
      npcName: npc.name,
      voiceId: npc.voice.voiceId,
      channelId: voiceChannel.id,
      errorName: err?.name ?? null,
      errorMessage: err?.message ?? String(err),
      errorStack: err?.stack ?? null,
      errorCause:
        err?.cause instanceof Error
          ? {
              name: err.cause.name ?? null,
              message: err.cause.message ?? null,
              stack: err.cause.stack ?? null,
            }
          : (err?.cause ?? null),
      errorCode: err?.code ?? null,
    });
    throw err;
  }

  beginPendingVoiceDebug({
    guildId,
    channelId: voiceChannel.id,
    channelName: voiceChannel.name ?? null,
    npcName: npc.name,
  });

  try {
    await playMp3InVoiceChannel({
      guild: message.guild,
      voiceChannel,
      mp3Buffer,
      onLog: (type, payload) => logEvent(type, payload),
      disconnectAfterMs: DISCONNECT_AFTER_MS,
    });
  } catch (err) {
    logEvent("tts.discord_voice.error", {
      npcName: npc.name,
      voiceId: npc.voice.voiceId,
      channelId: voiceChannel.id,
      guildId: message.guild?.id ?? null,
      mp3Bytes: mp3Buffer?.length ?? null,
      errorName: err?.name ?? null,
      errorMessage: err?.message ?? String(err),
      errorStack: err?.stack ?? null,
      errorCause:
        err?.cause instanceof Error
          ? {
              name: err.cause.name ?? null,
              message: err.cause.message ?? null,
              stack: err.cause.stack ?? null,
            }
          : (err?.cause ?? null),
      errorCode: err?.code ?? null,
    });
    throw err;
  } finally {
    if (guildId) {
      endPendingVoiceDebug(guildId);
    }
  }
}

// -----------------------------
// Lifecycle
// -----------------------------

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

async function boot() {
  await initMongoHistory();
  attachGracefulShutdown();

  logEvent("boot.config", {
    model: OPENAI_MODEL,
    ttsEnabled: TTS_ENABLED,
    maxTurns: MAX_TURNS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  await client.login(process.env.DISCORD_TOKEN);
}

// -----------------------------
// Discord Events
// -----------------------------

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const discordChannelId = message.channel.id;

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
    await persistTurn({
      channelId: discordChannelId,
      role: "user",
      content: message.content,
      npcKey,
      authorTag: message.author.tag,
      discordMessageId: message.id,
      ts: new Date(),
    });

    const channelHistory = await getRecentHistory(discordChannelId, MAX_TURNS);

    await message.channel.sendTyping();

    logEvent("openai.request", {
      model: OPENAI_MODEL,
      npcName: npc.name,
      historyTurns: channelHistory.length,
      lastUserMessage: message.content,
    });

    const { replyText, usage } = await generateNpcReply({
      npcSystem: npc.system,
      history: channelHistory,
    });

    logEvent("openai.response", {
      npcName: npc.name,
      replyPreview: replyText.slice(0, 200),
      usage,
    });

    await persistTurn({
      channelId: discordChannelId,
      role: "assistant",
      content: replyText,
      npcKey,
      authorTag: client.user?.tag || "bot",
      discordMessageId: null,
      ts: new Date(),
    });

    logEvent("discord.message.out", {
      channelId: discordChannelId,
      npcName: npc.name,
      replyPreview: replyText.slice(0, 200),
    });

    await message.reply(replyText);

    try {
      await maybeSpeakReply({ message, npc, replyText });
    } catch (ttsErr) {
      logEvent("tts.error", {
        npcName: npc.name,
        errorName: ttsErr?.name ?? null,
        errorMessage: ttsErr?.message ?? String(ttsErr),
        errorStack: ttsErr?.stack ?? null,
        errorCause:
          ttsErr?.cause instanceof Error
            ? {
                name: ttsErr.cause.name ?? null,
                message: ttsErr.cause.message ?? null,
                stack: ttsErr.cause.stack ?? null,
              }
            : (ttsErr?.cause ?? null),
        errorCode: ttsErr?.code ?? null,
      });
    }
  } catch (err) {
    console.error("[ERROR]", err);
    try {
      await message.reply("Something went wrong generating that response.");
    } catch {
      // swallow
    }
  }
});

/**
 * Logs only bot voice state changes, and only while a TTS voice join
 * is pending for that guild. This avoids noisy logging.
 */
client.on("voiceStateUpdate", (oldState, newState) => {
  const botUserId = client.user?.id;
  if (!botUserId) return;

  const stateUserId = newState?.id ?? oldState?.id;
  if (stateUserId !== botUserId) return;

  const guildId = newState?.guild?.id ?? oldState?.guild?.id;
  if (!guildId) return;

  const pending = getPendingVoiceDebug(guildId);
  if (!pending) return;

  logEvent("discord.voiceStateUpdate.bot", {
    guildId,
    npcName: pending.npcName,
    targetChannelId: pending.channelId,
    targetChannelName: pending.channelName,
    oldChannelId: oldState?.channelId ?? null,
    newChannelId: newState?.channelId ?? null,
    sessionId: newState?.sessionId ?? oldState?.sessionId ?? null,
    selfMute: newState?.selfMute ?? null,
    selfDeaf: newState?.selfDeaf ?? null,
    serverMute: newState?.serverMute ?? null,
    serverDeaf: newState?.serverDeaf ?? null,
    suppress: newState?.suppress ?? null,
  });
});

/**
 * Logs VOICE_SERVER_UPDATE only while a TTS voice join
 * is pending for that guild.
 */
client.on("raw", (packet) => {
  if (packet?.t !== "VOICE_SERVER_UPDATE") return;

  const guildId = packet?.d?.guild_id ?? null;
  if (!guildId) return;

  const pending = getPendingVoiceDebug(guildId);
  if (!pending) return;

  logEvent("discord.raw.voice_server_update", {
    guildId,
    npcName: pending.npcName,
    targetChannelId: pending.channelId,
    targetChannelName: pending.channelName,
    endpoint: packet?.d?.endpoint ?? null,
    tokenPresent: !!packet?.d?.token,
  });
});

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

boot().catch((err) => {
  console.error("[BOOT ERROR]", err);
  process.exit(1);
});