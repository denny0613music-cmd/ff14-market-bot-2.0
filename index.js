import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import dotenv from 'dotenv';
import fetch from 'node-fetch';  // 正確導入 node-fetch

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

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

client.login(process.env.BOT_TOKEN);
