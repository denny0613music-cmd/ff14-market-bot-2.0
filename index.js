import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from 'discord.js';
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
client.once('clientReady', () => {
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

// 註冊 Slash Command
client.on('ready', async () => {
  const data = new SlashCommandBuilder()
    .setName('查')
    .setDescription('查詢物品市場價格')
    .addStringOption(option =>
      option.setName('物品')
        .setDescription('輸入物品名稱')
        .setRequired(true)
    );

  await client.application.commands.create(data);
  console.log('Slash command /查 created!');
});

// 處理 Slash Command
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === '查') {
    const keyword = interaction.options.getString('物品');
    
    if (!keyword) {
      return interaction.reply('請提供要查詢的物品名稱。');
    }

    const itemId = itemLookup[keyword];
    if (!itemId) {
      return interaction.reply(`找不到與 "${keyword}" 匹配的物品。`);
    }

    const price = await getMarketPrice(itemId);

    // 建立按鈕選單
    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('check_price')
        .setLabel('查詢價格')
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({
      content: `你查詢的物品是：${keyword}\n價格：${price}`,
      components: [buttonRow],
    });
  }

  // 處理按鈕互動
  if (interaction.isButton()) {
    if (interaction.customId === 'check_price') {
      const itemId = '1675';  // 這是硬編碼的物品 ID，您可以根據需求更新為動態取得
      const price = await getMarketPrice(itemId);
      await interaction.update({
        content: `物品的價格是：${price}`,
        components: []  // 按鈕點擊後會移除
      });
    }
  }
});

// 登入 Bot
client.login(process.env.BOT_TOKEN);
