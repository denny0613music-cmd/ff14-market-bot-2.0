import "dotenv/config";
import http from "http";
import fs from "fs";
import fetch from "node-fetch";
import { createRequire } from "module";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

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
http
  .createServer((_, res) => {
    res.writeHead(200);
    res.end("ok");
  })
  .listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));

/* ===============================
   Env
================================ */
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || "").trim();
const PRICE_CHANNEL_ID = (process.env.PRICE_CHANNEL_ID || "").trim();
const WORLD_LIST = (process.env.WORLD_LIST || "").trim();
const WORLD_SINGLE = (process.env.WORLD || "Bahamut").trim();

// 回覆訊息自動刪除（分鐘）
const AUTO_DELETE_MINUTES = Number(process.env.AUTO_DELETE_MINUTES || 30);
const AUTO_DELETE_MS = Math.max(0, AUTO_DELETE_MINUTES) * 60 * 1000;

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

/** 避免訊息爆量：回覆後 N 分鐘自動刪除 */
function scheduleDelete(discordMessage) {
  if (!AUTO_DELETE_MS) return;
  setTimeout(async () => {
    try {
      await discordMessage.delete();
    } catch (e) {
      // 常見原因：沒權限/訊息已刪除/過期；忽略即可
      debug("auto delete failed:", e?.message || String(e));
    }
  }, AUTO_DELETE_MS);
}

