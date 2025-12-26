// === index.js（完整覆蓋版｜修正模糊詞不綁死）===

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

  // 排序
  results.sort((a, b) => b.score - a.score);

  // ✅ 只有「唯一結果」才自動用
  if (results.length === 1) {
    await sendPrice(msg, results[0].id, results[0].name);
    return;
  }

  // 🔘 多結果 → 顯示選擇（manual 只是排序參考）
  const top = results
    .sort((a, b) => (a.id === manualId ? -1 : 1))
    .slice(0, 5);

  const row = new ActionRowBuilder();
  top.forEach((r, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`pick_${r.id}`)
        .setLabel(`${i + 1}. ${r.name}`)
        .setStyle(ButtonStyle.Primary)
    );
  });

  const prompt = await msg.reply({
    content: `❓ 找到多個「${query}」相關物品，請選擇：`,
    components: [row],
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
   查價
================================ */
async function sendPrice(msg, itemId, itemName) {
  const prices = [];

  for (const w of WORLD_LIST) {
    try {
      const r = await fetch(
        `https://universalis.app/api/v2/${encodeURIComponent(w)}/${itemId}?listings=20`
      );
      const d = await r.json();
      const min = d.listings?.length
        ? Math.min(...d.listings.map((l) => l.pricePerUnit))
        : null;
      prices.push({ world: w, price: min });
    } catch {
      prices.push({ world: w, price: null });
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
      `🥇 最低價：${best.world} ・ ${best.price.toLocaleString()} gil`
    );

  prices.forEach((p) => {
    embed.addFields({
      name: p.world,
      value: p.price ? `${p.price.toLocaleString()} gil` : "—",
      inline: true,
    });
  });

  const reply = await msg.reply({ embeds: [embed] });
  setTimeout(() => reply.delete().catch(() => {}), AUTO_DELETE_MINUTES * 60 * 1000);
}

/* ===============================
   Login
================================ */
client.login(DISCORD_TOKEN);
