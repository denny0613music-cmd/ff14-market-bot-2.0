// === index.js（完整覆蓋版｜模糊詞不綁死＋最多 10 個選項＋成交均價差異%吐槽）===

import "dotenv/config";
import fs from "fs";
import http from "http";
import fetch from "node-fetch";
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
   小工具：格式化 & 吐槽文案
================================ */
function fmtPrice(n) {
  if (n === null || n === undefined) return "—";
  return `${Number(n).toLocaleString()} gil`;
}

function calcDeltaPct(minListing, avgSold) {
  if (!minListing || !avgSold || avgSold <= 0) return null;
  return ((minListing - avgSold) / avgSold) * 100;
}

function moodFromDelta(deltaPct) {
  if (deltaPct === null) {
    const pool = [
      "📭 近期成交太少，我只能用掛單猜一下…（別太信我）",
      "🧐 這東西成交很佛系，行情不好判斷欸",
      "😴 成交資料不夠，我先不亂嘴（但我很想）",
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const d = deltaPct;

  if (d <= -30) {
    const pool = [
      `🟢 低於均價 ${Math.abs(d).toFixed(0)}%：撿到寶啦，快撿！😏`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：這不是折扣，這是禮物 🎁`,
      `🟢 便宜到離譜（-${Math.abs(d).toFixed(0)}%）：商人是不是睡著了？`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (d <= -15) {
    const pool = [
      `🟢 低於均價 ${Math.abs(d).toFixed(0)}%：可以買，真的可以 😌`,
      `🟢 便宜 ${Math.abs(d).toFixed(0)}%：錢包表示：YES ✅`,
      `🟢 比均價低 ${Math.abs(d).toFixed(0)}%：這價位很甜`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (d <= -5) {
    const pool = [
      `🟢 略低於均價 ${Math.abs(d).toFixed(0)}%：小賺一點點也很爽`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：可以，這波不虧`,
      `🟢 比均價便宜 ${Math.abs(d).toFixed(0)}%：手可以滑一下`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (d < 5) {
    const pool = [
      `🟡 接近均價（${d.toFixed(0)}%）：正常價，買不買看心情`,
      `🟡 差不多是行情價（${d.toFixed(0)}%）：不甜也不盤`,
      `🟡 很普通（${d.toFixed(0)}%）：就…市場的樣子`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (d < 15) {
    const pool = [
      `🟠 高於均價 ${d.toFixed(0)}%：有點貴欸…要不要等等？`,
      `🟠 漲 ${d.toFixed(0)}%：商人開始膨脹了 😤`,
      `🟠 比均價貴 ${d.toFixed(0)}%：這價我會先觀望`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (d < 30) {
    const pool = [
      `🔴 高 ${d.toFixed(0)}%：有點盤，小心別衝動 😈`,
      `🔴 比均價貴 ${d.toFixed(0)}%：錢包正在哭`,
      `🔴 漲 ${d.toFixed(0)}%：這價格我不敢推薦（但你可以硬買）`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const pool = [
    `☠️ 高 ${d.toFixed(0)}%：這不是市價，這是信仰價`,
    `☠️ 漲到 ${d.toFixed(0)}%：商人：謝謝你養我`,
    `☠️ ${d.toFixed(0)}%：你買下去我會叫你一聲大哥`,
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

function deltaBadge(deltaPct) {
  if (deltaPct === null) return "";
  const d = deltaPct;
  const sign = d >= 0 ? "+" : "-";
  return `（${sign}${Math.abs(d).toFixed(0)}%）`;
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

  const query = msg.content.trim();
  if (!query) return;

  const manual = loadManual();
  const manualId = manual[query];

  // 🔍 永遠先搜尋
  let data;
  try {
    const res = await fetch(
      `https://cafemaker.wakingsands.com/search?string=${encodeURIComponent(
        t2s(query)
      )}&indexes=item&limit=20`
    );
    data = await res.json();
  } catch {
    await msg.reply("⚠️ 搜尋服務暫時不可用");
    return;
  }

  const results = (data?.Results || []).map((r) => {
    const nameTW = s2t(r.Name);
    return {
      id: Number(r.ID),
      name: nameTW,
      score: similarity(query, nameTW),
    };
  });

  if (!results.length) {
    await msg.reply(`❌ 找不到物品：「${query}」`);
    return;
  }

  // 相似度排序
  results.sort((a, b) => b.score - a.score);

  // ✅ 唯一結果 → 直接查
  if (results.length === 1) {
    await sendPrice(msg, results[0].id, results[0].name);
    return;
  }

  // 🔘 多結果 → 顯示最多 10 個（manual 只是排序提示）
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

  const prompt = await msg.reply({
    content: `❓ 找到多個「${query}」相關物品，請選擇：`,
    components: rows,
  });

  const collector = prompt.createMessageComponentCollector({ time: 60000 });

  collector.on("collect", async (i) => {
    if (i.user.id !== msg.author.id) return;

    const pickedId = Number(i.customId.replace("pick_", ""));
    const picked = top.find((t) => t.id === pickedId);
    if (!picked) return;

    manual[query] = pickedId;
    saveManual(manual);

    await i.update({ content: `✅ 已選擇：${picked.name}`, components: [] });
    await sendPrice(msg, picked.id, picked.name);
  });
});

/* ===============================
   查價（加入成交均價與差異%）
================================ */
async function sendPrice(msg, itemId, itemName) {
  // 7 天（秒）
  const WITHIN_7D = 7 * 24 * 60 * 60;

  const prices = [];

  for (const w of WORLD_LIST) {
    try {
      // entriesWithin/statsWithin 讓 API 回傳近期成交統計（averagePrice / currentAveragePrice）
      const url = `https://universalis.app/api/v2/${encodeURIComponent(
        w
      )}/${itemId}?listings=20&entries=20&entriesWithin=${WITHIN_7D}&statsWithin=${WITHIN_7D}`;

      const r = await fetch(url);
      const d = await r.json();

      const min = d.listings?.length
        ? Math.min(...d.listings.map((l) => l.pricePerUnit))
        : null;

      // 優先用 averagePrice，其次 currentAveragePrice
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

  const embed = new EmbedBuilder()
    .setTitle(`📦 ${itemName}`)
    .setDescription(
      `🥇 最低價：${best.world} ・ ${fmtPrice(best.price)} ${deltaBadge(best.deltaPct)}\n` +
        `📊 近 7 天成交均價：${best.avgSold ? fmtPrice(best.avgSold) : "—"}`
    )
    .setFooter({ text: moodFromDelta(best.deltaPct) });

  // 每個伺服器欄位：最低價 + 差異%
  prices.forEach((p) => {
    const value =
      p.price === null
        ? "—"
        : `${fmtPrice(p.price)} ${deltaBadge(p.deltaPct)}${
            p.avgSold ? `\n均價：${fmtPrice(p.avgSold)}` : ""
          }`;

    embed.addFields({
      name: p.world,
      value,
      inline: true,
    });
  });

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
