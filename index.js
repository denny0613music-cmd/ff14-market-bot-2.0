import "dotenv/config";
import http from "http";
import fs from "fs";
import path from "path";
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

// 台服 8 世界（你指定）
const WORLD_LIST = (process.env.WORLD_LIST || "巴哈姆特,伊弗利特,利維坦,拉姆,迦樓羅,泰坦,奧汀,鳳凰").trim();

// 回覆訊息自動刪除（分鐘）
const AUTO_DELETE_MINUTES = Number(process.env.AUTO_DELETE_MINUTES || 30);
const AUTO_DELETE_MS = Math.max(0, AUTO_DELETE_MINUTES) * 60 * 1000;

const ITEMS_FILE = "./items_zh_tw.json";
const MANUAL_FILE = (process.env.MANUAL_FILE && process.env.MANUAL_FILE.trim())
  ? process.env.MANUAL_FILE.trim()
  : (fs.existsSync("/data") ? "/data/items_zh_manual.json" : "./items_zh_manual.json");
const XIVAPI_BASE = "https://cafemaker.wakingsands.com";

/* ===============================
   OpenCC
================================ */
// 簡 → 繁（顯示）
const s2t = OpenCC.Converter({ from: "cn", to: "tw" });
// 繁 → 簡（搜尋）
const t2s = OpenCC.Converter({ from: "tw", to: "cn" });

