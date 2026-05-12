import "dotenv/config";
import { createServerSupabase } from "../lib/supabase";
import {
  getLawsToIndex,
  fetchLaw,
  chunkLaw,
  upsertChunks,
} from "./retsinformation";

async function main() {
  const db = createServerSupabase();

  console.log("Deleting all rows from law_chunks…");
  const { error } = await db.from("law_chunks").delete().neq("id", "");
  if (error) {
    console.error("Failed to delete law_chunks:", error.message);
    process.exit(1);
  }
  console.log("Done.\n");

  const laws = await getLawsToIndex();
  console.log(`=== Retsinformation re-sync ===`);
  console.log(`Laws to index: ${laws.length}\n`);

  let totalInserted = 0;
  let totalFailed   = 0;

  for (const law of laws) {
    console.log(`--- ${law.label} (${law.year}/${law.number}) ---`);
    try {
      const doc = await fetchLaw(law.year, law.number);
      console.log(`  Title: ${doc.title}`);

      const chunks = chunkLaw(doc, law.label);
      console.log(`  Chunks: ${chunks.length}`);

      const { inserted } = await upsertChunks(chunks);
      console.log(`  Inserted: ${inserted}`);
      totalInserted += inserted;
    } catch (err) {
      console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
      totalFailed++;
    }
    console.log();
  }

  console.log(`=== Done ===`);
  console.log(`  Total inserted: ${totalInserted}`);
  console.log(`  Total failed:   ${totalFailed}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
