import "dotenv/config";
import http from "http";
import fs from "fs";
import fetch from "node-fetch";
import { createRequire } from "module";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

const require = createRequire(import.meta.url);
const OpenCC = require("opencc-js"); // ✅ CJS 方式載入，Render/Node22 穩

/* ===============================
   Render 健康檢查（一定要）
================================ */
const PORT = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
  })
  .listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));

/* ===============================
   Env
================================ */
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || "").trim();
if (!DISCORD_TOKEN) console.warn("⚠️ Missing DISCORD_TOKEN / BOT_TOKEN");

const PRICE_CHANNEL_ID = (process.env.PRICE_CHANNEL_ID || "").trim();

const WORLD_LIST = (process.env.WORLD_LIST || "").trim();
const WORLD_SINGLE = (process.env.WORLD || "Bahamut").trim();

const ITEMS_FILE = "./items_zh_tw.json";
const MANUAL_FILE = "./items_zh_manual.json";

const XIVAPI_BASE = "https://cafemaker.wakingsands.com";

// ✅ 等效 s2t：cn -> tw（依你需求）
const s2t = OpenCC.Converter({ from: "cn", to: "tw" });

/* ===============================
   台服伺服器名稱（顯示用：繁中）
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

function displayWorldName(world) {
  return WORLD_NAME_ZH[world] || world;
}

function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[’'`]/g, "")
    .replace(/\s+/g, "")
    .replace(/[：:]/g, "：");
}

function loadJson(path, fallback = {}) {
  try {
    if (!fs.existsSync(path)) return fallback;
    const txt = fs.readFileSync(path, "utf8").trim();
    if (!txt) return fallback;
    return JSON.parse(txt);
  } catch (e) {
    console.warn(`⚠️ Failed to read ${path}: ${e.message || e}`);
    return fallback;
  }
}

function saveJsonAtomic(path, obj) {
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, path);
}

function ensureManualFileExists() {
  if (!fs.existsSync(MANUAL_FILE)) saveJsonAtomic(MANUAL_FILE, {});
}

function buildIndexes() {
  const base = loadJson(ITEMS_FILE, {});
  const manual = loadJson(MANUAL_FILE, {});
  const merged = { ...base, ...manual };

  const norm = new Map();
  for (const [name, id] of Object.entries(merged)) {
    const n = normalizeKey(name);
    const nId = Number(id);
    if (!n || !Number.isFinite(nId)) continue;

    const cur = norm.get(n);
    if (!cur || nId < cur.id) norm.set(n, { name, id: nId });
  }

  console.log(
    `📦 items loaded: base=${Object.keys(base).length} manual=${Object.keys(manual).length} merged=${Object.keys(merged).length}`
  );
  return { base, manual, merged, norm };
}

ensureManualFileExists();
let indexes = buildIndexes();

async function fetchJson(url, retry = 3) {
  for (let i = 0; i < retry; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "ff14-market-bot/1.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retry - 1) throw e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  return null;
}

function toZhtw(chs) {
  const t = String(chs || "").trim();
  if (!t) return "";
  try {
    return String(s2t(t)).trim();
  } catch {
    return t;
  }
}

function getWorlds() {
  if (WORLD_LIST) return WORLD_LIST.split(",").map((s) => s.trim()).filter(Boolean);
  return [WORLD_SINGLE];
}

async function fetchMarket(world, itemId) {
  const url = `https://universalis.app/api/v2/${encodeURIComponent(world)}/${itemId}?listings=20&entries=0`;
  const data = await fetchJson(url, 4);
  return data;
}

function getMinPrice(listings) {
  if (!Array.isArray(listings) || listings.length === 0) return null;
  let min = null;
  for (const l of listings) {
    const p = Number(l?.pricePerUnit);
    if (!Number.isFinite(p)) continue;
    if (min == null || p < min) min = p;
  }
  return min;
}

function resolveFromLocal(query) {
  const q = normalizeKey(query);
  const hit = indexes.norm.get(q);
  return hit?.id ? { id: hit.id, name: hit.name } : null;
}

async function resolveViaCafeMaker(query) {
  const q = String(query || "").trim();
  if (!q) return null;

  const url = `${XIVAPI_BASE}/search?string=${encodeURIComponent(q)}&indexes=item&language=chs&limit=5`;
  const data = await fetchJson(url, 3);
  const results = Array.isArray(data?.Results) ? data.Results : [];
  if (!results.length) return null;

  const best = results[0];
  const id = Number(best?.ID);
  const nameChs = String(best?.Name || "").trim();
  if (!Number.isFinite(id) || !nameChs) return null;

  const nameZhtw = toZhtw(nameChs) || nameChs;

  // 寫入 manual：使用者原輸入 + 正式繁中名
  const manual = loadJson(MANUAL_FILE, {});
  manual[nameZhtw] = id;
  manual[q] = id;
  saveJsonAtomic(MANUAL_FILE, manual);
  indexes = buildIndexes();

  return { id, name: nameZhtw, source: "cafemaker" };
}

async function resolveItem(query) {
  const local = resolveFromLocal(query);
  if (local) return local;

  try {
    const r = await resolveViaCafeMaker(query);
    if (r?.id) return r;
  } catch (e) {
    console.warn(`⚠️ CafeMaker resolve failed: ${e.message || e}`);
  }
  return null;
}

/* ===============================
   Discord Bot
================================ */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📌 PRICE_CHANNEL_ID=${PRICE_CHANNEL_ID || "(not set - reply everywhere)"}`);
  console.log(`🌍 WORLDS=${getWorlds().join(",")}`);
});

const replied = new Set();
function markReplied(id) {
  replied.add(id);
  setTimeout(() => replied.delete(id), 10_000);
}

client.on("messageCreate", async (message) => {
  try {
    if (!message?.content) return;
    if (message.author?.bot) return;
    if (replied.has(message.id)) return;

    if (PRICE_CHANNEL_ID && message.channelId !== PRICE_CHANNEL_ID) return;

    const text = message.content.trim();
    if (!text) return;

    let query = text;
    if (text.toLowerCase().startsWith("!p")) query = text.slice(2).trim();

    const isPriceIntent = /多少錢|幾錢|價格|行情|市價|price|查價/i.test(text);
    const localHit = resolveFromLocal(query)?.id;
    if (!text.toLowerCase().startsWith("!p") && !isPriceIntent && !localHit) return;
    if (!query) return;

    markReplied(message.id);
    await message.channel.sendTyping();

    const resolved = await resolveItem(query);
    if (!resolved) return message.reply(`❌ 找不到物品：「${query}」\n貼更完整名稱再試一次。`);

    const worlds = getWorlds();
    const results = await Promise.allSettled(
      worlds.map(async (w) => {
        const data = await fetchMarket(w, resolved.id);
        const min = getMinPrice(data?.listings);
        return { world: w, min };
      })
    );

    const cleaned = results.map((r, i) => (r.status === "fulfilled" ? r.value : { world: worlds[i], min: null }));
    const available = cleaned.filter((x) => x.min != null).sort((a, b) => a.min - b.min);
    const best = available[0] || null;

    const embed = new EmbedBuilder()
      .setTitle(`📦 ${resolved.name}`)
      .setDescription(`🆔 ItemID: **${resolved.id}**`)
      .addFields({
        name: "🥇 最低價",
        value: best
          ? `**${displayWorldName(best.world)}**：**${best.min.toLocaleString()}** gil`
          : "查不到任何上架資料",
      });

    const lines = cleaned
      .map((x) => `• ${displayWorldName(x.world)}：${x.min == null ? "—" : `${x.min.toLocaleString()} gil`}`)
      .slice(0, 12);
    embed.addFields({ name: "📋 各服最低單價", value: lines.join("\n") || "—" });

    return message.reply({ embeds: [embed] });
  } catch (e) {
    console.error(e);
    return message.reply(`⚠️ 發生錯誤：${String(e.message || e)}`);
  }
});

client.login(DISCORD_TOKEN);
