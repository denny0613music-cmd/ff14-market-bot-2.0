import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import dotenv from 'dotenv';
import fetch from 'node-fetch';  // 正確導入 node-fetch
import http from 'http';  // 用於設定 HTTP 伺服器

dotenv.config();

// 設定 Bot 的 intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// 當 Bot 上線後顯示訊息
client.once('clientReady', () => {  // 改為 clientReady
  console.log(`Logged in as ${client.user.tag}`);
});

// 市場價格查詢
async function getMarketPrice(itemId) {
  const url = `https://universalis.app/api/v2/market/${itemId}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data && data.price) {
    return `Price: ${data.price.min}`;
  } else {
    return 'Market price not found.';
  }
}

const itemLookup = {
  "鐵礦": 1675,
  "魔法水": 1676,
};

// HTTP 伺服器設定
const PORT = process.env.PORT || 10000;  // 使用 Render 提供的端口
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('FF14 Market Bot is running');
}).listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

// 設定指令，當收到訊息時回應
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content.toLowerCase().startsWith('!market')) {
    const keyword = message.content.slice(7).trim();

    if (!keyword) {
      return message.reply('Please provide a keyword to search for.');
    }

    const itemId = itemLookup[keyword];
    if (!itemId) {
      return message.reply(`Could not find an item matching: ${keyword}`);
    }

    const price = await getMarketPrice(itemId);
    await message.reply(`Fetching the market price for ${keyword}...\n${price}`);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === 'check_price') {
    const itemId = '1675';  // 假設查詢的物品 ID
    const price = await getMarketPrice(itemId);
    await interaction.reply(`Fetching the market price for item ${itemId}...\n${price}`);
  }
});

// 登入 Bot
client.login(process.env.BOT_TOKEN);
