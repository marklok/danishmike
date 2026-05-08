import "dotenv/config";
import {
  getLawsToIndex,
  fetchLaw,
  chunkLaw,
  upsertChunks,
} from "./retsinformation";

async function main() {
  const laws = getLawsToIndex();
  console.log(`\n=== Retsinformation sync ===`);
  console.log(`Laws to index: ${laws.length}\n`);

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const law of laws) {
    const label = law.label ?? `${law.year}/${law.number}`;
    console.log(`--- ${label} (${law.year}/${law.number}) ---`);

    try {
      const doc = await fetchLaw(law.year, law.number);
      console.log(`  Title: ${doc.title}`);
      console.log(`  Accession: ${doc.accession_number}`);
      console.log(`  Effective date: ${doc.effective_date}`);

      const chunks = chunkLaw(doc);
      console.log(`  Chunks created: ${chunks.length}`);

      const { inserted, skipped } = await upsertChunks(chunks);
      console.log(`  Inserted: ${inserted}, Skipped (up to date): ${skipped}`);

      totalInserted += inserted;
      totalSkipped += skipped;
    } catch (err) {
      console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
      totalFailed++;
    }

    console.log();
  }

  console.log(`=== Sync complete ===`);
  console.log(`  Total inserted: ${totalInserted}`);
  console.log(`  Total skipped:  ${totalSkipped}`);
  console.log(`  Total failed:   ${totalFailed}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
