import fs from "fs";
import fetch from "node-fetch";
import pLimit from "p-limit";

/**
 * build_items_zh_tw.js
 * - 從 Universalis 拿 marketable item IDs
 * - 用 XIVAPI 取繁中 (zh-tw) Name
 * - 避免英文混入（全 ASCII 視為英文，丟到 failed）
 * - 分批 + 並發限制 + checkpoint，避免卡死
 */

const limit = pLimit(6);
const BATCH_SIZE = 300;

const OUT_FILE = "./items_zh_tw.json";
const CHECKPOINT_FILE = "./items_zh_tw.checkpoint.json";
const FAIL_FILE = "./items_zh_tw_failed.json";

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 帶 timeout 的 fetch（20秒），失敗重試，最後回 null
async function fetchJson(url, retry = 6) {
  for (let i = 0; i < retry; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          // 有些情況 header 也能幫助避免語系 fallback
          "Accept-Language": "zh-TW,zh-Hant;q=0.9,en;q=0.2",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      await sleep(800 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function loadJsonIfExists(path, fallback) {
  try {
    if (fs.existsSync(path)) return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {}
  return fallback;
}

function saveJson(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2), "utf8");
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ✅ 判斷是否「幾乎全英文」：全 ASCII 的字串視為英文（避免混進你的繁中表）
function isAllAscii(str) {
  return typeof str === "string" && /^[\x00-\x7F]*$/.test(str);
}

async function main() {
  console.log("📦 Fetching marketable item IDs from Universalis...");
  const marketableIds = await fetchJson("https://universalis.app/api/v2/marketable");
  if (!Array.isArray(marketableIds) || marketableIds.length === 0) {
    console.log("❌ Failed to fetch marketable IDs.");
    process.exit(1);
  }

  // 讀舊成果
  let result = loadJsonIfExists(OUT_FILE, {});
  if (Object.keys(result).length > 0) {
    console.log(`♻️ Loaded existing ${OUT_FILE}: ${Object.keys(result).length} items`);
  }

  // 讀 checkpoint（較大者優先）
  const checkpoint = loadJsonIfExists(CHECKPOINT_FILE, null);
  if (checkpoint && Object.keys(checkpoint).length > Object.keys(result).length) {
    result = checkpoint;
    console.log(`🧷 Loaded checkpoint: ${Object.keys(result).length} items`);
  }

  // 讀失敗清單
  let failed = loadJsonIfExists(FAIL_FILE, []);
  if (!Array.isArray(failed)) failed = [];

  const todo = marketableIds.filter((id) => result[id] == null);
  console.log(`🧾 Remaining items: ${todo.length} / total: ${marketableIds.length}`);

  const batches = chunkArray(todo, BATCH_SIZE);

  let totalDone = 0;
  let ok = 0;
  let skip = 0;

  console.log("🚀 Fetching XIVAPI item names in zh-tw (batched)...");
  console.log("   - Output:", OUT_FILE);
  console.log("   - Checkpoint:", CHECKPOINT_FILE);
  console.log("   - Failed list:", FAIL_FILE);

  // ✅ 先做 1 次 smoke test（讓你立刻看到是不是拿到繁中）
  {
    const testId = marketableIds[0];
    const testUrl = `https://xivapi.com/item/${testId}?language=zh-tw`;
    console.log("🔎 Smoke test URL:", testUrl);
    const testData = await fetchJson(testUrl, 3);
    console.log("🔎 Smoke test Name:", testData?.Name);
  }

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];

    const tasks = batch.map((id) =>
      limit(async () => {
        const url = `https://xivapi.com/item/${id}?language=zh-tw`;
        const data = await fetchJson(url);

        const name = data?.Name;

        // 拿不到 Name -> 失敗
        if (!name || typeof name !== "string" || !name.trim()) {
          failed.push(id);
          skip++;
          return;
        }

        // ✅ 避免英文混入：Name 若全 ASCII，視為 fallback 英文，丟到 failed
        if (isAllAscii(name.trim())) {
          failed.push(id);
          skip++;
          return;
        }

        // ✅ 直接存官方繁中
        result[id] = name.trim();
        ok++;
      })
    );

    await Promise.allSettled(tasks);

    totalDone += batch.length;

    // 每批都寫一次 checkpoint
    saveJson(CHECKPOINT_FILE, result);
    saveJson(FAIL_FILE, [...new Set(failed)]);

    console.log(
      `✔ Batch ${bi + 1}/${batches.length} done. Progress: ${totalDone}/${todo.length} (ok:${ok}, failed:${skip})`
    );
  }

  // 最終輸出
  saveJson(OUT_FILE, result);
  saveJson(FAIL_FILE, [...new Set(failed)]);

  // 成功後可刪 checkpoint（你也可以留著）
  if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE);

  console.log(`✅ Done! ${OUT_FILE}: ${Object.keys(result).length} items`);
  console.log(`⚠️ Failed IDs saved to ${FAIL_FILE}: ${[...new Set(failed)].length} ids`);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
