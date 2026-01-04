// === index.js（完整覆蓋版｜三層防線 + 分級學習 + 表格UI + 成交均價差異%吐槽 + 大分類瀏覽）===

import "dotenv/config";
import fs from "fs";
import http from "http";
import fetch from "node-fetch";
import pLimit from "p-limit";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
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

/**
 * 分級學習：
 * - 長度 <= 2：不寫 manual / term_map（仍可模糊搜尋、仍可選、仍可查）
 * - 長度 >= 3：可寫 manual（省下次點選）
 * - term_map：只有「救援搜尋」且 query 長度 >= 4 才自動寫（更保守）
 */
const MANUAL_LEARN_MIN_LEN = 3;
const TERM_MAP_LEARN_MIN_LEN = 4;

/**
 * 大分類瀏覽：
 * - 你可以輸入：地圖 或 (地圖) 或 分類 地圖
 * - 會先顯示「子分類」(依 ItemSearchCategory / ItemUICategory 或地圖特殊規則)
 * - 點子分類後，列出該分類底下的物品（可翻頁/可點選查價）
 */
const CATEGORY_TRIGGER_PREFIX = "分類 ";
const CATEGORY_PAGE_SIZE = 10;     // 子分類每頁
const ITEM_PAGE_SIZE = 10;         // 物品每頁（與原本多結果一致）
const CATEGORY_SEARCH_LIMIT = 180; // 每個 seed 最多抓多少候選
const CATEGORY_META_CONCURRENCY = Number(process.env.CATEGORY_META_CONCURRENCY || 6);

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
   term_map（台服用語 ↔ 資料源用語）
================================ */
const TERM_MAP_FILE = fs.existsSync("/data")
  ? "/data/term_map.json"
  : "./term_map.json";

const DEFAULT_TERM_MAP = {
  咕波: "庫啵",
  咕波裝備箱: "庫啵裝備箱",
  咕波箱: "庫啵裝備箱",
  紅蘿蔔: "胡蘿蔔",
  山雞蟾蜍: "山雞",
  卡札納爾: "卡扎纳尔",
  鯰魚精: "鲶鱼精",
};

function loadTermMap() {
  if (!fs.existsSync(TERM_MAP_FILE)) return { ...DEFAULT_TERM_MAP };
  try {
    const raw = JSON.parse(fs.readFileSync(TERM_MAP_FILE, "utf8"));
    return { ...DEFAULT_TERM_MAP, ...(raw || {}) };
  } catch {
    return { ...DEFAULT_TERM_MAP };
  }
}

function saveTermMap(map) {
  try {
    fs.writeFileSync(TERM_MAP_FILE, JSON.stringify(map, null, 2), "utf8");
  } catch {
    // ignore
  }
}

function applyTermMap(query, termMap) {
  if (!query) return { mappedQuery: query, used: false, appliedPairs: [] };

  if (termMap[query]) {
    return {
      mappedQuery: termMap[query],
      used: true,
      appliedPairs: [[query, termMap[query]]],
    };
  }

  const keys = Object.keys(termMap).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (k && query.includes(k)) {
      const v = termMap[k];
      const mapped = query.replaceAll(k, v);
      if (mapped !== query)
        return { mappedQuery: mapped, used: true, appliedPairs: [[k, v]] };
      break;
    }
  }

  return { mappedQuery: query, used: false, appliedPairs: [] };
}

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
   小工具：格式化 & 吐槽
================================ */
function fmtPrice(n) {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  const pretty = Number.isFinite(num) ? Math.round(num) : n;
  return `${Number(pretty).toLocaleString()} gil`;
}

function fmtPriceCompact(n) {
  // 表格用：去掉 gil，留數字，避免太長
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  const pretty = Number.isFinite(num) ? Math.round(num) : n;
  return `${Number(pretty).toLocaleString()}`;
}

function calcDeltaPct(minListing, avgSold) {
  if (!minListing || !avgSold || avgSold <= 0) return null;
  return ((minListing - avgSold) / avgSold) * 100;
}

function deltaBadge(deltaPct) {
  if (deltaPct === null) return "—";
  const d = deltaPct;
  const sign = d >= 0 ? "+" : "-";
  return `${sign}${Math.abs(d).toFixed(0)}%`;
}

