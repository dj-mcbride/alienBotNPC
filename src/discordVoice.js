// /src/discordVoice.js
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} from "@discordjs/voice";

import prism from "prism-media";
import { Readable } from "node:stream";

/**
 * Keep one connection/player per guild to avoid reconnect spam.
 */
const voiceStateByGuild = new Map();

function getOrCreateGuildVoiceState(guildId) {
  const existing = voiceStateByGuild.get(guildId);
  if (existing) return existing;

  const player = createAudioPlayer();
  const state = { connection: null, player };
  voiceStateByGuild.set(guildId, state);
  return state;
}

/**
 * Converts MP3 buffer to PCM stream using FFmpeg.
 * Discord voice works best with raw PCM.
 */
function mp3BufferToPcmStream(mp3Buffer) {
  const input = Readable.from(mp3Buffer);

  const ffmpeg = new prism.FFmpeg({
    args: [
      "-analyzeduration",
      "0",
      "-loglevel",
      "0",
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
    ],
  });

  return input.pipe(ffmpeg);
}

async function ensureConnectionReady(connection) {
  // If Discord kicks the connection, attempt a quick re-ready.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // If we got here, it’s reconnecting automatically.
    } catch {
      try {
        connection.destroy();
      } catch {}
    }
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
}

/**
 * Join a specific voice channel and play an MP3 buffer.
 */
export async function playMp3InVoiceChannel({
  guild,
  voiceChannel,
  mp3Buffer,
  onLog,
  disconnectAfterMs = 12_000,
}) {
  if (!guild?.id) throw new Error("Missing guild.");
  if (!voiceChannel?.id) throw new Error("Missing voiceChannel.");
  if (!mp3Buffer?.length) throw new Error("Missing mp3Buffer.");

  const guildId = guild.id;
  const state = getOrCreateGuildVoiceState(guildId);

  // Create or move connection to the correct voice channel.
  if (!state.connection || state.connection.joinConfig.channelId !== voiceChannel.id) {
    try {
      state.connection?.destroy?.();
    } catch {}

    state.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    await ensureConnectionReady(state.connection);
    state.connection.subscribe(state.player);

    onLog?.("voice.connected", { guildId, channelId: voiceChannel.id });
  }

  // Convert MP3 -> PCM stream for Discord playback
  const pcmStream = mp3BufferToPcmStream(mp3Buffer);

  const resource = createAudioResource(pcmStream, {
    inputType: StreamType.Raw,
  });

  // Play
  state.player.play(resource);

  onLog?.("voice.play.start", { guildId, channelId: voiceChannel.id });

  // Disconnect after idle to avoid “bot camping” in voice
  const idleTimeout = setTimeout(() => {
    try {
      state.connection?.destroy?.();
    } catch {}
    state.connection = null;
    onLog?.("voice.disconnected.idle", { guildId, channelId: voiceChannel.id });
  }, disconnectAfterMs);

  state.player.once(AudioPlayerStatus.Idle, () => {
    clearTimeout(idleTimeout);
    // (We still disconnect via timeout, because some streams don’t cleanly trigger Idle)
  });
}