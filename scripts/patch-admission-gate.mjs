#!/usr/bin/env node
/**
 * Admission-gate patch (design §5.4): the stock session controller rejects
 * image-carrying prompts for text-only models (MODEL_DOES_NOT_SUPPORT_IMAGES),
 * which stops screenshots from ever entering the session log — the bridge's
 * tool/auto paths then have nothing to read. This script lazifies that gate
 * (condition → `false`) in both runtime copies, so images land as attachments
 * and the runtime projects them to placeholders for the bridge to handle.
 *
 * Idempotent: a file already carrying the marker is skipped; every first
 * patch is preceded by a `.bak-vision-bridge` backup. DSH updates overwrite
 * the core packages — re-run afterwards (or press the card's "一键修复").
 *
 * Two faces (design §11.4):
 * - CLI: `node scripts/patch-admission-gate.mjs` (behavior unchanged);
 * - Node API: `applyAdmissionPatch({nodeModulesDir, logger})` — used by the
 *   POST /vision-bridge/fix-admission route. The CLI is detected through
 *   argv[1] so importing the module for the API never runs the CLI body.
 */
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Derive the default from DSH_HOME when available (review #7: a public repo
// must not hardcode one contributor's local checkout). Falls back to the
// legacy portable path when the env is unset.
const DEFAULT_NM = (() => {
  const dshHome = process.env.DSH_HOME;
  if (typeof dshHome === 'string' && dshHome.trim() !== '') {
    return dshHome.replace(/[\\/]+$/, '').replaceAll('\\', '/') + '/profiles/web/node_modules';
  }
  return 'D:/DSH-Portable/profile/profiles/web/node_modules';
})();
const MARK = '/* [vision-bridge local patch] admission image gate disabled: text-only sessions accept screenshots; the runtime projects them to placeholders and dsh-vision-bridge handles VLM reading. Re-apply after DSH updates: node scripts/patch-admission-gate.mjs */';
const COND_A = 'model.inputModalities !== void 0 && !model.inputModalities.includes("image")';
const COND_B = "model.inputModalities !== undefined && !model.inputModalities.includes('image')";

/** Marker string the patch leaves in both files (shared with detection). */
export const ADMISSION_PATCH_MARKER = '[vision-bridge local patch]';

/** The two core-package files the patch targets, under one node_modules root. */
export function admissionPatchTargets(nodeModulesDir) {
  const root = String(nodeModulesDir ?? DEFAULT_NM);
  return [
    root + '/@deepseek-ai/dsh-api-session-controller/lib/index.js',
    root + '/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js',
  ];
}

/**
 * Detect the patch state without writing anything (design §11.2-4): search
 * each target file for the marker.
 * @returns {{status: 'ok'|'missing'|'unknown', files: Array<{file: string, status: 'ok'|'missing'|'unknown', error?: string}>}}
 *   'ok' — every target carries the marker; 'missing' — at least one readable
 *   target lacks it; 'unknown' — a target is unreadable/absent (and none is
 *   merely missing the marker).
 */
export function detectAdmissionPatch(nodeModulesDir) {
  const files = admissionPatchTargets(nodeModulesDir).map((file) => {
    try {
      if (!existsSync(file)) return { file, status: 'unknown', error: 'file not found' };
      const content = readFileSync(file, 'utf8');
      return { file, status: content.includes(ADMISSION_PATCH_MARKER) ? 'ok' : 'missing' };
    } catch (error) {
      return { file, status: 'unknown', error: String(error?.message ?? error) };
    }
  });
  const status = files.some((f) => f.status === 'missing')
    ? 'missing'
    : files.some((f) => f.status === 'unknown') ? 'unknown' : 'ok';
  return { status, files };
}

/**
 * Apply the patch programmatically (idempotent, `.bak-vision-bridge` backup
 * before the first write of each file). Never sets process.exitCode and never
 * throws for per-file failures — both outcomes are reported per file.
 * @param {{nodeModulesDir?: string, logger?: {info?: Function, warn?: Function, error?: Function}}} [options]
 * @returns {Array<{file: string, status: 'patched'|'skipped'|'nomatch'|'error', error?: string}>}
 */
export function applyAdmissionPatch({ nodeModulesDir, logger } = {}) {
  const results = [];
  for (const file of admissionPatchTargets(nodeModulesDir)) {
    try {
      let content;
      try {
        content = readFileSync(file, 'utf8');
      } catch (error) {
        results.push({ file, status: 'error', error: String(error?.message ?? error) });
        logger?.warn?.('vision-bridge: admission patch target unreadable (' + file + ')');
        continue;
      }
      if (content.includes(ADMISSION_PATCH_MARKER)) {
        results.push({ file, status: 'skipped' });
        continue;
      }
      copyFileSync(file, file + '.bak-vision-bridge');
      const before = content;
      content = content.replace(COND_A, 'false ' + MARK).replace(COND_B, 'false ' + MARK);
      if (content === before) {
        results.push({ file, status: 'nomatch', error: 'pattern drift — inspect manually' });
        logger?.warn?.('vision-bridge: admission gate pattern not found in ' + file + ' (DSH update changed the source?)');
        continue;
      }
      writeFileSync(file, content);
      results.push({ file, status: 'patched' });
    } catch (error) {
      results.push({ file, status: 'error', error: String(error?.message ?? error) });
      logger?.error?.('vision-bridge: admission patch failed for ' + file + ' (' + (error?.message ?? error) + ')');
    }
  }
  return results;
}

/** CLI entry — preserved verbatim from the pre-export behavior. */
function runCli() {
  const nm = process.env.DSH_NM ?? DEFAULT_NM;
  const files = admissionPatchTargets(nm);
  for (const f of files) {
    let c = readFileSync(f, 'utf8');
    if (c.includes(ADMISSION_PATCH_MARKER)) { console.log('SKIP (already patched): ' + f); continue; }
    copyFileSync(f, f + '.bak-vision-bridge');
    const before = c;
    c = c.replace(COND_A, 'false ' + MARK).replace(COND_B, 'false ' + MARK);
    if (c === before) { console.log('NO MATCH (pattern drift — inspect manually): ' + f); process.exitCode = 1; continue; }
    writeFileSync(f, c);
    console.log('PATCHED: ' + f);
  }
}

// Run as CLI only when this file is the executed entry point.
// Windows drive-case and separator variance would make a strict equality
// silently no-op the CLI (review #8), so compare resolved real paths.
function realpathSafe(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}
const invoked = process.argv[1] !== undefined
  ? realpathSafe(fileURLToPath(import.meta.url)) === realpathSafe(process.argv[1])
  : false;
if (invoked) runCli();
