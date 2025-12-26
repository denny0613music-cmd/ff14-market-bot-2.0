import fs from "fs";
import fetch from "node-fetch";
import pLimit from "p-limit";
import OpenCC from "opencc-js";

/*
  build_items_zh_tw_full.js
  ------------------------
  1) 從 Universalis 取得可交易物品 ID
  2) 用 CafeMaker (XIVAPI) 抓簡中名稱
  3) 用 opencc-js (s2t 等效：cn -> tw) 轉成繁中
  4) 輸出 items_zh_tw.json (繁中名稱 -> itemId)

  ✅ 可續跑：會寫 items_zh_tw.checkpoint.json
  ✅ 失敗清單：items_zh_tw_failed.json

  跑法：
    npm run build:items
*/

// ===== 可調參數 =====
const CONCURRENCY = Number(process.env.BUILD_CONCURRENCY || 4);
const BATCH_SIZE = Number(process.env.BUILD_BATCH_SIZE || 300);
const API_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS || 20000);

// CafeMaker (XIVAPI)
const XIVAPI_BASE = "https://cafemaker.wakingsands.com";

// 輸出檔案
const OUT_FILE = "./items_zh_tw.json"; // 繁中 name -> id
const OUT_ID_FILE = "./items_zh_tw_id.json"; // id -> 繁中 name
const CHECKPOINT_FILE = "./items_zh_tw.checkpoint.json";
const FAIL_FILE = "./items_zh_tw_failed.json";

// opencc-js：沒有 new OpenCC('s2t') 這種介面
// 這裡用 Converter({from:'cn',to:'tw'}) 等效你要的 s2t
const s2t = OpenCC.Converter({ from: "cn", to: "tw" });

const limit = pLimit(CONCURRENCY);

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, retry = 7) {
  for (let i = 0; i < retry; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "ff14-market-bot/1.0 (items builder)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      const msg = e?.name === "AbortError" ? "Timeout" : e?.message || String(e);
      console.error(`Error fetching ${url}: ${msg}`);
      await sleep(800 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function loadJsonIfExists(path, fallback) {
  try {
    if (fs.existsSync(path)) {
      const txt = fs.readFileSync(path, "utf8").trim();
      if (!txt) return fallback;
      return JSON.parse(txt);
    }
  } catch {}
  return fallback;
}

/** ✅ 原子寫入：避免半截 JSON */
function saveJsonAtomic(path, obj) {
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, path);
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toZhtw(chs) {
  const t = String(chs || "").trim();
  if (!t) return "";
  try {
    // Converter 回傳同步函式
    return String(s2t(t)).trim();
  } catch {
    return t;
  }
}

async function fetchNameChs(id) {
  const url = `${XIVAPI_BASE}/item/${id}?language=chs&columns=ID,Name`;
  const data = await fetchJson(url);
  const name = data?.Name;
  return typeof name === "string" ? name.trim() : "";
}

async function main() {
  console.log(`▶️ Build items zh-tw mapping`);
  console.log(`   CONCURRENCY=${CONCURRENCY} BATCH_SIZE=${BATCH_SIZE}`);

  // 1) 先抓可交易 item IDs（Universalis）
  const marketableIds = await fetchJson("https://universalis.app/api/v2/marketable");
  if (!Array.isArray(marketableIds) || marketableIds.length === 0) {
    console.log("❌ Failed to fetch marketable IDs from Universalis.");
    process.exit(1);
  }
  console.log(`✅ marketable ids: ${marketableIds.length}`);

  // 2) 從 checkpoint 繼續（name->id）
  let nameToId = loadJsonIfExists(CHECKPOINT_FILE, loadJsonIfExists(OUT_FILE, {}));
  let failed = loadJsonIfExists(FAIL_FILE, []);

  // 3) 反向表（id->name）
  let idToName = loadJsonIfExists(OUT_ID_FILE, {});

  // 已做過的 id（避免重抓）
  const doneIdSet = new Set(Object.values(nameToId).map((v) => Number(v)));

  const batches = chunkArray(marketableIds, BATCH_SIZE);

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];

    const tasks = batch.map((id) =>
      limit(async () => {
        const nId = Number(id);
        if (!nId) return;
        if (doneIdSet.has(nId)) return;

        const chs = await fetchNameChs(nId);
        if (!chs) {
          failed.push(nId);
          return;
        }

        const zhtw = toZhtw(chs);
        if (!zhtw) {
          failed.push(nId);
          return;
        }

        // name -> id（同名保留較小 id）
        if (!nameToId[zhtw] || nId < Number(nameToId[zhtw])) {
          nameToId[zhtw] = nId;
        }
        // id -> name
        idToName[String(nId)] = zhtw;

        doneIdSet.add(nId);
      })
    );

    await Promise.allSettled(tasks);

    failed = [...new Set(failed.map((x) => Number(x)))].filter((x) => Number.isFinite(x) && x > 0);
    saveJsonAtomic(CHECKPOINT_FILE, nameToId);
    saveJsonAtomic(FAIL_FILE, failed);
    saveJsonAtomic(OUT_ID_FILE, idToName);

    console.log(
      `✅ Batch ${bi + 1}/${batches.length} done. items=${Object.keys(nameToId).length} failed=${failed.length}`
    );
  }

  // 最後輸出正式檔
  saveJsonAtomic(OUT_FILE, nameToId);
  saveJsonAtomic(OUT_ID_FILE, idToName);
  console.log(`🎉 Done! items=${Object.keys(nameToId).length}, failed=${failed.length}`);
}

main().catch((e) => {
  console.error("❌ Build failed:", e);
  process.exit(1);
});
