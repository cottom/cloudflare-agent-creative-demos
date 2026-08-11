/**
 * Cloudflare Workers rejects any single static asset over 25 MiB.
 *
 * `@lofcz/pptist` ships a prebuilt ~57 MB export chunk of base64 CJK font data.
 * PPTist's export dialog is disabled in the embed options, so that chunk is
 * never requested at runtime; this drops it from the upload so the deploy
 * succeeds. Anything else over the limit fails the build loudly rather than
 * being removed silently.
 */
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const LIMIT = 25 * 1024 * 1024;
const ALLOWED_TO_DROP = /useExport-[\w-]+\.js(\.map)?$/;
const ROOT = "dist/client";

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

const files = await walk(ROOT).catch(() => []);
let dropped = 0;
for (const file of files) {
  const { size } = await stat(file);
  if (size <= LIMIT) continue;
  const mb = (size / 1024 / 1024).toFixed(1);
  if (!ALLOWED_TO_DROP.test(file)) {
    console.error(`Asset exceeds the 25 MiB Workers limit and is not on the drop list: ${file} (${mb} MB)`);
    process.exit(1);
  }
  await unlink(file);
  dropped += 1;
  console.log(`Dropped oversized PPTist export chunk: ${file} (${mb} MB)`);
}
if (!dropped) console.log("No oversized assets found.");
