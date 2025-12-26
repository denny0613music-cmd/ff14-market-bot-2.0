import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import fetch from "node-fetch";
import fs from "fs";

const ITEMS_FILE = "./items_zh_tw.json";
const WORLD = (process.env.WORLD || "bahamut").trim(); // 你可改成自己的世界

function buildLookup(raw) {
  const lookup = {};

  // Array format
  if (Array.isArray(raw)) {
    for (const it of raw) {
      const id = Number(it?.id);
      const name = (it?.zh || it?.name || it?.en || "").trim();
      if (id && name) lookup[name] = id;
    }
    return lookup;
  }

  // Object format
  if (raw && typeof raw === "object") {
    const keys = Object.keys(raw);
    const numericKeyCount = keys.slice(0, 50).filter((k) => /^\d+$/.test(k)).length;

    if (numericKeyCount > 0) {
      // id -> name 反轉成 name -> id
      for (const [idStr, nameVal] of Object.entries(raw)) {
        const id = Number(idStr);
        const name = String(nameVal || "").trim();
        if (id && name) lookup[name] = id;
      }
      return lookup;
    }

    // name -> id
    for (const [name, idVal] of Object.entries(raw)) {
      const id = Number(idVal);
      const n = String(name || "").trim();
      if (n && id) lookup[n] = id;
    }
    return lookup;
  }

  return lookup;
}

let itemLookup = {};
try {
  const raw = JSON.parse(fs.readFileSync(ITEMS_FILE, "utf8"));
  itemLookup = buildLookup(raw);
  console.log(`✅ items loaded: ${Object.keys(itemLookup).length}`);
} catch (e) {
  console.error(`❌ Failed to load ${ITEMS_FILE}:`, e);
  itemLookup = {};
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🌍 WORLD=${WORLD}`);
});

async function getMarketPrice(itemId) {
  const url = `https://universalis.app/api/v2/${encodeURIComponent(WORLD)}/${itemId}?listings=10`;
  const res = await fetch(url);

  if (!res.ok) throw new Error(`Universalis HTTP ${res.status}`);
  const data = await res.json();

  const listings = Array.isArray(data?.listings) ? data.listings : [];
  if (listings.length === 0) return "No listings";

  let min = listings[0].pricePerUnit;
  for (const l of listings) {
    if (typeof l?.pricePerUnit === "number" && l.pricePerUnit < min) min = l.pricePerUnit;
  }
  return `${min.toLocaleString()} Gil`;
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  if (!content.toLowerCase().startsWith("!p")) return;

  const keyword = content.slice(2).trim(); // "!p" 後面全部當物品名
  if (!keyword) return message.reply("Usage: `!P <item name>` e.g. `!P Iron Ore`");

  const itemId = itemLookup[keyword];
  if (!itemId) return message.reply(`❌ Not found: ${keyword}`);

  try {
    const price = await getMarketPrice(itemId);
    await message.reply(`📦 Item: ${keyword}\n🆔 ID: ${itemId}\n💰 Lowest: ${price}`);
  } catch (e) {
    console.error(e);
    await message.reply(`⚠️ Query failed: ${String(e.message || e)}`);
  }
});

client.login(process.env.BOT_TOKEN);
