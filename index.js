require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const fetch = require('node-fetch');

// 初始化 Discord Bot，啟用必要的 intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,            // 伺服器信息
    GatewayIntentBits.MessageContent,    // 讀取訊息內容
    GatewayIntentBits.GuildMembers,      // 監控成員變動
  ]
});

// 當 Bot 啟動後
client.once('ready', () => {
  console.log('Bot is online!');
});

// 當 Bot 收到訊息時觸發
client.on('messageCreate', async (message) => {
  if (message.content.startsWith('!查詢')) {
    // 擷取查詢字詞
    const query = message.content.slice(3).trim().toLowerCase();

    // 模擬物品對照資料（實際情況應從檔案讀取）
    const itemMapping = [
      { id: '1', name: '火之石' },
      { id: '2', name: '水之石' },
    ];

    const matchingItems = itemMapping.filter(item => item.name.includes(query));

    if (matchingItems.length === 0) {
      message.channel.send('沒有找到相關物品');
    } else {
      // 創建按鈕
      const row = new ActionRowBuilder();
      matchingItems.forEach(item => {
        row.addComponents(
          new ButtonBuilder()
            .setLabel(item.name)
            .setCustomId(`item_${item.id}`)
            .setStyle('PRIMARY')
        );
      });

      // 發送訊息並顯示按鈕
      message.channel.send({ content: '請選擇一個物品:', components: [row] });
    }
  }
});

// 當用戶點擊按鈕時觸發
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const [_, itemId] = interaction.customId.split('_');
  const item = { id: itemId, name: '火之石' }; // 簡單模擬，實際情況應從資料庫或檔案中查詢

  // 這裡可以換成您從 Universalis 抓取的資料
  interaction.reply(`物品: ${item.name}\n價格: 1000 金幣`);
});

// 登入 Bot，使用 .env 中的 BOT_TOKEN
client.login(process.env.BOT_TOKEN);
