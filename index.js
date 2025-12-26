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
import OpenCC from "opencc-js";

/* ===============================
   基本設定
================================ */
const PORT = process.env.PORT || 10000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PRICE_CHANNEL_ID = process.env.PRICE_CHANNEL_ID;
const WORLD_LIST = (process.env.WORLD_LIST || "").split(",").map(v => v.trim()).filter(Boolean);
const AUTO_DELETE_MINUTES = Number(process.env.AUTO_DELETE_MINUTES || 30);
const DEBUG_MODE = String(process.env.DEBUG_MODE).toLowerCase() === "true";

/* ===============================
   Render health check
================================ */
http.createServer((_, res) => {
  res.writeHead(200);
  res.end("ok");
}).listen(PORT, () => {
  console.log(`HTTP server listening on ${PORT}`);
});

/* ===============================
   OpenCC
================================ */
const t2s = OpenCC.Converter({ from: "tw", to: "cn" });
const s2t = OpenCC.Converter({ from: "cn", to: "tw" });

/* ===============================
   資料檔（Render Disk）
================================ */
const MANUAL_FILE = fs.existsSync("/data")
  ? "/data/items_zh_manual.json"
  : "./items_zh_manual.json";

if (!fs.existsSync(MANUAL_FILE)) {
  fs.writeFileSync(MANUAL_FILE, "{}", "utf8");
}

function loadManual() {
  try {
    return JSON.parse(fs.readFileSync(MANUAL_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveManual(data) {
  fs.writeFileSync(MANUAL_FILE, JSON.stringify(data, null, 2), "utf8");
}

/* ===============================
   相似度（Levenshtein）
================================ */
function similarity(a, b) {
  if (!a || !b) return 0;
  const dp = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0)
  );
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  const dist = dp[a.length][b.length];
  return 1 - dist / Math.max(a.length, b.length);
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
  console.log(`📌 PRICE_CHANNEL_ID=${PRICE_CHANNEL_ID}`);
  console.log(`🌍 WORLDS=${WORLD_LIST.join(",")}`);
  console.log(`🧹 AUTO_DELETE_MINUTES=${AUTO_DELETE_MINUTES}`);
  console.log(`🪲 DEBUG_MODE=${DEBUG_MODE}`);
  console.log(`💾 MANUAL_FILE=${MANUAL_FILE}`);
});

/* ===============================
   查價主流程
================================ */
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (PRICE_CHANNEL_ID && msg.channelId !== PRICE_CHANNEL_ID) return;

  const query = msg.content.trim();
  if (!query) return;

  const manual = loadManual();
  const manualHit = manual[query];

  let itemId = manualHit || null;
  let itemName = query;

  /* ===== 手動已記住 ===== */
  if (!itemId) {
    const qCN = t2s(query);

    const res = await fetch(
      `https://cafemaker.wakingsands.com/search?string=${encodeURIComponent(
        qCN
      )}&indexes=item&limit=20`
    );
    const data = await res.json();
    const results = (data.Results || []).map(r => ({
      id: r.ID,
      name: s2t(r.Name),
      score: similarity(query, s2t(r.Name)),
    }));

    if (!results.length) {
      await msg.reply(`❌ 找不到物品：「${query}」`);
      return;
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, 5);

    const row = new ActionRowBuilder();
    top.forEach((r, i) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`pick_${r.id}`)
          .setLabel(`${i + 1}) ${r.name}`)
          .setStyle(ButtonStyle.Primary)
      );
    });

    const prompt = await msg.reply({
      content: `❓ 找不到「${query}」\n請從下列候選選擇正確物品：`,
      components: [row],
    });

    const collector = prompt.createMessageComponentCollector({
      time: 60000,
    });

    collector.on("collect", async (i) => {
      if (i.user.id !== msg.author.id) {
        await i.reply({ content: "這不是給你的選項喔", ephemeral: true });
        return;
      }

      const pickedId = Number(i.customId.replace("pick_", ""));
      const picked = top.find(t => t.id === pickedId);
      if (!picked) return;

      manual[query] = pickedId;
      saveManual(manual);

      await i.update({ content: `📦 ${picked.name}`, components: [] });

      itemId = pickedId;
      itemName = picked.name;
      await sendPrice(msg, itemId, itemName);
    });

    return;
  }

  await sendPrice(msg, itemId, itemName);
});

/* ===============================
   查 Universalis
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
        ? Math.min(...d.listings.map(l => l.pricePerUnit))
        : null;
      prices.push({ world: w, price: min });
    } catch {
      prices.push({ world: w, price: null });
    }
  }

  const valid = prices.filter(p => p.price !== null);
  if (!valid.length) {
    await msg.reply("⚠️ 查不到任何價格資料");
    return;
  }

  valid.sort((a, b) => a.price - b.price);
  const best = valid[0];

  const embed = new EmbedBuilder()
    .setTitle(`📦 ${itemName}`)
    .setDescription(`🥇 最低價：${best.world} ・ ${best.price.toLocaleString()} gil`);

  prices.forEach(p => {
    embed.addFields({
      name: p.world,
      value: p.price ? `${p.price.toLocaleString()} gil` : "—",
      inline: true,
    });
  });

  const reply = await msg.reply({ embeds: [embed] });

  setTimeout(() => {
    reply.delete().catch(() => {});
  }, AUTO_DELETE_MINUTES * 60 * 1000);
}

/* ===============================
   Login
================================ */
client.login(DISCORD_TOKEN);
