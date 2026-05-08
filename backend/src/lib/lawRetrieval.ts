import OpenAI from "openai";
import { createServerSupabase } from "./supabase";

const EMBEDDING_MODEL = "text-embedding-3-small" as const;

export interface LawChunkResult {
  content: string;
  metadata: Record<string, unknown> & {
    source: string;
    version_dato: string;
    url: string;
  };
  similarity: number;
}

async function embedQuery(query: string): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [];
  const client = new OpenAI({ apiKey: key });
  const res = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: query,
  });
  return res.data[0].embedding;
}

// ---------------------------------------------------------------------------
// Specific-section detection
// ---------------------------------------------------------------------------
// When the user asks about a specific § or Artikel, we do a metadata lookup
// first so we always return the exact section regardless of embedding
// similarity. Patterns matched:
//   "§ 1 i hvidvaskloven", "§ 42, stk. 3", "artikel 5 DORA", etc.

interface SectionRef {
  paragraf?: string;
  artikel?: string;
  lawHint?: string;
}

const LAW_ALIASES: Record<string, string[]> = {
  hvidvask: ["hvidvask", "hvidvaskloven", "hvidvaskning"],
  databeskyttelse: ["databeskyttelse", "databeskyttelsesloven", "gdpr-implementering", "persondataloven"],
  funktionær: ["funktionær", "funktionærloven"],
  selskab: ["selskab", "selskabsloven"],
  finansiel: ["finansiel virksomhed", "fil", "lov om finansiel"],
  kapitalmarked: ["kapitalmarked", "kapitalmarkedsloven"],
  køb: ["købeloven", "lov om køb"],
  aftale: ["aftaleloven", "aftaler og andre retshandler"],
  faif: ["faif", "alternative investeringsfonde"],
  bæredygtighed: ["bæredygtighed", "bæredygtighedsrapportering", "erklæringsudbydere"],
  dora: ["dora", "2022/2554", "32022r2554", "digital operational resilience"],
  priips: ["priips", "kid", "1286/2014", "32014r1286"],
};

function detectSectionRef(query: string): SectionRef | null {
  const q = query.toLowerCase();

  // Match "§ N" or "§ N a" or "paragraf N".
  // Letter suffixes like "§ 15 a" are captured, but common Danish words
  // after the number ("§ 1 i hvidvaskloven") must not be.
  const paraMatch = q.match(/§\s*(\d+(?:\s*[a-z](?=\s|$|[,.\-)]))?)|paragraf\s+(\d+(?:\s*[a-z](?=\s|$|[,.\-)]))?)/);
  // Clean up: if we captured a trailing letter that looks like a word, drop it.
  // Valid suffixes: a, b, c, d, e (rarely beyond e). Common false positives: i, s, m, etc.
  if (paraMatch) {
    const captured = (paraMatch[1] || paraMatch[2] || "").trim();
    const cleaned = captured.replace(/\s+[f-zæøå]$/, "").trim();
    if (paraMatch[1]) paraMatch[1] = cleaned;
    if (paraMatch[2]) paraMatch[2] = cleaned;
  }
  // Match "artikel N" or "article N" or "art. N"
  const artMatch = q.match(/art(?:ikel|icle|\.)\s*(\d+)/);

  if (!paraMatch && !artMatch) return null;

  const ref: SectionRef = {};
  if (paraMatch) {
    const num = (paraMatch[1] || paraMatch[2]).trim();
    ref.paragraf = `§ ${num}`;
  }
  if (artMatch) {
    ref.artikel = artMatch[1].trim();
  }

  // Try to detect which law the user means.
  for (const [_key, aliases] of Object.entries(LAW_ALIASES)) {
    for (const alias of aliases) {
      if (q.includes(alias.toLowerCase())) {
        ref.lawHint = alias;
        break;
      }
    }
    if (ref.lawHint) break;
  }

  return ref;
}

