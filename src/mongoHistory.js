// /src/mongoHistory.js
import { MongoClient } from "mongodb";

const DEFAULT_MONGO_URL = "mongodb://127.0.0.1:27017";
const DEFAULT_DB_NAME = "aliens_bot";
const DEFAULT_COLLECTION = "discord_channel_history";

let client;
let collection;

/**
 * initMongoHistory()
 * - Connect once and reuse the same client/collection.
 */
export async function initMongoHistory({
  mongoUrl = process.env.MONGO_URL || DEFAULT_MONGO_URL,
  dbName = process.env.MONGO_DB || DEFAULT_DB_NAME,
  collectionName = process.env.MONGO_COLLECTION || DEFAULT_COLLECTION,
} = {}) {
  if (collection) return collection;

  client = new MongoClient(mongoUrl, {
    // sane defaults; local mongo typically fine
    maxPoolSize: 10,
  });

  await client.connect();

  const db = client.db(dbName);
  collection = db.collection(collectionName);

  // Ensure useful index exists (safe if already exists)
  await collection.createIndex({ channelId: 1, ts: -1 });

  return collection;
}

/**
 * appendHistory()
 * - Store a single message (user or assistant) as an event.
 */
export async function appendHistory({
  channelId,
  role,
  content,
  npcKey = null,
  authorTag = null,
  discordMessageId = null,
  ts = new Date(),
}) {
  if (!collection) {
    throw new Error("Mongo history not initialized. Call initMongoHistory() first.");
  }

  const doc = {
    channelId,
    role, // "user" | "assistant"
    content,
    npcKey,
    authorTag,
    discordMessageId,
    ts,
  };

  await collection.insertOne(doc);
}

/**
 * getRecentHistory()
 * - Fetch last N turns for a channel, returned oldest->newest
 * - This matches OpenAI input ordering expectations.
 */
export async function getRecentHistory(channelId, limit) {
  if (!collection) {
    throw new Error("Mongo history not initialized. Call initMongoHistory() first.");
  }

  // Grab newest first, then reverse to chronological
  const docs = await collection
    .find({ channelId })
    .sort({ ts: -1 })
    .limit(limit)
    .project({ _id: 0, role: 1, content: 1 })
    .toArray();

  return docs.reverse();
}

/**
 * closeMongoHistory()
 * - Optional: close on shutdown
 */
export async function closeMongoHistory() {
  try {
    await client?.close();
  } catch {}
  client = undefined;
  collection = undefined;
}