function moodFromDelta(deltaPct) {
  // B（巴哈常見）+ C（重度嘴砲但不罵人）混合；每個區間隨機 >= 20 條
  if (deltaPct === null) {
    const pool = [
      "📭 成交資料少到像沒開市場板：我只能用掛單通靈一下。",
      "📭 沒什麼成交紀錄：這東西是倉庫守門員嗎？",
      "📭 成交太稀薄：我現在的信心跟你抽極神坐騎一樣薄。",
      "📭 幾乎沒成交：利姆薩廣場都比這裡熱鬧。",
      "📭 成交不足：我只能用「體感」亂猜，別拿我當投資顧問。",
      "📭 歷史少：像是沒人練這職業一樣，價格很難講。",
      "📭 成交資料不足：這波我先不嘴商人，怕是根本沒人賣。",
      "📭 市場太冷：冷到以為在伊修加德外面吹風。",
      "📭 沒成交：可能有人囤著等改版，或大家都懶得上架。",
      "📭 成交稀有：我懷疑這是收藏品不是商品。",
      "📭 沒什麼人買：這就是傳說中的「看得到買不到」。",
      "📭 歷史很少：你問我行情？我問誰？問旅神嗎。",
      "📭 成交資料不足：先當作沒有均價，別被假象帶走。",
      "📭 成交太少：我只能看掛單，像看天氣預報猜暴雨。",
      "📭 沒成交：可能都被 FC 內部消化了。",
      "📭 成交資料不足：我現在是「猜價精靈」，不保證準。",
      "📭 歷史不足：像深層迷宮掉落一樣，紀錄少得可憐。",
      "📭 成交不足：這不是行情，是傳說。",
      "📭 成交太少：建議多看幾個伺服器再決定。",
      "📭 幾乎沒成交：我只能說…別衝動，先看一下別人怎麼掛。",
      "📭 成交不足：這波嘴不出來，但我手很癢。",
      "📭 沒成交：你要嘛撿漏撿到寶，要嘛踩雷踩到哭。",
      "📭 成交稀少：這市場像是被沉默術了。",
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const d = deltaPct;

  if (d <= -30) {
    const pool = [
      `🟢 低於均價 ${Math.abs(d).toFixed(0)}%：這不是便宜，是「開局送禮」🎁`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：商人是不是去打絕本忘了改價？`,
      `🟢 便宜到 ${Math.abs(d).toFixed(0)}%：掃貨仔要來了，你還不快點。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：這價格會被秒掃，現在還在？怪怪的喔。`,
      `🟢 低於均價 ${Math.abs(d).toFixed(0)}%：利姆薩商人看到會心痛。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：你不買，五分鐘後一定有人買。`,
      `🟢 便宜 ${Math.abs(d).toFixed(0)}%：這是撿漏，不是購物。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：像打副本撿到坐騎一樣爽。`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：商人：我只是想清倉啦（信你才怪）`,
      `🟢 -${Math.abs(d).toFixed(0)}%：這價位買下去，心情會變好。`,
      `🟢 低於均價 ${Math.abs(d).toFixed(0)}%：今天你就是市場板 MVP。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：這波可以，屬於「不買會後悔」那種。`,
      `🟢 便宜到 ${Math.abs(d).toFixed(0)}%：你現在是在撿人家失誤。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：快買，別讓掃地機器人看到。`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：價格甜到像吃到 HQ 料理。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：這個價你敢不買？我替你買。`,
      `🟢 低於均價 ${Math.abs(d).toFixed(0)}%：這叫「佛心」，真的佛。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：感覺像有人掛錯一個 0。`,
      `🟢 便宜 ${Math.abs(d).toFixed(0)}%：這價格能寫進巴哈精華。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：衝啦！這波不衝你要等下次改版？`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：這不是折扣，這是慈善活動。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：買完記得低調，不然會被問在哪看到。`,
      `🟢 低於均價 ${Math.abs(d).toFixed(0)}%：你今天運氣比抽卡還好。`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (d <= -15) {
    const pool = [
      `🟢 低於均價 ${Math.abs(d).toFixed(0)}%：這價位很舒服，買了不心痛。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：可以買，屬於「不盤」的範圍。`,
      `🟢 便宜 ${Math.abs(d).toFixed(0)}%：錢包點頭了 ✅`,
      `🟢 -${Math.abs(d).toFixed(0)}%：這波小撿漏，舒服。`,
      `🟢 低於均價 ${Math.abs(d).toFixed(0)}%：商人還沒起床，你先。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：這價位買下去，心情會像拿到周任獎勵。`,
      `🟢 便宜 ${Math.abs(d).toFixed(0)}%：這不是神價，但很甜。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：可以，這波買了不會被笑。`,
      `🟢 低於均價 ${Math.abs(d).toFixed(0)}%：屬於「看到就可以下手」那種。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：買吧，別演了。`,
      `🟢 便宜 ${Math.abs(d).toFixed(0)}%：這價格算良心。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：這波是「小確幸」。`,
      `🟢 低於均價 ${Math.abs(d).toFixed(0)}%：買完記得把材料塞滿背包。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：你手可以滑一下，但別一次梭哈。`,
      `🟢 便宜 ${Math.abs(d).toFixed(0)}%：比你在利姆薩逛街還順。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：這價位 OK，不用再猶豫一整晚。`,
      `🟢 低於均價 ${Math.abs(d).toFixed(0)}%：可以收，回頭再做也不虧。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：很甜，甜到想幫他按讚。`,
      `🟢 便宜 ${Math.abs(d).toFixed(0)}%：買了不會被 FC 嘲笑。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：這波屬於「手快有手慢無」。`,
      `🟢 低於均價 ${Math.abs(d).toFixed(0)}%：穩穩的撿，不用怕。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：你不買，掃貨仔會幫你買。`,
      `🟢 便宜 ${Math.abs(d).toFixed(0)}%：這價格很台服，很可以。`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (d <= -5) {
    const pool = [
      `🟢 略低於均價 ${Math.abs(d).toFixed(0)}%：小甜，買了不虧。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：這波算划算，手可以動。`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：便宜一點點，但也很爽。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：比行情好看，OK。`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：這價位買了不會覺得自己是盤子。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：可以收，算有賺到一杯珍奶。`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：小撿漏，別太高調。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：舒服價，拿來練生產不錯。`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：比你等隊友 ready 快一點。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：今天市場板沒坑你。`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：買吧，這波算善意。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：不錯，至少不是被割。`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：買了心情會 +1。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：算甜，甜度大概像 HQ 烹飪 +2%。`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：別想太多，買。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：這價位很安全。`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：小優勢，別猶豫到變盤。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：收一點就好，別被你自己抬價。`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：OK 的撿漏線。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：買完繼續跑你的日課。`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：這價位很「正常人」。`,
      `🟢 -${Math.abs(d).toFixed(0)}%：可以，至少不是信仰價。`,
      `🟢 低 ${Math.abs(d).toFixed(0)}%：今天商人沒有對你笑。`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (d < 5) {
    const pool = [
      `🟡 接近均價（${d.toFixed(0)}%）：行情價，買不買看你急不急。`,
      `🟡 （${d.toFixed(0)}%）：很普通，普通到像每日隨機。`,
      `🟡 （${d.toFixed(0)}%）：這價位不會被笑，也不會被稱讚。`,
      `🟡 （${d.toFixed(0)}%）：市場板的日常，不甜不盤。`,
      `🟡 （${d.toFixed(0)}%）：買了就是「正常人消費」。`,
      `🟡 （${d.toFixed(0)}%）：如果你急就買，不急就等等看。`,
      `🟡 （${d.toFixed(0)}%）：這波屬於「平穩」。`,
      `🟡 （${d.toFixed(0)}%）：沒什麼槽點，我很難發揮。`,
      `🟡 （${d.toFixed(0)}%）：行情線，別期待奇蹟價。`,
      `🟡 （${d.toFixed(0)}%）：就…市場的樣子。`,
      `🟡 （${d.toFixed(0)}%）：你現在是在買「方便」。`,
      `🟡 （${d.toFixed(0)}%）：這價格跟你排本一樣：可以接受。`,
      `🟡 （${d.toFixed(0)}%）：想省就多看幾個世界；想快就直接買。`,
      `🟡 （${d.toFixed(0)}%）：不虧不賺，主打一個心安。`,
      `🟡 （${d.toFixed(0)}%）：這價位大概就是「台服平均」。`,
      `🟡 （${d.toFixed(0)}%）：沒有撿漏感，但也沒被割感。`,
      `🟡 （${d.toFixed(0)}%）：買完別回頭看價格，會比較快樂。`,
      `🟡 （${d.toFixed(0)}%）：正常價，別想太多。`,
      `🟡 （${d.toFixed(0)}%）：這波你不會成為巴哈笑話主角。`,
      `🟡 （${d.toFixed(0)}%）：可以，至少不是被商人教育。`,
      `🟡 （${d.toFixed(0)}%）：你今天的運氣就一般般。`,
      `🟡 （${d.toFixed(0)}%）：這價位像是沒吃食物 BUFF 的 DPS：正常。`,
      `🟡 （${d.toFixed(0)}%）：行啦，過。`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (d < 15) {
    const pool = [
      `🟠 高於均價 ${d.toFixed(0)}%：有點貴，商人開始試水溫了。`,
      `🟠 +${d.toFixed(0)}%：你買的是「省時間」，不是省錢。`,
      `🟠 貴 ${d.toFixed(0)}%：還行，但有點不甘心對吧。`,
      `🟠 +${d.toFixed(0)}%：商人：欸你看，真的有人買。`,
      `🟠 高 ${d.toFixed(0)}%：可以等等看，除非你真的急。`,
      `🟠 +${d.toFixed(0)}%：這價位買下去，會想起「我是不是應該自己做」。`,
      `🟠 貴 ${d.toFixed(0)}%：小盤味，聞到了嗎。`,
      `🟠 +${d.toFixed(0)}%：如果你是拿來交任務…那也只能買。`,
      `🟠 高 ${d.toFixed(0)}%：還沒到信仰價，但已經在路上。`,
      `🟠 +${d.toFixed(0)}%：商人正在偷偷笑。`,
      `🟠 貴 ${d.toFixed(0)}%：先別衝，去喝口水冷靜一下。`,
      `🟠 +${d.toFixed(0)}%：你可能會在買完後立刻看到更便宜的。`,
      `🟠 高 ${d.toFixed(0)}%：這波買了，心裡會有一點刺。`,
      `🟠 +${d.toFixed(0)}%：巴哈看到會說「偏貴」。`,
      `🟠 貴 ${d.toFixed(0)}%：不是不能買，是不太值得。`,
      `🟠 +${d.toFixed(0)}%：買吧…如果你願意用錢解決問題。`,
      `🟠 高 ${d.toFixed(0)}%：商人已經開始教育市場。`,
      `🟠 +${d.toFixed(0)}%：你買完別截圖，不然你會後悔。`,
      `🟠 貴 ${d.toFixed(0)}%：先看一下別的世界，有機會省一波。`,
      `🟠 +${d.toFixed(0)}%：這價位像是「加班換錢」：可以，但不爽。`,
      `🟠 高 ${d.toFixed(0)}%：別急著按購買，先滑一下列表。`,
      `🟠 +${d.toFixed(0)}%：你現在是在資助商人買新坐騎。`,
      `🟠 貴 ${d.toFixed(0)}%：可以忍就忍，不然你會心痛。`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (d < 30) {
    const pool = [
      `🔴 高 ${d.toFixed(0)}%：盤味爆出來了，手收回來。`,
      `🔴 +${d.toFixed(0)}%：你確定要當今天的教材嗎？`,
      `🔴 貴 ${d.toFixed(0)}%：這價格很敢，商人很勇。`,
      `🔴 +${d.toFixed(0)}%：買下去會想在 FC 頻道裝沒事。`,
      `🔴 高 ${d.toFixed(0)}%：這價位是「我就看你會不會買」。`,
      `🔴 +${d.toFixed(0)}%：商人已經在利姆薩笑到抖肩。`,
      `🔴 貴 ${d.toFixed(0)}%：你買的是信仰的前奏。`,
      `🔴 +${d.toFixed(0)}%：這波買了，之後看到便宜會心碎。`,
      `🔴 高 ${d.toFixed(0)}%：不急就別買，真的。`,
      `🔴 +${d.toFixed(0)}%：你現在是在幫商人衝裝潢房子。`,
      `🔴 貴 ${d.toFixed(0)}%：盤到我都想幫你按取消。`,
      `🔴 +${d.toFixed(0)}%：這價位你敢買，我就敢叫你勇者。`,
      `🔴 高 ${d.toFixed(0)}%：市場板正在教育你「急就要付學費」。`,
      `🔴 +${d.toFixed(0)}%：先去打個副本冷靜一下。`,
      `🔴 貴 ${d.toFixed(0)}%：你可以買，但你會後悔。`,
      `🔴 +${d.toFixed(0)}%：商人看到你下單，會說「又一個」。`,
      `🔴 高 ${d.toFixed(0)}%：這波不是購物，是獻祭。`,
      `🔴 +${d.toFixed(0)}%：巴哈會留言「這也敢買？」`,
      `🔴 貴 ${d.toFixed(0)}%：別急，等別人先當盤。`,
      `🔴 +${d.toFixed(0)}%：你現在是商人的 KPI。`,
      `🔴 高 ${d.toFixed(0)}%：先把購買按鈕放下。`,
      `🔴 +${d.toFixed(0)}%：你可能只是少看一個世界。`,
      `🔴 貴 ${d.toFixed(0)}%：這價位買了，晚上睡前會想起來。`,
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const pool = [
    `☠️ 高 ${d.toFixed(0)}%：這不是市價，是「信仰價」。`,
    `☠️ +${d.toFixed(0)}%：商人今晚加菜，你是功臣。`,
    `☠️ 高 ${d.toFixed(0)}%：你買下去，巴哈會幫你立碑。`,
    `☠️ +${d.toFixed(0)}%：這價格像絕本首週：敢開敢賣。`,
    `☠️ 高 ${d.toFixed(0)}%：你確定不是在買情緒價？`,
    `☠️ +${d.toFixed(0)}%：這波買了，你就是市場板傳說。`,
    `☠️ 高 ${d.toFixed(0)}%：這不是盤，是「超盤」。`,
    `☠️ +${d.toFixed(0)}%：商人：謝謝你，我的新坐騎有著落了。`,
    `☠️ 高 ${d.toFixed(0)}%：你買下去我叫你大哥，但我會偷笑。`,
    `☠️ +${d.toFixed(0)}%：這價位只有「急」才解釋得通。`,
    `☠️ 高 ${d.toFixed(0)}%：你按下購買的瞬間，錢包會尖叫。`,
    `☠️ +${d.toFixed(0)}%：這是「我不降價你能怎樣」的態度價。`,
    `☠️ 高 ${d.toFixed(0)}%：你買完別回頭看歷史，會受傷。`,
    `☠️ +${d.toFixed(0)}%：市場板正在對你上課。`,
    `☠️ 高 ${d.toFixed(0)}%：這波不是消費，是捐款。`,
    `☠️ +${d.toFixed(0)}%：商人正在寫感謝信給你。`,
    `☠️ 高 ${d.toFixed(0)}%：這價位可以直接截圖發文求安慰。`,
    `☠️ +${d.toFixed(0)}%：你買下去，FC 會問你是不是喝了 HQ 藥水。`,
    `☠️ 高 ${d.toFixed(0)}%：這價格在利姆薩會被圍觀。`,
    `☠️ +${d.toFixed(0)}%：你現在是在養出下一個壟斷商人。`,
    `☠️ 高 ${d.toFixed(0)}%：你很勇，但你的錢包更勇。`,
    `☠️ +${d.toFixed(0)}%：這波買了，就別說是我讓你買的。`,
    `☠️ 高 ${d.toFixed(0)}%：信仰值拉滿，尊敬。`,
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ===============================
   表格排版工具（等寬 code block）
================================ */
function strWidth(s) {
  // 粗略：ASCII=1，CJK=2；特例：— 視為 1（Discord 顯示通常是 1 格）
  let w = 0;
  for (const ch of String(s)) {
    if (ch === "—") {
      w += 1;
      continue;
    }
    w += ch.charCodeAt(0) <= 0x7f ? 1 : 2;
  }
  return w;
}

function padRight(s, width) {
  s = String(s);
  const w = strWidth(s);
  if (w >= width) return s;
  return s + " ".repeat(width - w);
}

function padLeft(s, width) {
  s = String(s);
  const w = strWidth(s);
  if (w >= width) return s;
  return " ".repeat(width - w) + s;
}

// ✅ Newline helper（避免 join("\n") 被編輯器斷行弄爆）
const NL = String.fromCharCode(10);

/* ===============================
   CafeMaker：搜尋 / 物品資訊
================================ */
async function cafemakerSearch(query, limit = 20) {
  const url = `https://cafemaker.wakingsands.com/search?string=${encodeURIComponent(
    t2s(query)
  )}&indexes=item&limit=${limit}`;

  const res = await fetch(url);
  const data = await res.json();

  const results = (data?.Results || []).map((r) => {
    const nameTW = s2t(r.Name);
    return {
      id: Number(r.ID),
      name: nameTW,
      score: similarity(query, nameTW),
    };
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}

async function cafemakerGetItemMeta(id) {
  const url = `https://cafemaker.wakingsands.com/item/${id}?language=chs&columns=ID,Name,ItemSearchCategory.Name,ItemUICategory.Name`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();

  const nameTW = s2t(d?.Name || "");
  const isc = s2t(d?.ItemSearchCategory?.Name || "");
  const iuc = s2t(d?.ItemUICategory?.Name || "");

  return {
    id: Number(d?.ID || id),
    name: nameTW || String(id),
    itemSearchCategory: isc || "",
    itemUiCategory: iuc || "",
  };
}

/* ===============================
   救援搜尋（cafemaker）
   【唯一改動】加入 SAFE_SUFFIXES 白名單後綴救援（不影響學習）
================================ */
async function rescueSearch(originalQuery, mappedQuery) {
  const attempts = [];
  const seen = new Set();

  const pushAttempt = (q, reason) => {
    const qq = (q || "").trim();
    if (!qq) return;
    if ([...qq].length < 2) return;
    if (seen.has(qq)) return;
    seen.add(qq);
    attempts.push({ q: qq, reason });
  };

  if (mappedQuery && mappedQuery !== originalQuery) pushAttempt(mappedQuery, "詞彙映射");

  const suffixes = ["裝備箱", "箱子", "寶箱", "套裝", "外套", "手套", "靴", "鞋", "帽", "頭盔"];
  for (const suf of suffixes) {
    if (originalQuery.endsWith(suf) && originalQuery.length > suf.length + 1) {
      pushAttempt(originalQuery.slice(0, -suf.length), `去掉後綴「${suf}」`);
    }
    if (mappedQuery.endsWith(suf) && mappedQuery.length > suf.length + 1) {
      pushAttempt(mappedQuery.slice(0, -suf.length), `去掉後綴「${suf}」(映射後)`);
    }
  }

  if (originalQuery.length >= 4) pushAttempt(originalQuery.slice(0, 3), "取前 3 字");
  if (originalQuery.length >= 3) pushAttempt(originalQuery.slice(0, 2), "取前 2 字");
  if (mappedQuery.length >= 4) pushAttempt(mappedQuery.slice(0, 3), "取前 3 字(映射後)");
  if (mappedQuery.length >= 3) pushAttempt(mappedQuery.slice(0, 2), "取前 2 字(映射後)");

  // === 安全版白名單後綴救援（新增，不影響 term_map / manual）===
  const SAFE_SUFFIXES = ["結晶片", "藏寶圖", "魔紋"];
  for (const suf of SAFE_SUFFIXES) {
    if (originalQuery.endsWith(suf)) {
      pushAttempt(suf, `取後綴「${suf}」`);
    }
    if (mappedQuery.endsWith(suf)) {
      pushAttempt(suf, `取後綴「${suf}」(映射後)`);
    }
  }

  for (const a of attempts) {
    try {
      const results = await cafemakerSearch(a.q, 20);
      if (results.length) return { results, usedQuery: a.q, reason: a.reason };
    } catch {
      // ignore
    }
  }
  return { results: [], usedQuery: null, reason: null };
}

/* ===============================
   大分類瀏覽：規則 / Session
================================ */
const CATEGORY_SEEDS = {
  地圖: ["藏寶圖", "陳舊的藏寶圖", "魔紋", "龍皮", "地圖"],
  礦石: ["礦", "原礦", "礦石", "礦砂", "碎晶"],
  木材: ["原木", "木材", "木", "木板"],
  皮革: ["皮革", "獸皮", "革"],
  布料: ["布", "布料", "絲", "毛線"],
  食材: ["食材", "肉", "魚", "蔬菜", "香料"],
};

function normalizeCategoryInput(raw) {
  let s = (raw || "").trim();
  if (!s) return null;
  const m = s.match(/^\((.+)\)$/);
  if (m && m[1]) s = m[1].trim();
  if (s.startsWith(CATEGORY_TRIGGER_PREFIX)) {
    s = s.slice(CATEGORY_TRIGGER_PREFIX.length).trim();
  }
  return s || null;
}

function isCategoryBrowse(raw) {
  const s = (raw || "").trim();
  if (!s) return false;
  if (s.startsWith(CATEGORY_TRIGGER_PREFIX)) return true;
  if (/^\(.+\)$/.test(s)) return true;
  return Object.prototype.hasOwnProperty.call(CATEGORY_SEEDS, s);
}

function mapSubCategoryName(itemName) {
  const name = String(itemName || "");
  const g = name.match(/G\s*(\d+)/i) || name.match(/Ｇ\s*(\d+)/);
  if (g && g[1]) return `G${g[1]}`;
  if (name.includes("魔紋")) return "魔紋";
  if (name.includes("龍皮")) return "龍皮";
  if (name.includes("陳舊")) return "陳舊";
  if (name.includes("藏寶圖")) return "其他藏寶圖";
  return "其他";
}

function makeSessionId() {
  return Math.random().toString(36).slice(2, 10);
}

const UI_SESSIONS = new Map();
function putSession(sid, obj) {
  UI_SESSIONS.set(sid, { ...obj, updatedAt: Date.now() });
  if (UI_SESSIONS.size > 200) {
    const entries = [...UI_SESSIONS.entries()].sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
    for (let i = 0; i < 50; i++) UI_SESSIONS.delete(entries[i][0]);
  }
}
function getSession(sid) {
  const s = UI_SESSIONS.get(sid);
  if (!s) return null;
  s.updatedAt = Date.now();
  return s;
}
function delSession(sid) {
  UI_SESSIONS.delete(sid);
}

function slicePage(arr, page, pageSize) {
  const p = Math.max(0, Number(page || 0));
  const start = p * pageSize;
  return { page: p, start, end: start + pageSize, total: arr.length, items: arr.slice(start, start + pageSize) };
}

function buildPickRowsFromList(list, sessionId, prefix, page, pageSize) {
  const { page: p, items, total } = slicePage(list, page, pageSize);

  const rows = [];
  for (let i = 0; i < items.length; i += 5) {
    const row = new ActionRowBuilder();
    items.slice(i, i + 5).forEach((it, idx) => {
      const label = `${i + idx + 1 + p * pageSize}. ${it.label}`;
      const idPart = it.key;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${prefix}_${sessionId}_${idPart}`)
          .setLabel(label.slice(0, 80))
          .setStyle(ButtonStyle.Primary)
      );
    });
    rows.push(row);
  }

  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const nav = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`nav_${sessionId}_prev`)
        .setLabel("⬅️ 上一頁")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(p <= 0),
      new ButtonBuilder()
        .setCustomId(`nav_${sessionId}_next`)
        .setLabel("下一頁 ➡️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(p >= maxPage),
    );

  rows.push(nav);
  return { rows, page: p, maxPage };
}

async function buildBrowseCategories(keyword) {
  const key = String(keyword || "").trim();
  if (!key) return { cats: [], items: [] };

  const seeds = CATEGORY_SEEDS[key] || [key];
  const candidates = [];
  const seen = new Set();

  for (const seed of seeds) {
    try {
      const rs = await cafemakerSearch(seed, CATEGORY_SEARCH_LIMIT);
      for (const r of rs) {
        if (!r?.id) continue;
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        candidates.push({ id: r.id, name: r.name });
      }
    } catch {}
  }

  if (!candidates.length) return { cats: [], items: [] };

  const limit = pLimit(CATEGORY_META_CONCURRENCY);
  const metas = [];
  await Promise.allSettled(
    candidates.map((c) =>
      limit(async () => {
        try {
          const m = await cafemakerGetItemMeta(c.id);
          if (m?.id) metas.push(m);
        } catch {}
      })
    )
  );

  const group = new Map();
  for (const m of metas) {
    let label = "";
    let catKey = "";
    if (key === "地圖") {
      label = mapSubCategoryName(m.name);
      catKey = label;
    } else {
      label = m.itemSearchCategory || m.itemUiCategory || "其他";
      catKey = label;
    }
    if (!group.has(catKey)) group.set(catKey, { label, items: [] });
    group.get(catKey).items.push({ id: m.id, name: m.name });
  }

  const cats = [...group.entries()]
    .map(([k, v]) => ({
      key: k,
      label: `${v.label}（${v.items.length}）`,
      rawLabel: v.label,
      items: v.items.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")),
    }))
    .sort((a, b) => b.items.length - a.items.length);

  return { cats, items: metas };
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

  const raw = msg.content.trim();
  if (!raw) return;

  if (isCategoryBrowse(raw)) {
    const keyword = normalizeCategoryInput(raw);
    if (!keyword) return;
    await handleCategoryBrowse(msg, keyword);
    return;
  }

  const query = raw;
  const queryLen = [...query].length;

  const manual = loadManual();
  const manualId = manual[query];

  const termMap = loadTermMap();
  const { mappedQuery } = applyTermMap(query, termMap);

  let results = [];
  try {
    results = await cafemakerSearch(query, 20);
  } catch {
    await msg.reply("⚠️ 搜尋服務暫時不可用");
    return;
  }

  let rescueInfo = null;
  if (!results.length) {
    const rescue = await rescueSearch(query, mappedQuery);
    results = rescue.results;
    if (rescue.usedQuery)
      rescueInfo = { usedQuery: rescue.usedQuery, reason: rescue.reason };
  }

  if (!results.length) {
    await msg.reply(
      `❌ 找不到物品：「${query}」\n💡 可能是台服用語與資料源用語不同（例如：咕波/庫啵），或請輸入更完整名稱。`
    );
    return;
  }

  if (results.length === 1) {
    if (rescueInfo && rescueInfo.usedQuery && rescueInfo.usedQuery !== query) {
      if (queryLen >= TERM_MAP_LEARN_MIN_LEN) {
        const tm = loadTermMap();
        tm[query] = rescueInfo.usedQuery;
        saveTermMap(tm);
      }
    }

    if (queryLen >= MANUAL_LEARN_MIN_LEN) {
      const m = loadManual();
      m[query] = results[0].id;
      saveManual(m);
    }

    await sendPrice(msg, results[0].id, results[0].name);
    return;
  }

  const top = results
    .sort((a, b) => (a.id === manualId ? -1 : 1))
    .slice(0, 20);

  const hintLine = rescueInfo
    ? `（我用「${rescueInfo.usedQuery}」救援搜尋：${rescueInfo.reason}）\n`
    : "";

  const learnHint =
    queryLen < MANUAL_LEARN_MIN_LEN
      ? "⚠️ 關鍵字太短：我不會把它記住（避免下次被綁死選錯），但你仍可照常選。"
      : "⭐ 我會記住你選的結果，下次更快。";

  const select = new StringSelectMenuBuilder()
    .setCustomId("pick_item")
    .setPlaceholder("請選擇你要查詢的物品")
    .addOptions(
      top.map((r, idx) => ({
        label: `${idx + 1}. ${r.name}`.slice(0, 100),
        value: String(r.id),
      }))
    );

  const row = new ActionRowBuilder().addComponents(select);

  const prompt = await msg.reply({
    content: `❓ 找到多個「${query}」相關物品，請選擇：\n${hintLine}${learnHint}`,
    components: [row],
  });

  const collector = prompt.createMessageComponentCollector({ time: 60000 });

  collector.on("collect", async (i) => {
    if (i.user.id !== msg.author.id) return;

    const pickedId = Number(i.values[0]);
    const picked = top.find((t) => t.id === pickedId);
    if (!picked) return;

    if (queryLen >= MANUAL_LEARN_MIN_LEN) {
      const m = loadManual();
      m[query] = pickedId;
      saveManual(m);
    }

    if (rescueInfo && rescueInfo.usedQuery && rescueInfo.usedQuery !== query) {
      if (queryLen >= TERM_MAP_LEARN_MIN_LEN) {
        const tm = loadTermMap();
        tm[query] = rescueInfo.usedQuery;
        saveTermMap(tm);
      }
    }

    await i.update({ content: `✅ 已選擇：${picked.name}`, components: [] });
    await sendPrice(msg, picked.id, picked.name);
  });
});

/* ===============================
   大分類瀏覽處理
================================ */
async function handleCategoryBrowse(msg, keyword) {
  const sid = makeSessionId();

  const prompt = await msg.reply({
    content: `🗂️ 正在整理「${keyword}」的分類…（如果很多物品會稍慢一點點）`,
    components: [],
  });

  const built = await buildBrowseCategories(keyword);
  if (!built.cats.length) {
    await prompt.edit(`❌ 我找不到「${keyword}」的分類資料。`);
    return;
  }

  putSession(sid, {
    userId: msg.author.id,
    keyword,
    view: "cats",
    cats: built.cats,
    catPage: 0,
    itemPage: 0,
    currentCatKey: null,
  });

  await renderCategoryView(prompt, sid);

  const collector = prompt.createMessageComponentCollector({ time: 120000 });

  collector.on("collect", async (i) => {
    const sessionId = parseSessionId(i.customId);
    if (!sessionId || sessionId !== sid) return;
    const s = getSession(sessionId);
    if (!s) return;

    if (i.user.id !== s.userId) {
      await i.reply({ content: "🙅‍♀️ 只有發問的人可以操作這個選單喔～", ephemeral: true });
      return;
    }

    try {
      if (i.customId.startsWith(`catpick_${sid}_`)) {
        const catKey = i.customId.replace(`catpick_${sid}_`, "");
        s.view = "items";
        s.currentCatKey = catKey;
        s.itemPage = 0;
        putSession(sid, s);
        await i.deferUpdate();
        await renderItemsView(prompt, sid);
        return;
      }

      if (i.customId.startsWith(`itempick_${sid}_`)) {
        const itemId = Number(i.customId.replace(`itempick_${sid}_`, ""));
        const cat = s.cats.find((c) => c.key === s.currentCatKey);
        const picked = cat?.items?.find((x) => Number(x.id) === itemId);
        await i.update({ content: `✅ 已選擇：${picked?.name || itemId}`, components: [] });
        delSession(sid);
        await sendPrice(msg, itemId, picked?.name || String(itemId));
        return;
      }

      if (i.customId === `nav_${sid}_prev`) {
        await i.deferUpdate();
        if (s.view === "cats") s.catPage = Math.max(0, (s.catPage || 0) - 1);
        else s.itemPage = Math.max(0, (s.itemPage || 0) - 1);
        putSession(sid, s);
        if (s.view === "cats") await renderCategoryView(prompt, sid);
        else await renderItemsView(prompt, sid);
        return;
      }
      if (i.customId === `nav_${sid}_next`) {
        await i.deferUpdate();
        if (s.view === "cats") s.catPage = (s.catPage || 0) + 1;
        else s.itemPage = (s.itemPage || 0) + 1;
        putSession(sid, s);
        if (s.view === "cats") await renderCategoryView(prompt, sid);
        else await renderItemsView(prompt, sid);
        return;
      }

      if (i.customId === `back_${sid}`) {
        await i.deferUpdate();
        s.view = "cats";
        s.currentCatKey = null;
        putSession(sid, s);
        await renderCategoryView(prompt, sid);
        return;
      }
    } catch {}
  });

  collector.on("end", async () => {
    try {
      const s = getSession(sid);
      if (s) delSession(sid);
      await prompt.edit({ components: [] });
    } catch {}
  });
}

function parseSessionId(customId) {
  const parts = String(customId || "").split("_");
  if (parts.length < 2) return null;
  if (parts[0] === "catpick") return parts[1];
  if (parts[0] === "itempick") return parts[1];
  if (parts[0] === "nav") return parts[1];
  if (parts[0] === "back") return parts[1];
  return null;
}

async function renderCategoryView(promptMsg, sid) {
  const s = getSession(sid);
  if (!s) return;

  const list = s.cats.map((c) => ({ key: c.key, label: c.label }));
  const { rows, page, maxPage } = buildPickRowsFromList(list, sid, "catpick", s.catPage || 0, CATEGORY_PAGE_SIZE);

  const hintRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`noop_${sid}`)
      .setLabel(`第 ${page + 1}/${maxPage + 1} 頁｜點分類 → 看物品`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  await promptMsg.edit({
    content:
      `🗂️ **${s.keyword}** 的子分類（點一個來看底下物品）\n` +
      `💡 你也可以直接輸入物品名查價；這裡是「逛分類」模式～`,
    components: [hintRow, ...rows],
  });
}

async function renderItemsView(promptMsg, sid) {
  const s = getSession(sid);
  if (!s) return;

  const cat = s.cats.find((c) => c.key === s.currentCatKey);
  if (!cat) {
    s.view = "cats";
    s.currentCatKey = null;
    putSession(sid, s);
    await renderCategoryView(promptMsg, sid);
    return;
  }

  const list = cat.items.map((it) => ({ key: String(it.id), label: it.name }));
  const { rows, page, maxPage } = buildPickRowsFromList(list, sid, "itempick", s.itemPage || 0, ITEM_PAGE_SIZE);

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`back_${sid}`).setLabel("↩️ 返回分類").setStyle(ButtonStyle.Secondary)
  );

  const hintRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`noop_${sid}`)
      .setLabel(`第 ${page + 1}/${maxPage + 1} 頁｜點物品 → 查價`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  await promptMsg.edit({
    content: `📚 **${s.keyword} → ${cat.rawLabel}** 物品列表（點一個查價）`,
    components: [hintRow, backRow, ...rows],
  });
}

/* ===============================
   查價（成交均價差異%）＋ 表格UI（整齊 + 吐槽對齊）
================================ */
async function sendPrice(msg, itemId, itemName) {
  const WITHIN_7D = 7 * 24 * 60 * 60;

  const mean = (arr) => {
    if (!arr || !arr.length) return null;
    const nums = arr.map(Number).filter((x) => Number.isFinite(x));
    if (!nums.length) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  };

  const pickMin = (listings) => {
    if (!listings || !listings.length) return null;
    const nums = listings.map((l) => Number(l.pricePerUnit)).filter((x) => Number.isFinite(x));
    if (!nums.length) return null;
    return Math.min(...nums);
  };

  const buildTable = (prices, bestWorld) => {
    // ✅ 你要的版本：用 🏆 標記最低價伺服器（其他行用同寬空白補齊，確保對齊）
    const prefix = (w) => (w === bestWorld ? "🏆 " : "  ");

    const worldW = Math.max(6, ...prices.map((p) => strWidth(p.world || "")), 6);

    // 數字欄位寬度依資料動態算（包含逗號、—、百分比），讓欄位更穩定對齊
    const priceTexts = prices.map((p) =>
      p.price === null ? "—" : fmtPriceCompact(p.price)
    );
    const avgTexts = prices.map((p) =>
      p.avgSold === null ? "—" : fmtPriceCompact(p.avgSold)
    );
    const deltaTexts = prices.map((p) =>
      p.deltaPct === null ? "—" : deltaBadge(p.deltaPct)
    );

    const priceW = Math.max(4, ...priceTexts.map((s) => strWidth(s)));
    const deltaW = Math.max(4, ...deltaTexts.map((s) => strWidth(s)));
    const avgW = Math.max(4, ...avgTexts.map((s) => strWidth(s)));

    const header =
      `${padRight("伺服器", worldW)}  ` +
      `${padLeft("最低", priceW)}  ` +
      `${padLeft("差異", deltaW)}  ` +
      `${padLeft("均價", avgW)}`;

    const sep = "-".repeat(strWidth(header) + 2); // +2 給前綴空間

    const rows = prices.map((p, idx) => {
      const worldText = p.world || "";
      const priceText = priceTexts[idx];
      const avgText = avgTexts[idx];
      const dText = deltaTexts[idx];

      return (
        `${prefix(p.world)}${padRight(worldText, worldW)}  ` +
        `${padLeft(priceText, priceW)}  ` +
        `${padLeft(dText, deltaW)}  ` +
        `${padLeft(avgText, avgW)}`
      );
    });

    return ["```", header, sep, ...rows, "```"].join(NL);
  };

  const pricesNQ = [];
  const pricesHQ = [];

  for (const w of WORLD_LIST) {
    try {
      const url = `https://universalis.app/api/v2/${encodeURIComponent(
        w
      )}/${itemId}?listings=20&entries=20&entriesWithin=${WITHIN_7D}&statsWithin=${WITHIN_7D}`;

      const r = await fetch(url);
      const d = await r.json();

      const listings = Array.isArray(d.listings) ? d.listings : [];
      const history = Array.isArray(d.recentHistory) ? d.recentHistory : [];

      // NQ
      const nqMin = pickMin(listings.filter((l) => !l.hq));
      const nqAvgSold = mean(history.filter((h) => !h.hq).map((h) => h.pricePerUnit));
      const nqDelta = calcDeltaPct(nqMin, nqAvgSold);
      pricesNQ.push({ world: w, price: nqMin, avgSold: nqAvgSold, deltaPct: nqDelta });

      // HQ
      const hqMin = pickMin(listings.filter((l) => !!l.hq));
      const hqAvgSold = mean(history.filter((h) => !!h.hq).map((h) => h.pricePerUnit));
      const hqDelta = calcDeltaPct(hqMin, hqAvgSold);
      pricesHQ.push({ world: w, price: hqMin, avgSold: hqAvgSold, deltaPct: hqDelta });
    } catch {
      pricesNQ.push({ world: w, price: null, avgSold: null, deltaPct: null });
      pricesHQ.push({ world: w, price: null, avgSold: null, deltaPct: null });
    }
  }

  const validNQ = pricesNQ.filter((p) => p.price !== null);
  const validHQ = pricesHQ.filter((p) => p.price !== null);

  if (!validNQ.length && !validHQ.length) {
    await msg.reply("⚠️ 查不到價格資料");
    return;
  }

  let bestNQ = null;
  if (validNQ.length) {
    validNQ.sort((a, b) => a.price - b.price);
    bestNQ = validNQ[0];
  }

  let bestHQ = null;
  if (validHQ.length) {
    validHQ.sort((a, b) => a.price - b.price);
    bestHQ = validHQ[0];
  }

  const nqTable = validNQ.length ? buildTable(pricesNQ, bestNQ.world) : null;
  const hqTable = validHQ.length ? buildTable(pricesHQ, bestHQ.world) : null;

  const nqDeltaText = bestNQ?.deltaPct === null || !bestNQ ? "—" : deltaBadge(bestNQ.deltaPct);
  const hqDeltaText = bestHQ?.deltaPct === null || !bestHQ ? "—" : deltaBadge(bestHQ.deltaPct);

  const nqRoast = bestNQ ? moodFromDelta(bestNQ.deltaPct) : null;
  const hqRoast = bestHQ ? moodFromDelta(bestHQ.deltaPct) : null;

  const lines = [];
  if (bestNQ) {
    lines.push(`🟦 NQ 最低價：${bestNQ.world} ・ ${fmtPrice(bestNQ.price)}（${nqDeltaText}）`);
    lines.push(`📊 NQ 近 7 天成交均價：${bestNQ.avgSold ? fmtPrice(bestNQ.avgSold) : "—"}`);
    lines.push(`💬 NQ 評語：${nqRoast}`);
  } else {
    lines.push(`🟦 NQ：—（目前沒有在售的 NQ）`);
  }

  lines.push(""); // spacer

  if (bestHQ) {
    lines.push(`🟪 HQ 最低價：${bestHQ.world} ・ ${fmtPrice(bestHQ.price)}（${hqDeltaText}）`);
    lines.push(`📊 HQ 近 7 天成交均價：${bestHQ.avgSold ? fmtPrice(bestHQ.avgSold) : "—"}`);
    lines.push(`💬 HQ 評語：${hqRoast}`);
  } else {
    lines.push(`🟪 HQ：—（此物品可能沒有 HQ 版本，或目前沒有 HQ 掛單）`);
  }

  lines.push(""); // spacer

  if (nqTable) {
    lines.push("【NQ】");
    lines.push(nqTable);
  }
  if (hqTable) {
    lines.push("【HQ】");
    lines.push(hqTable);
  }

  const embed = new EmbedBuilder()
    .setTitle(`📦 ${itemName}`)
    .setDescription(lines.join(NL));

  const reply = await msg.reply({ embeds: [embed] });
  setTimeout(
    () => reply.delete().catch(() => {}),
    AUTO_DELETE_MINUTES * 60 * 1000
  );
}

/* ===============================
   Login
================================ */
client.login(DISCORD_TOKEN);
