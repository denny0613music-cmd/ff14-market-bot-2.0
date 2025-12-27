// === index.js（完整覆蓋版｜三層防線 + 分級學習 + 表格UI + 成交均價差異%吐槽 + 大分類瀏覽）===

import "dotenv/config";
import fs from "fs";
import http from "http";
import fetch from "node-fetch";
import pLimit from "p-limit";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { Converter } from "opencc-js";

/* ===============================
   基本設定
================================ */
const PORT = process.env.PORT || 10000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN?.trim();
const PRICE_CHANNEL_ID = process.env.PRICE_CHANNEL_ID;

const WORLD_LIST = (process.env.WORLD_LIST || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const AUTO_DELETE_MINUTES = Number(process.env.AUTO_DELETE_MINUTES || 30);

/**
 * 分級學習：
 * - 長度 <= 2：不寫 manual / term_map（仍可模糊搜尋、仍可選、仍可查）
 * - 長度 >= 3：可寫 manual（省下次點選）
 * - term_map：只有「救援搜尋」且 query 長度 >= 4 才自動寫（更保守）
 */
const MANUAL_LEARN_MIN_LEN = 3;
const TERM_MAP_LEARN_MIN_LEN = 4;

/**
 * 大分類瀏覽：
 * - 你可以輸入：地圖 或 (地圖) 或 分類 地圖
 * - 會先顯示「子分類」(依 ItemSearchCategory / ItemUICategory 或地圖特殊規則)
 * - 點子分類後，列出該分類底下的物品（可翻頁/可點選查價）
 */
const CATEGORY_TRIGGER_PREFIX = "分類 ";
const CATEGORY_PAGE_SIZE = 10;     // 子分類每頁
const ITEM_PAGE_SIZE = 10;         // 物品每頁（與原本多結果一致）
const CATEGORY_SEARCH_LIMIT = 180; // 每個 seed 最多抓多少候選
const CATEGORY_META_CONCURRENCY = Number(process.env.CATEGORY_META_CONCURRENCY || 6);

/* ===============================
   Render health check
================================ */
http
  .createServer((_, res) => {
    res.writeHead(200);
    res.end("ok");
  })
  .listen(PORT);

/* ===============================
   OpenCC
================================ */
const t2s = Converter({ from: "tw", to: "cn" });
const s2t = Converter({ from: "cn", to: "tw" });

/* ===============================
   Render Disk（保留資料）
================================ */
const MANUAL_FILE = fs.existsSync("/data")
  ? "/data/items_zh_manual.json"
  : "./items_zh_manual.json";

if (!fs.existsSync(MANUAL_FILE)) {
  fs.writeFileSync(MANUAL_FILE, "{}", "utf8");
}

const loadManual = () => {
  try {
    return JSON.parse(fs.readFileSync(MANUAL_FILE, "utf8"));
  } catch {
    return {};
  }
};

const saveManual = (data) => {
  fs.writeFileSync(MANUAL_FILE, JSON.stringify(data, null, 2), "utf8");
};

/* ===============================
   term_map（台服用語 ↔ 資料源用語）
================================ */
const TERM_MAP_FILE = fs.existsSync("/data")
  ? "/data/term_map.json"
  : "./term_map.json";

const DEFAULT_TERM_MAP = {
  咕波: "庫啵",
  咕波裝備箱: "庫啵裝備箱",
  咕波箱: "庫啵裝備箱",
};

function loadTermMap() {
  if (!fs.existsSync(TERM_MAP_FILE)) return { ...DEFAULT_TERM_MAP };
  try {
    const raw = JSON.parse(fs.readFileSync(TERM_MAP_FILE, "utf8"));
    return { ...DEFAULT_TERM_MAP, ...(raw || {}) };
  } catch {
    return { ...DEFAULT_TERM_MAP };
  }
}

function saveTermMap(map) {
  try {
    fs.writeFileSync(TERM_MAP_FILE, JSON.stringify(map, null, 2), "utf8");
  } catch {
    // ignore
  }
}

function applyTermMap(query, termMap) {
  if (!query) return { mappedQuery: query, used: false, appliedPairs: [] };

  if (termMap[query]) {
    return {
      mappedQuery: termMap[query],
      used: true,
      appliedPairs: [[query, termMap[query]]],
    };
  }

  const keys = Object.keys(termMap).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (k && query.includes(k)) {
      const v = termMap[k];
      const mapped = query.replaceAll(k, v);
      if (mapped !== query)
        return { mappedQuery: mapped, used: true, appliedPairs: [[k, v]] };
      break;
    }
  }

  return { mappedQuery: query, used: false, appliedPairs: [] };
}