/* ===============================
   Similarity (Levenshtein)
================================ */
function levenshtein(a, b) {
  a = String(a || "");
  b = String(b || "");
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function similarity(a, b) {
  const x = normalizeKey(a);
  const y = normalizeKey(b);
  const maxLen = Math.max(x.length, y.length);
  if (!maxLen) return 0;
  const d = levenshtein(x, y);
  return 1 - d / maxLen;
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
  if (WORLD_LIST) return WORLD_LIST.split(",").map((w) => w.trim()).filter(Boolean);
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

/** 只「找候選」，不寫入 manual（必須使用者按按鈕才寫） */
async function searchCafeMakerCandidates(queryTw, limit = 10) {
  const queryChs = t2s(queryTw); // 繁 → 簡
  debug("cafemaker search, tw:", queryTw, "chs:", queryChs);

  const url = `${XIVAPI_BASE}/search?string=${encodeURIComponent(
    queryChs
  )}&indexes=item&language=chs&limit=${Math.max(5, Math.min(20, limit))}`;

  const data = await fetchJson(url);
  const results = Array.isArray(data?.Results) ? data.Results : [];
  if (!results.length) return [];

  // 依「名稱相似度」排序（以簡中原名比對，避免轉換差異）
  const scored = results
    .map((x) => ({
      id: Number(x.ID),
      nameChs: String(x.Name || "").trim(),
      nameTw: String(s2t(String(x.Name || "").trim())).trim(),
      score: similarity(queryChs, String(x.Name || "")),
    }))
    .filter((x) => Number.isFinite(x.id) && x.id > 0 && x.nameTw);

  scored.sort((a, b) => b.score - a.score);

  // 取前 5 個（顯示）
  return scored.slice(0, 5);
}

function writeAlias(queryTw, picked) {
  const manual = loadJson(MANUAL_FILE, {});
  // 兩個都記：你輸入的繁中 & 該物品繁中名
  manual[queryTw] = picked.id;
  manual[picked.nameTw] = picked.id;
  saveJsonAtomic(MANUAL_FILE, manual);
  ITEM_INDEX = buildIndexes();
}

/* ===============================
   Market Fetch
================================ */
async function fetchPerWorldMinPrices(worlds, itemId) {
  const perWorld = [];
  for (const w of worlds) {
    try {
      const data = await fetchJson(
        `https://universalis.app/api/v2/${encodeURIComponent(w)}/${itemId}?listings=50&entries=0`
      );
      const listings = Array.isArray(data?.listings) ? data.listings : [];
      const mins = listings
        .map((l) => Number(l?.pricePerUnit))
        .filter((n) => Number.isFinite(n) && n > 0);
      const min = mins.length ? Math.min(...mins) : null;
      perWorld.push({ w, min });
    } catch (e) {
      debug("market fail:", w, e.message);
      perWorld.push({ w, min: null });
    }
  }
  return perWorld;
}

function buildPriceEmbed(itemName, perWorld) {
  const valid = perWorld.filter((x) => Number.isFinite(x.min));
  if (!valid.length) return null;

  valid.sort((a, b) => a.min - b.min);
  const best = valid[0];

  const displayRows = [...perWorld].sort((a, b) => {
    const av = Number.isFinite(a.min) ? a.min : Infinity;
    const bv = Number.isFinite(b.min) ? b.min : Infinity;
    return av - bv;
  });

  const embed = new EmbedBuilder()
    .setTitle(`📦 ${itemName}`)
    .setDescription(
      `🥇 **最低價**：**${displayWorldName(best.w)}** ・ **${best.min.toLocaleString()}** gil\n` +
        `（下方列出你設定的所有伺服器最低單價）`
    );

  for (const row of displayRows) {
    const name = displayWorldName(row.w);
    const value = Number.isFinite(row.min) ? `**${row.min.toLocaleString()}** gil` : "—";
    embed.addFields({ name, value, inline: true });
  }

  if (DEBUG_MODE) embed.setFooter({ text: "🪲 Debug Mode ON" });
  return embed;
}

/* ===============================
   Discord Bot
================================ */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// 暫存「候選選擇」狀態（記憶體；Render 重啟會清空—沒關係）
const PENDING = new Map(); // key: customId -> { userId, channelId, queryTw, worlds, candidates, createdAt }

function makePickButtons(candidates, tokenPrefix) {
  const rows = [];
  let row = new ActionRowBuilder();
  let countInRow = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const customId = `${tokenPrefix}:${i}`; // 之後 interaction 會帶回來
    const label = `${i + 1}. ${c.nameTw}`.slice(0, 80);

    const btn = new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(ButtonStyle.Primary);

    row.addComponents(btn);
    countInRow++;

    if (countInRow === 5 || i === candidates.length - 1) {
      rows.push(row);
      row = new ActionRowBuilder();
      countInRow = 0;
    }
  }
  return rows;
}

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📌 PRICE_CHANNEL_ID=${PRICE_CHANNEL_ID}`);
  console.log(`🌍 WORLDS=${getWorlds().join(",")}`);
  console.log(`🪲 DEBUG_MODE=${DEBUG_MODE}`);
  console.log(`🧹 AUTO_DELETE_MINUTES=${AUTO_DELETE_MINUTES}`);
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (PRICE_CHANNEL_ID && msg.channelId !== PRICE_CHANNEL_ID) return;

  const text = msg.content.trim();
  if (!text) return;

  const query = text.startsWith("!p")
    ? text.slice(2).trim()
    : text.replace(/價格|市價|行情|多少錢|幾錢|查價|查詢|price/gi, "").trim();

  if (!query) return;

  debug("user input:", text, "→ query:", query);

  const worlds = getWorlds();

  // 1) 先本地命中
  const local = resolveLocal(query);
  if (local) {
    const perWorld = await fetchPerWorldMinPrices(worlds, local.id);
    const embed = buildPriceEmbed(local.name, perWorld);
    if (!embed) {
      const m = await msg.reply("⚠️ 查不到任何價格資料");
      scheduleDelete(m);
      return;
    }
    const m = await msg.reply({ embeds: [embed] });
    scheduleDelete(m);
    return;
  }

  // 2) 找不到 → 顯示候選按鈕（依相似度排序）
  let candidates = [];
  try {
    candidates = await searchCafeMakerCandidates(query, 20);
  } catch (e) {
    debug("cafemaker search error:", e?.message || String(e));
  }

  if (!candidates.length) {
    const m = await msg.reply(DEBUG_MODE ? `❌ 找不到物品：「${query}」(CafeMaker 無結果)` : `❌ 找不到物品：「${query}」`);
    scheduleDelete(m);
    return;
  }

  // 建立一個 tokenPrefix，避免不同查詢互相打到
  const tokenPrefix = `pick:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const rows = makePickButtons(candidates, tokenPrefix);

  // 訊息內容：顯示候選（名稱+ID）
  const lines = candidates.map((c, idx) => `${idx + 1}) ${c.nameTw}（ID: ${c.id}）`).join("\n");
  const promptText =
    `❓ 找不到「${query}」\n` +
    `請從下列候選選擇正確物品（依名稱相似度排序）：\n` +
    `${lines}\n\n` +
    `✅ 選擇後會自動記住別名：下次直接查得到。`;

  const promptMsg = await msg.reply({ content: promptText, components: rows });
  scheduleDelete(promptMsg);

  // 暫存狀態（30分鐘後自動過期）
  for (let i = 0; i < candidates.length; i++) {
    PENDING.set(`${tokenPrefix}:${i}`, {
      userId: msg.author.id,
      channelId: msg.channelId,
      queryTw: query,
      worlds,
      candidates,
      createdAt: Date.now(),
      promptMessageId: promptMsg.id,
    });
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const key = interaction.customId;
  const state = PENDING.get(key);
  if (!state) return; // 可能超時或已處理

  // 只允許原查詢者點
  if (interaction.user.id !== state.userId) {
    try {
      await interaction.reply({ content: "這個候選清單不是你叫出來的喔 🙂", ephemeral: true });
    } catch {}
    return;
  }

  const idxStr = key.split(":").pop();
  const idx = Number(idxStr);
  const picked = state.candidates[idx];
  if (!picked) {
    try {
      await interaction.reply({ content: "候選已失效，請重新查一次。", ephemeral: true });
    } catch {}
    return;
  }

  // 寫入 alias（只有現在才寫）
  try {
    writeAlias(state.queryTw, picked);
  } catch (e) {
    debug("write alias fail:", e?.message || String(e));
  }

  // 清掉同組 pending，避免重複選
  for (let i = 0; i < state.candidates.length; i++) {
    PENDING.delete(key.replace(/:\d+$/, `:${i}`));
  }

  // 更新 prompt 訊息：移除按鈕（避免再點）
  try {
    await interaction.message.edit({ components: [] });
  } catch {}

  // 回覆查價（跟一般查價同格式）
  await interaction.deferReply(); // 讓 Discord 知道我們在處理
  const perWorld = await fetchPerWorldMinPrices(state.worlds, picked.id);
  const embed = buildPriceEmbed(picked.nameTw, perWorld);

  if (!embed) {
    const m = await interaction.editReply("⚠️ 查不到任何價格資料");
    // interaction.editReply 回的是 message? discord.js 可能回 void；保守處理
    try {
      const replyMsg = await interaction.fetchReply();
      scheduleDelete(replyMsg);
    } catch {}
    return;
  }

  await interaction.editReply({ embeds: [embed] });
  try {
    const replyMsg = await interaction.fetchReply();
    scheduleDelete(replyMsg);
  } catch {}
});

client.login(DISCORD_TOKEN);
