import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";

import { NPC_BY_CHANNEL } from "./npcConfig.js";
import { DISCORD_CHANNEL_TO_NPC_KEY } from "./channelMap.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // required for reading normal messages
  ],
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory chat history per Discord channel.
// For production, swap this to Redis / SQLite so memory survives restarts.
const historyByDiscordChannel = new Map();

// Keep only the last N turns so token usage stays sane.
const MAX_TURNS = 16; // 16 user+assistant messages total (adjust)

// Helper: push message into history and trim.
function pushHistory(discordChannelId, role, content) {
  const arr = historyByDiscordChannel.get(discordChannelId) ?? [];
  arr.push({ role, content });

  // Trim oldest while preserving structure
  const trimmed = arr.slice(-MAX_TURNS);
  historyByDiscordChannel.set(discordChannelId, trimmed);
}

client.on("messageCreate", async (message) => {
  try {
    // Ignore bot messages (including itself)
    if (message.author.bot) return;

    const discordChannelId = message.channel.id;
    const npcKey = DISCORD_CHANNEL_TO_NPC_KEY[discordChannelId];
    if (!npcKey) return; // not an NPC channel

    const npc = NPC_BY_CHANNEL[npcKey];
    if (!npc) {
      await message.reply(`NPC config missing for key: ${npcKey}`);
      return;
    }

    // Add user message to memory
    pushHistory(discordChannelId, "user", message.content);

    // Build prompt:
    // - System prompt from your npcConfig
    // - Recent conversation from this channel
    const channelHistory = historyByDiscordChannel.get(discordChannelId) ?? [];

    // Discord typing indicator
    await message.channel.sendTyping();

    // Call OpenAI (text-only)
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: npc.system },
        ...channelHistory,
      ],
      // Optional: keep NPC responses short-ish by default
      max_output_tokens: 250,
    });

    const replyText =
      response.output_text?.trim() ||
      "…";

    // Add assistant reply to memory
    pushHistory(discordChannelId, "assistant", replyText);

    await message.reply(replyText);
  } catch (err) {
    console.error(err);
    // Keep failures graceful
    try {
      await message.reply("Something went wrong generating that response.");
    } catch {}
  }
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);