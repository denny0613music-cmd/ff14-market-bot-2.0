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
    return `Price: ${data.price.min}`;
  } else {
    return 'Market price not found.';
  }
}

// 物品名稱到 ID 的簡單對照表（你可以根據需要擴展這個對照表）
const itemLookup = {
  "鐵礦": 1675,  // 這是「鐵礦」的 ID，根據需要加入更多物品
  "魔法水": 1676, // 假設「魔法水」的 ID 是 1676
  // 你可以在這裡添加更多對照
};

// 設定命令，當收到訊息時回應
client.on('messageCreate', async (message) => {
  // 忽略機器人發出的訊息
  if (message.author.bot) return;

  // 如果訊息是 "!market"
  if (message.content.toLowerCase().startsWith('!market')) {
    const keyword = message.content.slice(7).trim(); // 取得關鍵字（物品名稱）

    if (!keyword) {
      return message.reply('Please provide a keyword to search for.');
    }

    // 查找物品 ID
    const itemId = itemLookup[keyword];
    if (!itemId) {
      return message.reply(`Could not find an item matching: ${keyword}`);
    }

    // 查詢市價
    const price = await getMarketPrice(itemId);
    await message.reply(`Fetching the market price for ${keyword}...\n${price}`);
  }
});

// 處理按鈕互動（這部分目前不再需要按鈕，因為已經根據關鍵字查詢市價）
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === 'check_price') {
    const itemId = '1675'; // 假設你要查詢的物品 ID 是 1675（這是「鐵礦」的 ID）
    const price = await getMarketPrice(itemId);
    await interaction.reply(`Fetching the market price for item ${itemId}...\n${price}`);
  }
});

// 登入 bot
client.login(process.env.BOT_TOKEN);