async function metadataLookup(
  ref: SectionRef,
  db: ReturnType<typeof createServerSupabase>,
): Promise<LawChunkResult[]> {
  // Build a query for retsinformation (§) or eurlex (Artikel).
  if (ref.paragraf) {
    let query = db
      .from("document_chunks")
      .select("content, metadata, source")
      .eq("source", "retsinformation")
      .eq("metadata->>paragraf", ref.paragraf);

    if (ref.lawHint) {
      query = query.ilike("metadata->>lov_titel", `%${ref.lawHint}%`);
    }

    const { data } = await query.limit(15);
    if (data && data.length > 0) {
      return (data as { content: string; metadata: Record<string, unknown>; source: string }[]).map((row) => ({
        content: row.content,
        metadata: row.metadata as LawChunkResult["metadata"],
        similarity: 1.0,
      }));
    }
  }

  if (ref.artikel) {
    let query = db
      .from("document_chunks")
      .select("content, metadata, source")
      .eq("source", "eurlex")
      .eq("metadata->>artikel", ref.artikel);

    if (ref.lawHint) {
      query = query.ilike("metadata->>forordning_titel", `%${ref.lawHint}%`);
    }

    const { data } = await query.limit(15);
    if (data && data.length > 0) {
      return (data as { content: string; metadata: Record<string, unknown>; source: string }[]).map((row) => ({
        content: row.content,
        metadata: row.metadata as LawChunkResult["metadata"],
        similarity: 1.0,
      }));
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Main retrieval — metadata lookup + vector search, merged & deduped
// ---------------------------------------------------------------------------

export async function retrieveDanishLaw(
  query: string,
  matchCount = 10,
): Promise<LawChunkResult[]> {
  if (!process.env.OPENAI_API_KEY) return [];

  const db = createServerSupabase();

  // 1. Try metadata-based lookup for specific section references.
  const sectionRef = detectSectionRef(query);
  let metadataResults: LawChunkResult[] = [];
  if (sectionRef) {
    try {
      metadataResults = await metadataLookup(sectionRef, db);
      if (metadataResults.length > 0) {
        console.log(
          `[lawRetrieval] metadata hit: ${metadataResults.length} chunks for ${sectionRef.paragraf ?? sectionRef.artikel}`,
        );
      }
    } catch (err) {
      console.error("[lawRetrieval] metadata lookup failed:", err);
    }
  }

  // 2. Always also do vector search for broader context.
  let vectorResults: LawChunkResult[] = [];
  try {
    const embedding = await embedQuery(query);
    if (embedding.length) {
      const { data, error } = await db.rpc("match_document_chunks", {
        query_embedding: embedding,
        match_count: matchCount,
        filter_source: null,
      });
      if (error) {
        console.error("[lawRetrieval] RPC error:", error.message);
      } else {
        vectorResults = ((data ?? []) as { content: string; metadata: Record<string, unknown>; similarity: number }[]).map(
          (row) => ({
            content: row.content,
            metadata: row.metadata as LawChunkResult["metadata"],
            similarity: row.similarity,
          }),
        );
      }
    }
  } catch (err) {
    console.error("[lawRetrieval] embedding failed:", err);
  }

  // 3. Merge: metadata results first, then vector results, deduped.
  const seen = new Set<string>();
  const merged: LawChunkResult[] = [];

  const chunkKey = (c: LawChunkResult) => c.content.slice(0, 200);

  for (const c of metadataResults) {
    const key = chunkKey(c);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(c);
    }
  }
  for (const c of vectorResults) {
    const key = chunkKey(c);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(c);
    }
  }

  return merged.slice(0, matchCount);
}

// Format retrieved chunks into a system-prompt block the LLM can cite.
export function formatLawContext(chunks: LawChunkResult[]): string | null {
  if (!chunks.length) return null;

  const header =
    `RELEVANT DANSK LOVGIVNING OG EU-REGULERING:\n` +
    `The following excerpts were retrieved from Danish law (Retsinformation) and EU regulations (EUR-Lex) based on the user's query.\n\n` +
    `CRITICAL — LAW CITATION RULES:\n` +
    `When you reference these law excerpts, you MUST use [N] markers AND include a <CITATIONS> JSON block at the end of your response, exactly like document citations.\n` +
    `For each law citation entry in the JSON block:\n` +
    `- "doc_id": use "retsinformation" for Danish law or "eurlex" for EU regulations\n` +
    `- "page": set to null\n` +
    `- "quote": include the full text of the referenced law excerpt (the complete chunk content, not just a summary). This is essential — the UI displays this text to the user when they click the citation.\n` +
    `- "ref": the same number N used in the [N] marker in your prose\n` +
    `- "filename": use the lov_titel or forordning_titel\n` +
    `Example:\n` +
    `<CITATIONS>\n` +
    `[{"ref": 1, "doc_id": "retsinformation", "page": null, "quote": "§ 1, Stk. 1\\nStk. 1. Denne lov finder anvendelse på følgende virksomheder..."}]\n` +
    `</CITATIONS>\n` +
    `You MUST include this block even if your response only cites law excerpts and no uploaded documents. The [N] markers will not be clickable without it.\n`;

  const entries = chunks.map((c, i) => {
    const m = c.metadata;
    if (m.source === "eurlex") {
      return (
        `[law-${i}] Artikel ${m.artikel} — ${m.forordning_titel} (${m.celex_nummer})\n` +
        `URL: ${m.url}\n` +
        `${c.content}`
      );
    }
    // retsinformation
    const location = m.stykke ? `${m.paragraf}, ${m.stykke}` : m.paragraf;
    return (
      `[law-${i}] ${location} — ${m.lov_titel} (${m.lov_nummer})\n` +
      `URL: ${m.url}\n` +
      `${c.content}`
    );
  });

  return header + "\n" + entries.join("\n\n");
}
