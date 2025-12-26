import "dotenv/config";
import http from "http";
import fs from "fs";
import fetch from "node-fetch";
import { createRequire } from "module";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

const require = createRequire(import.meta.url);
const OpenCC = require("opencc-js");

/* ===============================
   Debug Mode
================================ */
const DEBUG_MODE = String(process.env.DEBUG_MODE || "").toLowerCase() === "true";
const debug = (...args) => DEBUG_MODE && console.log("🪲 DEBUG:", ...args);

/* ===============================
   Render 健康檢查
================================ */
const PORT = process.env.PORT || 10000;
http.createServer((_, res) => {
  res.writeHead(200);
  res.end("ok");
}).listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));

/* ===============================
   Env
================================ */
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || "").trim();
const PRICE_CHANNEL_ID = (process.env.PRICE_CHANNEL_ID || "").trim();
const WORLD_LIST = (process.env.WORLD_LIST || "").trim();
const WORLD_SINGLE = (process.env.WORLD || "Bahamut").trim();

const ITEMS_FILE = "./items_zh_tw.json";
const MANUAL_FILE = "./items_zh_manual.json";
const XIVAPI_BASE = "https://cafemaker.wakingsands.com";

/* ===============================
   OpenCC
================================ */
// 簡 → 繁（顯示）
const s2t = OpenCC.Converter({ from: "cn", to: "tw" });
// 繁 → 簡（搜尋）
const t2s = OpenCC.Converter({ from: "tw", to: "cn" });

/* ===============================
   台服伺服器顯示名稱
================================ */
const WORLD_NAME_ZH = {
  Ifrit: "伊弗利特",
  Garuda: "迦樓羅",
  Leviathan: "利維坦",
  Phoenix: "鳳凰",
  Odin: "奧汀",
  Bahamut: "巴哈姆特",
  Titan: "泰坦",
  Ramuh: "拉姆",
};
const displayWorldName = (w) => WORLD_NAME_ZH[w] || w;

/* ===============================
   Utils
================================ */
function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[’'`]/g, "")
    .replace(/[：:]/g, "：");
}

function loadJson(path, fallback = {}) {
  try {
    if (!fs.existsSync(path)) return fallback;
    const txt = fs.readFileSync(path, "utf8").trim();
    return txt ? JSON.parse(txt) : fallback;
  } catch {
    return fallback;
  }
}

function saveJsonAtomic(path, obj) {
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, path);
}

function ensureManualFile() {
  if (!fs.existsSync(MANUAL_FILE)) saveJsonAtomic(MANUAL_FILE, {});
}

/* ===============================
   Item Index
================================ */
ensureManualFile();

function buildIndexes() {
  const base = loadJson(ITEMS_FILE, {});
  const manual = loadJson(MANUAL_FILE, {});
  const merged = { ...base, ...manual };

  const norm = new Map();
  for (const [name, id] of Object.entries(merged)) {
    const key = normalizeKey(name);
    if (key && Number.isFinite(Number(id))) {
      norm.set(key, { name, id: Number(id) });
    }
  }

  console.log(
    `📦 items loaded: base=${Object.keys(base).length} manual=${Object.keys(manual).length} merged=${Object.keys(merged).length}`
  );
  return norm;
}

let ITEM_INDEX = buildIndexes();

/* ===============================
   API Helpers
================================ */
async function fetchJson(url) {
  debug("fetch:", url);
  const res = await fetch(url, { headers: { "User-Agent": "ff14-market-bot/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function getWorlds() {
  if (WORLD_LIST) return WORLD_LIST.split(",").map((w) => w.trim());
  return [WORLD_SINGLE];
}

/* ===============================
   Item Resolve
================================ */
function resolveLocal(query) {
  const hit = ITEM_INDEX.get(normalizeKey(query));
  debug("local resolve:", hit);
  return hit || null;
}

async function resolveViaCafeMaker(queryTw) {
  const queryChs = t2s(queryTw); // ⭐ 繁 → 簡（關鍵）
  debug("fallback CafeMaker, tw:", queryTw, "chs:", queryChs);

  const url = `${XIVAPI_BASE}/search?string=${encodeURIComponent(
    queryChs
  )}&indexes=item&language=chs&limit=1`;

  const data = await fetchJson(url);
  const r = data?.Results?.[0];
  if (!r) return null;

  const id = Number(r.ID);
  const nameTw = s2t(r.Name);

  const manual = loadJson(MANUAL_FILE, {});
  manual[nameTw] = id;
  manual[queryTw] = id;
  saveJsonAtomic(MANUAL_FILE, manual);

  ITEM_INDEX = buildIndexes();
  debug("cafemaker resolved:", { id, nameTw });

  return { id, name: nameTw };
}

async function resolveItem(query) {
  return resolveLocal(query) || (await resolveViaCafeMaker(query));
}

/* ===============================
   Discord Bot
================================ */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📌 PRICE_CHANNEL_ID=${PRICE_CHANNEL_ID}`);
  console.log(`🌍 WORLDS=${getWorlds().join(",")}`);
  console.log(`🪲 DEBUG_MODE=${DEBUG_MODE}`);
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (PRICE_CHANNEL_ID && msg.channelId !== PRICE_CHANNEL_ID) return;

  let text = msg.content.trim();
  if (!text) return;

  let query = text.startsWith("!p")
    ? text.slice(2).trim()
    : text.replace(/價格|市價|行情|多少錢|幾錢|查價|查詢|price/gi, "").trim();

  if (!query) return;

  debug("user input:", text, "→ query:", query);

  const item = await resolveItem(query);
  if (!item) {
    return msg.reply(
      DEBUG_MODE
        ? `❌ 找不到物品\n原始輸入：${text}\n解析後：${query}`
        : `❌ 找不到物品：「${query}」`
    );
  }

  const worlds = getWorlds();
  const prices = [];

  for (const w of worlds) {
    try {
      const data = await fetchJson(
        `https://universalis.app/api/v2/${w}/${item.id}?listings=20&entries=0`
      );
      const min = Math.min(...data.listings.map((l) => l.pricePerUnit));
      if (Number.isFinite(min)) prices.push({ w, min });
    } catch (e) {
      debug("market fail:", w, e.message);
    }
  }

  if (!prices.length) return msg.reply("⚠️ 查不到任何價格資料");

  prices.sort((a, b) => a.min - b.min);
  const best = prices[0];

  const embed = new EmbedBuilder()
    .setTitle(`📦 ${item.name}`)
    .setDescription(`🥇 **${displayWorldName(best.w)}**：**${best.min.toLocaleString()}** gil`)
    .setFooter({ text: DEBUG_MODE ? "🪲 Debug Mode ON" : "" });

  await msg.reply({ embeds: [embed] });
});

client.login(DISCORD_TOKEN);
