import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
const nm = process.env.DSH_NM ?? 'D:/DSH-Portable/profile/profiles/web/node_modules';
const files = [nm + '/@deepseek-ai/dsh-api-session-controller/lib/index.js', nm + '/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js'];
const MARK = '/* [vision-bridge local patch] admission image gate disabled: text-only sessions accept screenshots; the runtime projects them to placeholders and dsh-vision-bridge handles VLM reading. Re-apply after DSH updates: node scripts/patch-admission-gate.mjs */';
const COND_A = 'model.inputModalities !== void 0 && !model.inputModalities.includes("image")';
const COND_B = "model.inputModalities !== undefined && !model.inputModalities.includes('image')";
for (const f of files) {
  let c = readFileSync(f, 'utf8');
  if (c.includes('[vision-bridge local patch]')) { console.log('SKIP (already patched): ' + f); continue; }
  copyFileSync(f, f + '.bak-vision-bridge');
  const before = c;
  c = c.replace(COND_A, 'false ' + MARK).replace(COND_B, 'false ' + MARK);
  if (c === before) { console.log('NO MATCH (pattern drift — inspect manually): ' + f); process.exitCode = 1; continue; }
  writeFileSync(f, c);
  console.log('PATCHED: ' + f);
}