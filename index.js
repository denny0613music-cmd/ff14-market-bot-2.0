import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
import fetch from 'node-fetch';  // 正確導入 node-fetch

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
client.once('ready', () => {
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

// 處理訊息命令
client.on('messageCreate', async (message) => {
  // 忽略機器人自己的訊息
  if (message.author.bot) return;

  // 如果訊息是 "!P"
  if (message.content.startsWith('!P')) {
    const keyword = message.content.slice(3).trim();  // 取出 "!P" 後的物品名稱
    
    if (!keyword) {
      return message.reply('請提供要查詢的物品名稱。');
    }

    const itemId = itemLookup[keyword];
    if (!itemId) {
      return message.reply(`找不到與 "${keyword}" 匹配的物品。`);
    }

    const price = await getMarketPrice(itemId);
    await message.reply(`你查詢的物品是：${keyword}\n價格：${price}`);
  }
});

// 登入 Bot
client.login(process.env.BOT_TOKEN);