/* ===============================
   相似度
================================ */
function similarity(a, b) {
  if (!a || !b) return 0;
  let same = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) same++;
  }
  return same / Math.max(a.length, b.length);
}

/* ===============================
   小工具：格式化 & 吐槽
================================ */
function fmtPrice(n) {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  const pretty = Number.isFinite(num) ? Math.round(num) : n;
  return `${Number(pretty).toLocaleString()} gil`;
}

function fmtPriceCompact(n) {
  // 表格用：去掉 gil，留數字，避免太長
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  const pretty = Number.isFinite(num) ? Math.round(num) : n;
  return `${Number(pretty).toLocaleString()}`;
}

function calcDeltaPct(minListing, avgSold) {
  if (!minListing || !avgSold || avgSold <= 0) return null;
  return ((minListing - avgSold) / avgSold) * 100;
}

function deltaBadge(deltaPct) {
  if (deltaPct === null) return "—";
  const d = deltaPct;
  const sign = d >= 0 ? "+" : "-";
  return `${sign}${Math.abs(d).toFixed(0)}%`;
}

function moodFromDelta(deltaPct) {
  if (deltaPct === null) {
    const pool = [
      "📭 成交資料不足：我只能用掛單猜…（別太信我）",
      "🧐 成交太少：行情不好判斷欸",
      "😴 成交不夠：我先不亂嘴（但我很想）",
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const d = deltaPct;

  if (d <= -30) {
    const pool = [
      `🟢 低於均價 ${Math.abs(d).toFixed(0)}%：撿到寶啦，快撿！😏`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：這不是折扣，這是禮物 🎁`,
      `🟢 便宜到離譜（-${Math.abs(d).toFixed(0)}%）：商人睡著了？`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (d <= -15) {
    const pool = [
      `🟢 低於均價 ${Math.abs(d).toFixed(0)}%：可以買，真的可以 😌`,
      `🟢 便宜 ${Math.abs(d).toFixed(0)}%：錢包表示 YES ✅`,
      `🟢 比均價低 ${Math.abs(d).toFixed(0)}%：這價位很甜`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (d <= -5) {
    const pool = [
      `🟢 略低於均價 ${Math.abs(d).toFixed(0)}%：小賺也很爽`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：可以，這波不虧`,
      `🟢 比均價便宜 ${Math.abs(d).toFixed(0)}%：手可以滑一下`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (d < 5) {
    const pool = [
      `🟡 接近均價（${d.toFixed(0)}%）：正常價，買不買看心情`,
      `🟡 行情價（${d.toFixed(0)}%）：不甜也不盤`,
      `🟡 很普通（${d.toFixed(0)}%）：市場的樣子`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (d < 15) {
    const pool = [
      `🟠 高於均價 ${d.toFixed(0)}%：有點貴…要不要等等？`,
      `🟠 漲 ${d.toFixed(0)}%：商人開始膨脹 😤`,
      `🟠 比均價貴 ${d.toFixed(0)}%：先觀望比較香`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (d < 30) {
    const pool = [
      `🔴 高 ${d.toFixed(0)}%：有點盤，小心別衝動 😈`,
      `🔴 比均價貴 ${d.toFixed(0)}%：錢包正在哭`,
      `🔴 漲 ${d.toFixed(0)}%：我不敢推薦（但你可以硬買）`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const pool = [
    `☠️ 高 ${d.toFixed(0)}%：這不是市價，這是信仰價`,
    `☠️ 漲到 ${d.toFixed(0)}%：商人：謝謝你養我`,
    `☠️ ${d.toFixed(0)}%：你買下去我叫你大哥`,
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ===============================
   表格排版工具（等寬 code block）
================================ */
function strWidth(s) {
  // 粗略：ASCII=1，其他=2（中文寬度）
  let w = 0;
  for (const ch of String(s)) w += ch.charCodeAt(0) <= 0x7f ? 1 : 2;
  return w;
}

function padRight(s, width) {
  s = String(s);
  const w = strWidth(s);
  if (w >= width) return s;
  return s + " ".repeat(width - w);
}

function padLeft(s, width) {
  s = String(s);
  const w = strWidth(s);
  if (w >= width) return s;
  return " ".repeat(width - w) + s;
}

/* ===============================
   CafeMaker：搜尋 / 物品資訊
================================ */
async function cafemakerSearch(query, limit = 20) {
  const url = `https://cafemaker.wakingsands.com/search?string=${encodeURIComponent(
    t2s(query)
  )}&indexes=item&limit=${limit}`;

  const res = await fetch(url);
  const data = await res.json();

  const results = (data?.Results || []).map((r) => {
    const nameTW = s2t(r.Name);
    return {
      id: Number(r.ID),
      name: nameTW,
      score: similarity(query, nameTW),
    };
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}

async function cafemakerGetItemMeta(id) {
  const url = `https://cafemaker.wakingsands.com/item/${id}?language=chs&columns=ID,Name,ItemSearchCategory.Name,ItemUICategory.Name`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();

  const nameTW = s2t(d?.Name || "");
  const isc = s2t(d?.ItemSearchCategory?.Name || "");
  const iuc = s2t(d?.ItemUICategory?.Name || "");

  return {
    id: Number(d?.ID || id),
    name: nameTW || String(id),
    itemSearchCategory: isc || "",
    itemUiCategory: iuc || "",
  };
}

/* ===============================
   救援搜尋（cafemaker）
   【唯一改動】加入 SAFE_SUFFIXES 白名單後綴救援（不影響學習）
================================ */
async function rescueSearch(originalQuery, mappedQuery) {
  const attempts = [];
  const seen = new Set();

  const pushAttempt = (q, reason) => {
    const qq = (q || "").trim();
    if (!qq) return;
    if ([...qq].length < 2) return;
    if (seen.has(qq)) return;
    seen.add(qq);
    attempts.push({ q: qq, reason });
  };

  if (mappedQuery && mappedQuery !== originalQuery) pushAttempt(mappedQuery, "詞彙映射");

  const suffixes = ["裝備箱", "箱子", "寶箱", "套裝", "外套", "手套", "靴", "鞋", "帽", "頭盔"];
  for (const suf of suffixes) {
    if (originalQuery.endsWith(suf) && originalQuery.length > suf.length + 1) {
      pushAttempt(originalQuery.slice(0, -suf.length), `去掉後綴「${suf}」`);
    }
    if (mappedQuery.endsWith(suf) && mappedQuery.length > suf.length + 1) {
      pushAttempt(mappedQuery.slice(0, -suf.length), `去掉後綴「${suf}」(映射後)`);
    }
  }

  if (originalQuery.length >= 4) pushAttempt(originalQuery.slice(0, 3), "取前 3 字");
  if (originalQuery.length >= 3) pushAttempt(originalQuery.slice(0, 2), "取前 2 字");
  if (mappedQuery.length >= 4) pushAttempt(mappedQuery.slice(0, 3), "取前 3 字(映射後)");
  if (mappedQuery.length >= 3) pushAttempt(mappedQuery.slice(0, 2), "取前 2 字(映射後)");

  // === 安全版白名單後綴救援（新增，不影響 term_map / manual）===
  const SAFE_SUFFIXES = ["結晶片", "藏寶圖", "魔紋"];
  for (const suf of SAFE_SUFFIXES) {
    if (originalQuery.endsWith(suf)) {
      pushAttempt(suf, `取後綴「${suf}」`);
    }
    if (mappedQuery.endsWith(suf)) {
      pushAttempt(suf, `取後綴「${suf}」(映射後)`);
    }
  }

  for (const a of attempts) {
    try {
      const results = await cafemakerSearch(a.q, 20);
      if (results.length) return { results, usedQuery: a.q, reason: a.reason };
    } catch {
      // ignore
    }
  }
  return { results: [], usedQuery: null, reason: null };
}

/* ===============================
   大分類瀏覽：規則 / Session
================================ */
const CATEGORY_SEEDS = {
  地圖: ["藏寶圖", "陳舊的藏寶圖", "魔紋", "龍皮", "地圖"],
  礦石: ["礦", "原礦", "礦石", "礦砂", "碎晶"],
  木材: ["原木", "木材", "木", "木板"],
  皮革: ["皮革", "獸皮", "革"],
  布料: ["布", "布料", "絲", "毛線"],
  食材: ["食材", "肉", "魚", "蔬菜", "香料"],
};

function normalizeCategoryInput(raw) {
  let s = (raw || "").trim();
  if (!s) return null;
  const m = s.match(/^\((.+)\)$/);
  if (m && m[1]) s = m[1].trim();
  if (s.startsWith(CATEGORY_TRIGGER_PREFIX)) {
    s = s.slice(CATEGORY_TRIGGER_PREFIX.length).trim();
  }
  return s || null;
}

function isCategoryBrowse(raw) {
  const s = (raw || "").trim();
  if (!s) return false;
  if (s.startsWith(CATEGORY_TRIGGER_PREFIX)) return true;
  if (/^\(.+\)$/.test(s)) return true;
  return Object.prototype.hasOwnProperty.call(CATEGORY_SEEDS, s);
}

function mapSubCategoryName(itemName) {
  const name = String(itemName || "");
  const g = name.match(/G\s*(\d+)/i) || name.match(/Ｇ\s*(\d+)/);
  if (g && g[1]) return `G${g[1]}`;
  if (name.includes("魔紋")) return "魔紋";
  if (name.includes("龍皮")) return "龍皮";
  if (name.includes("陳舊")) return "陳舊";
  if (name.includes("藏寶圖")) return "其他藏寶圖";
  return "其他";
}

function makeSessionId() {
  return Math.random().toString(36).slice(2, 10);
}

const UI_SESSIONS = new Map();
function putSession(sid, obj) {
  UI_SESSIONS.set(sid, { ...obj, updatedAt: Date.now() });
  if (UI_SESSIONS.size > 200) {
    const entries = [...UI_SESSIONS.entries()].sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
    for (let i = 0; i < 50; i++) UI_SESSIONS.delete(entries[i][0]);
  }
}
function getSession(sid) {
  const s = UI_SESSIONS.get(sid);
  if (!s) return null;
  s.updatedAt = Date.now();
  return s;
}
function delSession(sid) {
  UI_SESSIONS.delete(sid);
}

function slicePage(arr, page, pageSize) {
  const p = Math.max(0, Number(page || 0));
  const start = p * pageSize;
  return { page: p, start, end: start + pageSize, total: arr.length, items: arr.slice(start, start + pageSize) };
}

function buildPickRowsFromList(list, sessionId, prefix, page, pageSize) {
  const { page: p, items, total } = slicePage(list, page, pageSize);

  const rows = [];
  for (let i = 0; i < items.length; i += 5) {
    const row = new ActionRowBuilder();
    items.slice(i, i + 5).forEach((it, idx) => {
      const label = `${i + idx + 1 + p * pageSize}. ${it.label}`;
      const idPart = it.key;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${prefix}_${sessionId}_${idPart}`)
          .setLabel(label.slice(0, 80))
          .setStyle(ButtonStyle.Primary)
      );
    });
    rows.push(row);
  }

  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const nav = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`nav_${sessionId}_prev`)
        .setLabel("⬅️ 上一頁")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(p <= 0),
      new ButtonBuilder()
        .setCustomId(`nav_${sessionId}_next`)
        .setLabel("下一頁 ➡️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(p >= maxPage),
    );

  rows.push(nav);
  return { rows, page: p, maxPage };
}

async function buildBrowseCategories(keyword) {
  const key = String(keyword || "").trim();
  if (!key) return { cats: [], items: [] };

  const seeds = CATEGORY_SEEDS[key] || [key];
  const candidates = [];
  const seen = new Set();

  for (const seed of seeds) {
    try {
      const rs = await cafemakerSearch(seed, CATEGORY_SEARCH_LIMIT);
      for (const r of rs) {
        if (!r?.id) continue;
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        candidates.push({ id: r.id, name: r.name });
      }
    } catch {}
  }

  if (!candidates.length) return { cats: [], items: [] };

  const limit = pLimit(CATEGORY_META_CONCURRENCY);
  const metas = [];
  await Promise.allSettled(
    candidates.map((c) =>
      limit(async () => {
        try {
          const m = await cafemakerGetItemMeta(c.id);
          if (m?.id) metas.push(m);
        } catch {}
      })
    )
  );

  const group = new Map();
  for (const m of metas) {
    let label = "";
    let catKey = "";
    if (key === "地圖") {
      label = mapSubCategoryName(m.name);
      catKey = label;
    } else {
      label = m.itemSearchCategory || m.itemUiCategory || "其他";
      catKey = label;
    }
    if (!group.has(catKey)) group.set(catKey, { label, items: [] });
    group.get(catKey).items.push({ id: m.id, name: m.name });
  }

  const cats = [...group.entries()]
    .map(([k, v]) => ({
      key: k,
      label: `${v.label}（${v.items.length}）`,
      rawLabel: v.label,
      items: v.items.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")),
    }))
    .sort((a, b) => b.items.length - a.items.length);

  return { cats, items: metas };
}

/* ===============================
   Discord Client
================================ */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

/* ===============================
   主流程
================================ */
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (PRICE_CHANNEL_ID && msg.channelId !== PRICE_CHANNEL_ID) return;

  const raw = msg.content.trim();
  if (!raw) return;

  if (isCategoryBrowse(raw)) {
    const keyword = normalizeCategoryInput(raw);
    if (!keyword) return;
    await handleCategoryBrowse(msg, keyword);
    return;
  }

  const query = raw;
  const queryLen = [...query].length;

  const manual = loadManual();
  const manualId = manual[query];

  const termMap = loadTermMap();
  const { mappedQuery } = applyTermMap(query, termMap);

  let results = [];
  try {
    results = await cafemakerSearch(query, 20);
  } catch {
    await msg.reply("⚠️ 搜尋服務暫時不可用");
    return;
  }

  let rescueInfo = null;
  if (!results.length) {
    const rescue = await rescueSearch(query, mappedQuery);
    results = rescue.results;
    if (rescue.usedQuery)
      rescueInfo = { usedQuery: rescue.usedQuery, reason: rescue.reason };
  }

  if (!results.length) {
    await msg.reply(
      `❌ 找不到物品：「${query}」\n💡 可能是台服用語與資料源用語不同（例如：咕波/庫啵），或請輸入更完整名稱。`
    );
    return;
  }

  if (results.length === 1) {
    if (rescueInfo && rescueInfo.usedQuery && rescueInfo.usedQuery !== query) {
      if (queryLen >= TERM_MAP_LEARN_MIN_LEN) {
        const tm = loadTermMap();
        tm[query] = rescueInfo.usedQuery;
        saveTermMap(tm);
      }
    }

    if (queryLen >= MANUAL_LEARN_MIN_LEN) {
      const m = loadManual();
      m[query] = results[0].id;
      saveManual(m);
    }

    await sendPrice(msg, results[0].id, results[0].name);
    return;
  }

  const top = results
    .sort((a, b) => (a.id === manualId ? -1 : 1))
    .slice(0, 10);

  const rows = [];
  for (let i = 0; i < top.length; i += 5) {
    const row = new ActionRowBuilder();
    top.slice(i, i + 5).forEach((r, idx) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`pick_${r.id}`)
          .setLabel(`${i + idx + 1}. ${r.name}`)
          .setStyle(ButtonStyle.Primary)
      );
    });
    rows.push(row);
  }

  const hintLine = rescueInfo
    ? `（我用「${rescueInfo.usedQuery}」救援搜尋：${rescueInfo.reason}）\n`
    : "";

  const learnHint =
    queryLen < MANUAL_LEARN_MIN_LEN
      ? "⚠️ 關鍵字太短：我不會把它記住（避免下次被綁死選錯），但你仍可照常選。"
      : "⭐ 我會記住你選的結果，下次更快。";

  const prompt = await msg.reply({
    content: `❓ 找到多個「${query}」相關物品，請選擇：\n${hintLine}${learnHint}`,
    components: rows,
  });

  const collector = prompt.createMessageComponentCollector({ time: 60000 });

  collector.on("collect", async (i) => {
    if (i.user.id !== msg.author.id) return;

    const pickedId = Number(i.customId.replace("pick_", ""));
    const picked = top.find((t) => t.id === pickedId);
    if (!picked) return;

    if (queryLen >= MANUAL_LEARN_MIN_LEN) {
      const m = loadManual();
      m[query] = pickedId;
      saveManual(m);
    }

    if (rescueInfo && rescueInfo.usedQuery && rescueInfo.usedQuery !== query) {
      if (queryLen >= TERM_MAP_LEARN_MIN_LEN) {
        const tm = loadTermMap();
        tm[query] = rescueInfo.usedQuery;
        saveTermMap(tm);
      }
    }

    await i.update({ content: `✅ 已選擇：${picked.name}`, components: [] });
    await sendPrice(msg, picked.id, picked.name);
  });
});

/* ===============================
   大分類瀏覽處理
================================ */
async function handleCategoryBrowse(msg, keyword) {
  const sid = makeSessionId();

  const prompt = await msg.reply({
    content: `🗂️ 正在整理「${keyword}」的分類…（如果很多物品會稍慢一點點）`,
    components: [],
  });

  const built = await buildBrowseCategories(keyword);
  if (!built.cats.length) {
    await prompt.edit(`❌ 我找不到「${keyword}」的分類資料。`);
    return;
  }

  putSession(sid, {
    userId: msg.author.id,
    keyword,
    view: "cats",
    cats: built.cats,
    catPage: 0,
    itemPage: 0,
    currentCatKey: null,
  });

  await renderCategoryView(prompt, sid);

  const collector = prompt.createMessageComponentCollector({ time: 120000 });

  collector.on("collect", async (i) => {
    const sessionId = parseSessionId(i.customId);
    if (!sessionId || sessionId !== sid) return;
    const s = getSession(sessionId);
    if (!s) return;

    if (i.user.id !== s.userId) {
      await i.reply({ content: "🙅‍♀️ 只有發問的人可以操作這個選單喔～", ephemeral: true });
      return;
    }

    try {
      if (i.customId.startsWith(`catpick_${sid}_`)) {
        const catKey = i.customId.replace(`catpick_${sid}_`, "");
        s.view = "items";
        s.currentCatKey = catKey;
        s.itemPage = 0;
        putSession(sid, s);
        await i.deferUpdate();
        await renderItemsView(prompt, sid);
        return;
      }

      if (i.customId.startsWith(`itempick_${sid}_`)) {
        const itemId = Number(i.customId.replace(`itempick_${sid}_`, ""));
        const cat = s.cats.find((c) => c.key === s.currentCatKey);
        const picked = cat?.items?.find((x) => Number(x.id) === itemId);
        await i.update({ content: `✅ 已選擇：${picked?.name || itemId}`, components: [] });
        delSession(sid);
        await sendPrice(msg, itemId, picked?.name || String(itemId));
        return;
      }

      if (i.customId === `nav_${sid}_prev`) {
        await i.deferUpdate();
        if (s.view === "cats") s.catPage = Math.max(0, (s.catPage || 0) - 1);
        else s.itemPage = Math.max(0, (s.itemPage || 0) - 1);
        putSession(sid, s);
        if (s.view === "cats") await renderCategoryView(prompt, sid);
        else await renderItemsView(prompt, sid);
        return;
      }
      if (i.customId === `nav_${sid}_next`) {
        await i.deferUpdate();
        if (s.view === "cats") s.catPage = (s.catPage || 0) + 1;
        else s.itemPage = (s.itemPage || 0) + 1;
        putSession(sid, s);
        if (s.view === "cats") await renderCategoryView(prompt, sid);
        else await renderItemsView(prompt, sid);
        return;
      }

      if (i.customId === `back_${sid}`) {
        await i.deferUpdate();
        s.view = "cats";
        s.currentCatKey = null;
        putSession(sid, s);
        await renderCategoryView(prompt, sid);
        return;
      }
    } catch {}
  });

  collector.on("end", async () => {
    try {
      const s = getSession(sid);
      if (s) delSession(sid);
      await prompt.edit({ components: [] });
    } catch {}
  });
}

function parseSessionId(customId) {
  const parts = String(customId || "").split("_");
  if (parts.length < 2) return null;
  if (parts[0] === "catpick") return parts[1];
  if (parts[0] === "itempick") return parts[1];
  if (parts[0] === "nav") return parts[1];
  if (parts[0] === "back") return parts[1];
  return null;
}

async function renderCategoryView(promptMsg, sid) {
  const s = getSession(sid);
  if (!s) return;

  const list = s.cats.map((c) => ({ key: c.key, label: c.label }));
  const { rows, page, maxPage } = buildPickRowsFromList(list, sid, "catpick", s.catPage || 0, CATEGORY_PAGE_SIZE);

  const hintRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`noop_${sid}`)
      .setLabel(`第 ${page + 1}/${maxPage + 1} 頁｜點分類 → 看物品`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  await promptMsg.edit({
    content:
      `🗂️ **${s.keyword}** 的子分類（點一個來看底下物品）\n` +
      `💡 你也可以直接輸入物品名查價；這裡是「逛分類」模式～`,
    components: [hintRow, ...rows],
  });
}

async function renderItemsView(promptMsg, sid) {
  const s = getSession(sid);
  if (!s) return;

  const cat = s.cats.find((c) => c.key === s.currentCatKey);
  if (!cat) {
    s.view = "cats";
    s.currentCatKey = null;
    putSession(sid, s);
    await renderCategoryView(promptMsg, sid);
    return;
  }

  const list = cat.items.map((it) => ({ key: String(it.id), label: it.name }));
  const { rows, page, maxPage } = buildPickRowsFromList(list, sid, "itempick", s.itemPage || 0, ITEM_PAGE_SIZE);

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`back_${sid}`).setLabel("↩️ 返回分類").setStyle(ButtonStyle.Secondary)
  );

  const hintRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`noop_${sid}`)
      .setLabel(`第 ${page + 1}/${maxPage + 1} 頁｜點物品 → 查價`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  await promptMsg.edit({
    content: `📚 **${s.keyword} → ${cat.rawLabel}** 物品列表（點一個查價）`,
    components: [hintRow, backRow, ...rows],
  });
}

/* ===============================
   查價（成交均價差異%）＋ 表格UI（整齊 + 吐槽對齊）
================================ */
async function sendPrice(msg, itemId, itemName) {
  const WITHIN_7D = 7 * 24 * 60 * 60;

  const prices = [];
  for (const w of WORLD_LIST) {
    try {
      const url = `https://universalis.app/api/v2/${encodeURIComponent(
        w
      )}/${itemId}?listings=20&entries=20&entriesWithin=${WITHIN_7D}&statsWithin=${WITHIN_7D}`;

      const r = await fetch(url);
      const d = await r.json();

      const min = d.listings?.length
        ? Math.min(...d.listings.map((l) => l.pricePerUnit))
        : null;

      const avg = Number(d.averagePrice ?? d.currentAveragePrice ?? NaN);
      const avgSold = Number.isFinite(avg) ? avg : null;

      const deltaPct = calcDeltaPct(min, avgSold);
      prices.push({ world: w, price: min, avgSold, deltaPct });
    } catch {
      prices.push({ world: w, price: null, avgSold: null, deltaPct: null });
    }
  }

  const valid = prices.filter((p) => p.price !== null);
  if (!valid.length) {
    await msg.reply("⚠️ 查不到價格資料");
    return;
  }

  valid.sort((a, b) => a.price - b.price);
  const best = valid[0];

  const worldW = Math.max(6, ...prices.map((p) => strWidth(p.world || "")), 6);
  const priceW = 10;
  const deltaW = 6;
  const avgW = 10;

  const header =
    `${padRight("伺服器", worldW)}  ` +
    `${padLeft("最低", priceW)}  ` +
    `${padLeft("差異", deltaW)}  ` +
    `${padLeft("均價", avgW)}`;

  const sep = "-".repeat(strWidth(header));

  const rows = prices.map((p) => {
    const crown = p.world === best.world ? "🏆" : "  ";
    const priceText = p.price === null ? "—" : fmtPriceCompact(p.price);
    const avgText = p.avgSold === null ? "—" : fmtPriceCompact(p.avgSold);
    const dText = p.deltaPct === null ? "—" : deltaBadge(p.deltaPct);

    return (
      `${crown}${padRight(p.world, worldW)}  ` +
      `${padLeft(priceText, priceW)}  ` +
      `${padLeft(dText, deltaW)}  ` +
      `${padLeft(avgText, avgW)}`
    );
  });

  const table = ["```", header, sep, ...rows, "```"].join("\n");

  const roast = moodFromDelta(best.deltaPct);
  const roastLine = `💬 評語：${roast}`;

  const bestDeltaText = best.deltaPct === null ? "—" : deltaBadge(best.deltaPct);

  const embed = new EmbedBuilder()
    .setTitle(`📦 ${itemName}`)
    .setDescription(
      `🥇 最低價：${best.world} ・ ${fmtPrice(best.price)}（${bestDeltaText}）\n` +
        `📊 近 7 天成交均價：${best.avgSold ? fmtPrice(best.avgSold) : "—"}\n` +
        `${roastLine}\n\n` +
        table
    );

  const reply = await msg.reply({ embeds: [embed] });
  setTimeout(
    () => reply.delete().catch(() => {}),
    AUTO_DELETE_MINUTES * 60 * 1000
  );
}

/* ===============================
   Login
================================ */
client.login(DISCORD_TOKEN);
