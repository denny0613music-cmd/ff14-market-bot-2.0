import fs from "fs";
import fetch from "node-fetch";
import pLimit from "p-limit";

const limit = pLimit(6);
const BATCH_SIZE = 300;
const OUT_FILE = "./items_zh_tw.json";
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

function isAllAscii(str) {
  return typeof str === "string" && /^[\x00-\x7F]*$/.test(str);
}

async function main() {
  const marketableIds = await fetchJson("https://universalis.app/api/v2/marketable");
  if (!Array.isArray(marketableIds) || marketableIds.length === 0) {
    console.log("Failed to fetch marketable IDs.");
    process.exit(1);
  }

  let result = loadJsonIfExists(OUT_FILE, {});
  let failed = loadJsonIfExists(FAIL_FILE, []);

  const batches = chunkArray(marketableIds, BATCH_SIZE);

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const tasks = batch.map((id) =>
      limit(async () => {
        const data = await fetchJson(`https://xivapi.com/item/${id}?language=zh-tw`);
        const name = data?.Name;
        if (!name || isAllAscii(name.trim())) {
          failed.push(id);
          return;
        }
        result[id] = name.trim();
      })
    );

    await Promise.allSettled(tasks);
    saveJson(CHECKPOINT_FILE, result);
    saveJson(FAIL_FILE, [...new Set(failed)]);
  }

  saveJson(OUT_FILE, result);
  console.log(`Done! Processed ${Object.keys(result).length} items.`);
}

main().catch((e) => {
  console.error("Build failed:", e);
  process.exit(1);
});
