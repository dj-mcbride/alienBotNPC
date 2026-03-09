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
 * Keep one connection/player per guild to avoid unnecessary player recreation.
 * For debugging, we still force-destroy the voice connection before each join.
 */
const voiceStateByGuild = new Map();
const instrumentedConnections = new WeakSet();
const instrumentedPlayers = new WeakSet();

function getOrCreateGuildVoiceState(guildId, onLog) {
  const existing = voiceStateByGuild.get(guildId);
  if (existing) return existing;

  const player = createAudioPlayer();

  if (!instrumentedPlayers.has(player)) {
    instrumentedPlayers.add(player);

    player.on("error", (err) => {
      onLog?.("voice.player.error", {
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
    });

    player.on("stateChange", (oldState, newState) => {
      if (oldState.status !== newState.status) {
        onLog?.("voice.player.state", {
          from: oldState.status,
          to: newState.status,
        });
      }
    });
  }

  const state = { connection: null, player };
  voiceStateByGuild.set(guildId, state);
  return state;
}

/**
 * Converts MP3 buffer to PCM stream using FFmpeg.
 * Discord voice works best with raw PCM.
 */
function mp3BufferToPcmStream(mp3Buffer, onLog) {
  const input = Readable.from(mp3Buffer);

  input.on("error", (err) => {
    onLog?.("voice.stream.input.error", {
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
  });

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

  ffmpeg.on("error", (err) => {
    onLog?.("voice.ffmpeg.error", {
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
  });

  const output = input.pipe(ffmpeg);

  output.on("error", (err) => {
    onLog?.("voice.stream.output.error", {
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
  });

  return output;
}

function instrumentConnection(connection, onLog, meta) {
  if (instrumentedConnections.has(connection)) return;
  instrumentedConnections.add(connection);

  connection.on("error", (err) => {
    onLog?.("voice.connection.error", {
      ...meta,
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
  });

  connection.on("stateChange", (oldState, newState) => {
    if (oldState.status !== newState.status) {
      onLog?.("voice.connection.state", {
        ...meta,
        from: oldState.status,
        to: newState.status,
      });
    }
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch (err) {
      onLog?.("voice.connection.disconnected.error", {
        ...meta,
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
        stateStatus: connection.state?.status ?? null,
      });

      try {
        connection.destroy();
      } catch (destroyErr) {
        onLog?.("voice.connection.destroy.error", {
          ...meta,
          errorName: destroyErr?.name ?? null,
          errorMessage: destroyErr?.message ?? String(destroyErr),
          errorStack: destroyErr?.stack ?? null,
        });
      }
    }
  });
}

async function ensureConnectionReady(connection, onLog, meta) {
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    onLog?.("voice.connection.ready.error", {
      ...meta,
      stateStatus: connection.state?.status ?? null,
      joinConfig: connection.joinConfig
        ? {
            channelId: connection.joinConfig.channelId ?? null,
            guildId: connection.joinConfig.guildId ?? null,
            selfDeaf: connection.joinConfig.selfDeaf ?? null,
            selfMute: connection.joinConfig.selfMute ?? null,
          }
        : null,
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
  const channelId = voiceChannel.id;
  const meta = { guildId, channelId };

  const state = getOrCreateGuildVoiceState(guildId, onLog);

  // For debugging: always destroy the prior connection, even if it points
  // at the same channel. This avoids reusing any poisoned connection state.
  if (state.connection) {
    try {
      onLog?.("voice.connection.reset", {
        ...meta,
        previousChannelId: state.connection.joinConfig?.channelId ?? null,
        previousStatus: state.connection.state?.status ?? null,
      });
      state.connection.destroy();
    } catch (err) {
      onLog?.("voice.connection.prior_destroy.error", {
        ...meta,
        errorName: err?.name ?? null,
        errorMessage: err?.message ?? String(err),
        errorStack: err?.stack ?? null,
      });
    } finally {
      state.connection = null;
    }
  }

  state.connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  instrumentConnection(state.connection, onLog, meta);

  await ensureConnectionReady(state.connection, onLog, meta);
  state.connection.subscribe(state.player);

  onLog?.("voice.connected", meta);

  const pcmStream = mp3BufferToPcmStream(mp3Buffer, onLog);

  const resource = createAudioResource(pcmStream, {
    inputType: StreamType.Raw,
  });

  try {
    state.player.play(resource);
  } catch (err) {
    onLog?.("voice.player.play.error", {
      ...meta,
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

  onLog?.("voice.play.start", meta);

  const idleTimeout = setTimeout(() => {
    try {
      state.connection?.destroy?.();
    } catch (err) {
      onLog?.("voice.connection.idle_destroy.error", {
        ...meta,
        errorName: err?.name ?? null,
        errorMessage: err?.message ?? String(err),
        errorStack: err?.stack ?? null,
      });
    }
    state.connection = null;
    onLog?.("voice.disconnected.idle", meta);
  }, disconnectAfterMs);

  state.player.once(AudioPlayerStatus.Idle, () => {
    clearTimeout(idleTimeout);
  });
}