import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

// 創建 Discord 客戶端，開啟需要的 intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, // 用於訪問伺服器資訊
    GatewayIntentBits.GuildMessages, // 用於讀取訊息
    GatewayIntentBits.MessageContent, // 用於讀取訊息內容
  ]
});

// 當 bot 上線時的訊息
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// 市價查詢 API，從 Universalis 取得單一物品的市場資料
async function getMarketPrice(itemId) {
  const url = `https://universalis.app/api/v2/market/${itemId}`;
  const res = await fetch(url);
  const data = await res.json();
  
  // 假設我們要顯示的是物品的目前價格
  if (data && data.price) {
    return `Price: ${data.price}`;
  } else {
    return 'Market price not found.';
  }
}

// 設定命令，當收到訊息時回應
client.on('messageCreate', async (message) => {
  // 忽略機器人發出的訊息
  if (message.author.bot) return;

  // 如果訊息是 "!market"
  if (message.content.toLowerCase() === '!market') {
    // 創建按鈕
    const button = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('check_price')
        .setLabel('Check Market Price')
        .setStyle(ButtonStyle.Primary)
    );

    // 發送按鈕
    await message.reply({
      content: 'Click the button below to check the market price.',
      components: [button],
    });
  }
});

// 處理按鈕互動
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === 'check_price') {
    // 假設你要查詢的物品 ID 是 1675（這是「鐵礦」的 ID）
    const itemId = '1675'; // 你可以根據需要替換成其他物品的 ID
    const price = await getMarketPrice(itemId);
    await interaction.reply(`Fetching the market price for item ${itemId}...\n${price}`);
  }
});

// 登入 bot
client.login(process.env.BOT_TOKEN);
