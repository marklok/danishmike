import "dotenv/config";
import {
  getRegulationsToIndex,
  fetchRegulationHtml,
  parseRegulationHtml,
  chunkRegulation,
  upsertEurLexChunks,
} from "./eurlex";

async function main() {
  const regulations = getRegulationsToIndex();
  console.log(`\n=== EUR-Lex sync ===`);
  console.log(`Regulations to index: ${regulations.length}\n`);

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const reg of regulations) {
    const label = reg.label ?? reg.celex;
    console.log(`--- ${label} (${reg.celex}) ---`);

    try {
      const html = await fetchRegulationHtml(reg.celex);
      console.log(`  HTML size: ${(html.length / 1024).toFixed(1)} KB`);

      const parsed = parseRegulationHtml(html, reg.celex);
      console.log(`  Title: ${parsed.title.slice(0, 100)}`);
      console.log(`  Articles found: ${parsed.articles.length}`);

      const chunks = chunkRegulation(parsed);
      console.log(`  Chunks created: ${chunks.length}`);

      const { inserted, skipped } = await upsertEurLexChunks(chunks);
      console.log(`  Inserted: ${inserted}, Skipped (up to date): ${skipped}`);

      totalInserted += inserted;
      totalSkipped += skipped;
    } catch (err) {
      console.error(
        `  FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
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
