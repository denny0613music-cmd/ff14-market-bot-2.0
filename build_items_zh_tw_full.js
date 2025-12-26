import fs from "fs";
import fetch from "node-fetch";
import pLimit from "p-limit";

const limit = pLimit(4);
const BATCH_SIZE = 300;

const OUT_FILE = "./items_zh_tw.json"; // 產出：name -> id（先用英文）
const CHECKPOINT_FILE = "./items_zh_tw.checkpoint.json";
const FAIL_FILE = "./items_zh_tw_failed.json";

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, retry = 6) {
  for (let i = 0; i < retry; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.error(`Error fetching ${url}:`, e.message || e);
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

// 先用 XIVAPI 英文名跑通
async function fetchNameEn(id) {
  const data = await fetchJson(`https://xivapi.com/item/${id}?language=en`);
  const name = data?.Name;
  return typeof name === "string" ? name.trim() : "";
}

async function main() {
  const marketableIds = await fetchJson("https://universalis.app/api/v2/marketable");
  if (!Array.isArray(marketableIds) || marketableIds.length === 0) {
    console.log("❌ Failed to fetch marketable IDs.");
    process.exit(1);
  }

  let lookup = loadJsonIfExists(OUT_FILE, {}); // name -> id
  let failed = loadJsonIfExists(FAIL_FILE, []);

  const batches = chunkArray(marketableIds, BATCH_SIZE);

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];

    const tasks = batch.map((id) =>
      limit(async () => {
        const name = await fetchNameEn(id);
        if (!name) {
          failed.push(id);
          return;
        }

        // name -> id；重名時保留較小 id
        if (!lookup[name] || Number(id) < Number(lookup[name])) {
          lookup[name] = Number(id);
        }
      })
    );

    await Promise.allSettled(tasks);

    saveJson(CHECKPOINT_FILE, lookup);
    saveJson(FAIL_FILE, [...new Set(failed)]);

    console.log(
      `✅ Batch ${bi + 1}/${batches.length} done. items=${Object.keys(lookup).length} failed=${failed.length}`
    );
  }

  saveJson(OUT_FILE, lookup);
  console.log(`🎉 Done! items=${Object.keys(lookup).length}, failed=${failed.length}`);
}

main().catch((e) => {
  console.error("❌ Build failed:", e);
  process.exit(1);
});