/* ===============================
   Utils
================================ */
function normalizeText(s) {
  // 1) NFKC：全形→半形、相容字統一
  // 2) 去掉零寬字元/不可見空白
  // 3) trim
  return String(s || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width
    .trim();
}

// 用於 key 比對：移除空白/標點，統一常見符號
function normalizeKey(s) {
  return normalizeText(s)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[’'`]/g, "")
    .replace(/[：:]/g, "：")
    .replace(/[，,]/g, "，")
    .replace(/[。．\.]/g, "。")
    .replace(/[【】\[\]\(\)（）]/g, "")
    .replace(/[・·]/g, "");
}

// 針對繁中輸入做「同義字」正規化（只做小範圍，避免歪掉）
function normalizeTwVariants(s) {
  let x = normalizeText(s);
  // 常見：綿/棉（台服常用綿，資料源可能用棉）
  // 這裡不直接替換成單一，而是後面會生成兩個版本。
  // 常見：裏/裡、騎士/騎手（避免硬替換導致錯）
  x = x.replace(/裏/g, "裡");
  return x;
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
   Alias 記憶規則（避免「小牛皮」這種泛詞污染）
================================ */
function isGenericQuery(qTw) {
  const q = normalizeText(qTw);
  // 太短 / 太泛：不記憶
  if (q.length <= 3) return true;

  // 只有一個詞且太短（例如：小牛皮、防水、棉布）
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1 && q.length <= 4) return true;

  // 全是漢字且很短（<=3）已在上面處理；<=4 也可能太泛
  const onlyHan = /^[\p{Script=Han}]+$/u.test(q);
  if (onlyHan && q.length <= 4) return true;

  return false;
}

function shouldRememberAlias(qTw, pickedNameTw) {
  // 只記「具體輸入」；太泛不記
  const rememberQuery = !isGenericQuery(qTw);
  // 物品正式名也做基本防呆：太短不記
  const rememberPicked = !isGenericQuery(pickedNameTw);
  return { rememberQuery, rememberPicked };
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
  return WORLD_LIST.split(",").map((w) => w.trim()).filter(Boolean);
}

/* ===============================
   Item Resolve
================================ */
function resolveLocal(query) {
  const hit = ITEM_INDEX.get(normalizeKey(query));
  debug("local resolve:", hit);
  return hit || null;
}

/* ===============================
   CafeMaker Candidate Search with fallback (退一步搜尋)
================================ */
// 生成查詢變體：原文、綿/棉替換、去掉常見前綴、取尾字等
function generateFallbackQueriesTw(queryTw) {
  const q0 = normalizeTwVariants(queryTw);
  const set = new Set();

  const push = (s) => {
    const t = normalizeText(s);
    if (t) set.add(t);
  };

  push(q0);

  // 綿<->棉 兩種都試
  push(q0.replace(/綿/g, "棉"));
  push(q0.replace(/棉/g, "綿"));

  // 去掉常見修飾詞（只做「開頭」）
  const prefixes = ["耐水", "防水", "耐火", "高級", "特製", "優質", "粗製", "精製", "硬化", "強化", "改良", "研究用的", "重建用的"];
  for (const p of prefixes) {
    if (q0.startsWith(p) && q0.length > p.length) push(q0.slice(p.length));
  }

  // 如果有空白，把前面的詞逐步拿掉（避免查「小牛皮 騎手 運動鞋」只拿到 0）
  const toks = q0.split(/\s+/).filter(Boolean);
  if (toks.length >= 2) {
    for (let i = 1; i < toks.length; i++) {
      push(toks.slice(i).join(" "));
    }
  }

  // 如果沒有空白且字數>=4，取尾部 2~4 字（耐水綿布→綿布）
  const qNoSpace = q0.replace(/\s+/g, "");
  if (qNoSpace.length >= 4) {
    push(qNoSpace.slice(-2));
    push(qNoSpace.slice(-3));
    push(qNoSpace.slice(-4));
  }

  return Array.from(set);
}

async function searchCafeMakerCandidatesWithFallback(queryTw, limit = 20) {
  const tries = generateFallbackQueriesTw(queryTw);
  debug("cafemaker tries:", tries);

  for (const tw of tries) {
    const queryChs = t2s(tw); // 繁 → 簡
    const url = `${XIVAPI_BASE}/search?string=${encodeURIComponent(
      queryChs
    )}&indexes=item&language=chs&limit=${Math.max(10, Math.min(50, limit))}`;

    let data;
    try {
      data = await fetchJson(url);
    } catch (e) {
      debug("cafemaker fetch error:", e?.message || String(e));
      continue;
    }

    const results = Array.isArray(data?.Results) ? data.Results : [];
    if (!results.length) continue;

    // 依「名稱相似度」排序：用簡中 query vs 簡中候選名
    const scored = results
      .map((x) => {
        const id = Number(x.ID);
        const nameChs = String(x.Name || "").trim();
        const nameTw = String(s2t(nameChs)).trim();
        return {
          id,
          nameChs,
          nameTw,
          score: similarity(queryChs, nameChs),
        };
      })
      .filter((x) => Number.isFinite(x.id) && x.id > 0 && x.nameTw);

    scored.sort((a, b) => b.score - a.score);

    // 只顯示前 5 個
    return { usedTw: tw, candidates: scored.slice(0, 5) };
  }

  return { usedTw: "", candidates: [] };
}

function writeAlias(queryTw, picked) {
  const manual = loadJson(MANUAL_FILE, {});
  const { rememberQuery, rememberPicked } = shouldRememberAlias(queryTw, picked.nameTw);

  if (rememberQuery) manual[queryTw] = picked.id;
  if (rememberPicked) manual[picked.nameTw] = picked.id;

  if (rememberQuery || rememberPicked) {
    saveJsonAtomic(MANUAL_FILE, manual);
    ITEM_INDEX = buildIndexes();
  }

  return { rememberQuery, rememberPicked };
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
      `🥇 **最低價**：**${best.w}** ・ **${best.min.toLocaleString()}** gil\n` +
        `（下方列出你設定的所有伺服器最低單價）`
    );

  for (const row of displayRows) {
    const value = Number.isFinite(row.min) ? `**${row.min.toLocaleString()}** gil` : "—";
    embed.addFields({ name: row.w, value, inline: true });
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

// 暫存候選狀態（記憶體）
const PENDING = new Map(); // key: customId -> { userId, queryTw, worlds, candidates }

function makePickButtons(candidates, tokenPrefix) {
  const rows = [];
  let row = new ActionRowBuilder();
  let count = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const customId = `${tokenPrefix}:${i}`;
    const label = `${i + 1}. ${c.nameTw}（${c.id}）`.slice(0, 80);

    const btn = new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(ButtonStyle.Primary);

    row.addComponents(btn);
    count++;

    if (count === 5 || i === candidates.length - 1) {
      rows.push(row);
      row = new ActionRowBuilder();
      count = 0;
    }
  }

  return rows;
}

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📌 PRICE_CHANNEL_ID=${PRICE_CHANNEL_ID}`);
  console.log(`🌍 WORLDS=${getWorlds().join(",")}`);
  console.log(`🧹 AUTO_DELETE_MINUTES=${AUTO_DELETE_MINUTES}`);
  console.log(`🪲 DEBUG_MODE=${DEBUG_MODE}`);
console.log(`💾 MANUAL_FILE=${MANUAL_FILE}`);
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (PRICE_CHANNEL_ID && msg.channelId !== PRICE_CHANNEL_ID) return;

  const text = normalizeText(msg.content);
  if (!text) return;

  const query = text.startsWith("!p") ? normalizeText(text.slice(2)) : text;
  if (!query) return;

  const worlds = getWorlds();

  // 1) 本地命中
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

  // 2) CafeMaker 候選 + 退一步搜尋
  const { usedTw, candidates } = await searchCafeMakerCandidatesWithFallback(query, 40);

  if (!candidates.length) {
    const m = await msg.reply(`❌ 找不到物品：「${query}」`);
    scheduleDelete(m);
    return;
  }

  const tokenPrefix = `pick:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const rows = makePickButtons(candidates, tokenPrefix);

  const lines = candidates.map((c, idx) => `${idx + 1}) ${c.nameTw}（ID: ${c.id}）`).join("\n");
  const willRemember = !isGenericQuery(query);

  const hint =
    willRemember
      ? "✅ 你選擇後會記住這次輸入（別名），下次直接查得到。"
      : "ℹ️ 你這次輸入太短/太泛（例如「小牛皮」），為避免衝突：**不會記住別名**，但會照你選的物品查價。";

  const promptText =
    `❓ 找不到「${query}」\n` +
    (usedTw && usedTw !== query ? `（已用「${usedTw}」做退一步搜尋）\n` : "") +
    `請從下列候選選擇正確物品（依名稱相似度排序）：\n` +
    `${lines}\n\n` +
    `${hint}`;

  const promptMsg = await msg.reply({ content: promptText, components: rows });
  scheduleDelete(promptMsg);

  for (let i = 0; i < candidates.length; i++) {
    PENDING.set(`${tokenPrefix}:${i}`, {
      userId: msg.author.id,
      queryTw: query,
      worlds,
      candidates,
    });
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const key = interaction.customId;
  const state = PENDING.get(key);
  if (!state) return;

  // 只允許原查詢者點
  if (interaction.user.id !== state.userId) {
    try {
      await interaction.reply({ content: "這個候選清單不是你叫出來的喔 🙂", ephemeral: true });
    } catch {}
    return;
  }

  const idx = Number(key.split(":").pop());
  const picked = state.candidates[idx];
  if (!picked) {
    try {
      await interaction.reply({ content: "候選已失效，請重新查一次。", ephemeral: true });
    } catch {}
    return;
  }

  // 清掉同組 pending，避免重複選
  const prefix = key.replace(/:\d+$/, "");
  for (let i = 0; i < state.candidates.length; i++) {
    PENDING.delete(`${prefix}:${i}`);
  }

  // 移除按鈕
  try {
    await interaction.message.edit({ components: [] });
  } catch {}

  // 寫入 alias（只有你選了才寫；且短/泛 query 不寫）
  const mem = writeAlias(state.queryTw, picked);

  await interaction.deferReply();

  const perWorld = await fetchPerWorldMinPrices(state.worlds, picked.id);
  const embed = buildPriceEmbed(picked.nameTw, perWorld);

  if (!embed) {
    await interaction.editReply("⚠️ 查不到任何價格資料");
    try {
      const replyMsg = await interaction.fetchReply();
      scheduleDelete(replyMsg);
    } catch {}
    return;
  }

  const extra =
    mem.rememberQuery || mem.rememberPicked
      ? "✅ 已記住別名（避免下次再選）。"
      : "ℹ️ 這次輸入太泛，未記住別名（避免衝突），但已照你選的物品查價。";

  await interaction.editReply({ content: extra, embeds: [embed] });
  try {
    const replyMsg = await interaction.fetchReply();
    scheduleDelete(replyMsg);
  } catch {}
});

if (!DISCORD_TOKEN) {
  console.log("❌ DISCORD_TOKEN is missing.");
} else {
  client.login(DISCORD_TOKEN);
}
