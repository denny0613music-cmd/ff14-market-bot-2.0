import { Client, GatewayIntentBits, SlashCommandBuilder } from 'discord.js';
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
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  
  // 註冊 Slash Command
  try {
    await client.application.commands.create(
      new SlashCommandBuilder()
        .setName('price')
        .setDescription('查詢物品市場價格')
        .addStringOption(option =>
          option.setName('item')
            .setDescription('輸入物品名稱')
            .setRequired(true)
        )
    );
    console.log('Slash command /price created!');
  } catch (error) {
    console.error('Error registering Slash command:', error);
  }
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

// 處理 Slash Command
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === 'price') {
    const keyword = interaction.options.getString('item');
    
    if (!keyword) {
      return interaction.reply('請提供要查詢的物品名稱。');
    }

    const itemId = itemLookup[keyword];
    if (!itemId) {
      return interaction.reply(`找不到與 "${keyword}" 匹配的物品。`);
    }

    const price = await getMarketPrice(itemId);
    await interaction.reply(`你查詢的物品是：${keyword}\n價格：${price}`);
  }
});

// 登入 Bot
client.login(process.env.BOT_TOKEN);
