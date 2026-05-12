import "dotenv/config";
import { getLawsToIndex } from "./retsinformation";

async function main() {
  console.log("=== Resolving law names ===\n");
  const laws = await getLawsToIndex();
  console.log("\nResolved:");
  laws.forEach(l => console.log(`  ${l.year}/${l.number}${l.label ? " — " + l.label : ""}`));
  console.log(`\nTotal: ${laws.length} laws`);
}
main();
