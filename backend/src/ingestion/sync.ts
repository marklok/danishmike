import "dotenv/config";
import {
  getLawsToIndex,
  fetchLaw,
  chunkLaw,
  upsertChunks,
} from "./retsinformation";

async function main() {
  const laws = await getLawsToIndex();
  console.log(`\n=== Retsinformation sync ===`);
  console.log(`Laws to index: ${laws.length}\n`);

  let totalInserted = 0;
  let totalUpdated  = 0;
  let totalSkipped  = 0;
  let totalFailed   = 0;

  for (const law of laws) {
    console.log(`--- ${law.label} (${law.year}/${law.number}) ---`);
    try {
      const doc = await fetchLaw(law.year, law.number);
      console.log(`  Title: ${doc.title}`);

      const chunks = chunkLaw(doc, law.label);
      console.log(`  Chunks: ${chunks.length}`);

      const { inserted, updated, skipped } = await upsertChunks(chunks);
      console.log(`  Inserted: ${inserted}, Updated: ${updated}, Skipped: ${skipped}`);

      totalInserted += inserted;
      totalUpdated  += updated;
      totalSkipped  += skipped;
    } catch (err) {
      console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
      totalFailed++;
    }
    console.log();
  }

  console.log(`=== Sync complete ===`);
  console.log(`  Inserted: ${totalInserted}`);
  console.log(`  Updated:  ${totalUpdated}`);
  console.log(`  Skipped:  ${totalSkipped}`);
  console.log(`  Failed:   ${totalFailed}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
