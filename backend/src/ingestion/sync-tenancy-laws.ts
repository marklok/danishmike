/**
 * sync-tenancy-laws.ts
 *
 * Imports all 8 Danish tenancy laws defined in legal-sets/dk-tenancy-law.ts
 * into law_chunks, reusing the existing retsinformation ingestion pipeline.
 *
 * Usage:
 *   npm run sync:tenancy-laws
 *
 * Each law is resolved, fetched, chunked, embedded, and upserted.
 * Historical laws use their own stable law_ids and will never overwrite the
 * current lejeloven — upsertChunks keys on chunk ID, and historical chunk IDs
 * contain the versioned law_id (e.g. dk_lejeloven-lbk-2019-927_p7_s1).
 *
 * The script is safe to re-run: unchanged chunks are skipped.
 */

import "dotenv/config";
import {
  fetchLaw,
  chunkLaw,
  upsertChunks,
} from "./retsinformation";
import { resolveLatestVersion } from "./retsinformation";
import { DK_TENANCY_LAW, LEGAL_SET_ID, type TenancyLawEntry } from "./legal-sets/dk-tenancy-law";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

async function resolve(
  entry: TenancyLawEntry,
): Promise<{ year: number; number: number } | null> {
  if (entry.resolution.method === "direct") {
    return { year: entry.resolution.year, number: entry.resolution.number };
  }
  // resolve method: call the API
  const result = await resolveLatestVersion(entry.resolution.name);
  if (!result) {
    console.warn(`  [resolve] FAILED for "${entry.key}" (${entry.resolution.name})`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface SyncResult {
  key: string;
  title: string;
  historical: boolean;
  year?: number;
  number?: number;
  chunks?: number;
  inserted?: number;
  updated?: number;
  skipped?: number;
  error?: string;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`\n[sync-tenancy] === ${LEGAL_SET_ID} sync started at ${startedAt} ===\n`);

  const results: SyncResult[] = [];
  const warnings: string[] = [];

  for (const entry of DK_TENANCY_LAW) {
    const prefix = entry.historical ? "[historical]" : "[current]  ";
    console.log(`${prefix} ${entry.key} (${entry.role})`);

    const resolved = await resolve(entry);
    if (!resolved) {
      const err = `Could not resolve ${entry.resolution.method === "direct"
        ? `${entry.resolution.year}/${entry.resolution.number}`
        : entry.resolution.name}`;
      console.error(`  ✗ ${err}`);
      results.push({ key: entry.key, title: entry.title, historical: entry.historical, error: err });
      continue;
    }

    const { year, number } = resolved;

    // Warn if lejeloven-2022-341 (pinned reform) and lejeloven (current) resolve
    // to the same document — expected until an LBK is published.
    if (
      entry.key === "lejeloven-2022-341" &&
      results.some((r) => r.key === "lejeloven" && r.year === year && r.number === number)
    ) {
      warnings.push(
        `lejeloven and lejeloven-2022-341 both resolved to ${year}/${number} — ` +
        `no LBK consolidation exists yet. Both are indexed separately under their own law_ids.`,
      );
    }

    try {
      const doc = await fetchLaw(year, number);
      // Pass entry.key as the lawIdOverride so chunk IDs use the stable key,
      // not makeLawId(doc.title) which could change if the title changes.
      const chunks = chunkLaw(doc, entry.key, entry.key);
      const stats = await upsertChunks(chunks);

      console.log(
        `  ✓ ${year}/${number} → ${chunks.length} chunks` +
        ` (inserted:${stats.inserted} updated:${stats.updated} skipped:${stats.skipped})`,
      );

      results.push({
        key: entry.key,
        title: entry.title,
        historical: entry.historical,
        year,
        number,
        chunks: chunks.length,
        ...stats,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${message}`);
      results.push({
        key: entry.key,
        title: entry.title,
        historical: entry.historical,
        year,
        number,
        error: message,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  const finishedAt = new Date().toISOString();
  const failed = results.filter((r) => r.error);
  const succeeded = results.filter((r) => !r.error);

  console.log(`\n${"─".repeat(70)}`);
  console.log(`[sync-tenancy] === Summary (${LEGAL_SET_ID}) ===`);
  console.log(`  Finished: ${finishedAt}`);
  console.log(`  Laws:     ${results.length} total | ${succeeded.length} ok | ${failed.length} failed`);
  console.log();

  for (const r of succeeded) {
    const hist = r.historical ? " [historical]" : "";
    console.log(
      `  ✓  ${r.key}${hist}` +
      `\n       law_id: ${r.key} | ${r.year}/${r.number}` +
      `\n       chunks: ${r.chunks} (inserted:${r.inserted} updated:${r.updated} skipped:${r.skipped})`,
    );
  }

  if (failed.length > 0) {
    console.log();
    for (const r of failed) {
      console.log(`  ✗  ${r.key}: ${r.error}`);
    }
  }

  if (warnings.length > 0) {
    console.log(`\n  Warnings:`);
    for (const w of warnings) {
      console.log(`  ⚠  ${w}`);
    }
  }

  console.log(`${"─".repeat(70)}\n`);

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[sync-tenancy] Fatal error:", err);
  process.exit(1);
});
