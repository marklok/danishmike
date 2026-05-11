import OpenAI from "openai";
import { createServerSupabase } from "./supabase";

const EMBEDDING_MODEL = "text-embedding-3-small" as const;

// ---------------------------------------------------------------------------
// Result type — unified across retsinformation (law_chunks) and EUR-Lex
// (still in document_chunks with legacy schema)
// ---------------------------------------------------------------------------

export interface LawChunkResult {
  // Discriminator
  source: "retsinformation" | "eurlex";

  // Shown to users and used as citation quote
  content: string;

  // Link for citation panel
  url: string;

  // How this result was found (used for reranking)
  match_type: "exact" | "fts" | "vector";
  similarity: number;          // 0–1; exact/fts hits get 1.0

  // Retsinformation-specific (populated for source === "retsinformation")
  id?: string;
  law_id?: string;
  law_title?: string;
  short_names?: string[];
  canonical_citation?: string;
  chapter_number?: string | null;
  chapter_title?: string | null;
  section_number?: string;
  subsection?: string | null;
  nr_litra?: string | null;
  chunk_level?: string;
  parent_id?: string | null;
  effective_date?: string;
  synced_at?: string;           // updated_at from law_chunks — when this version was last synced

  // EUR-Lex backward-compat metadata blob
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Embed a query string
// ---------------------------------------------------------------------------

async function embedQuery(query: string, apiKey?: string | null): Promise<number[]> {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) return [];
  const client = new OpenAI({ apiKey: key });
  const res = await client.embeddings.create({ model: EMBEDDING_MODEL, input: query });
  return res.data[0].embedding;
}

// ---------------------------------------------------------------------------
// Citation parsing
//
// Handles all common Danish legal citation formats:
//   hvidvasklovens § 7
//   Hvidvaskloven § 7, stk. 1
//   § 111 i selskabsloven
//   FIL § 64
//   aftaleloven § 36
//   § 7, stk. 1, nr. 3
//   Artikel 5 DORA
// ---------------------------------------------------------------------------

export interface ParsedCitation {
  lawHint: string | null;       // matched law_id or short name alias
  sectionNumber: string | null; // e.g. "7", "111", "15 a"
  subsection: string | null;    // e.g. "1"
  nrLitra: string | null;       // e.g. "3" or "a"
  artikel: string | null;       // for EUR-Lex
}

/** law_id → aliases (all lowercase). Keep in sync with retsinformation.ts LAW_ACRONYMS. */
const LAW_ALIASES: Record<string, string[]> = {
  hvidvaskloven:              ["hvidvask", "hvidvaskloven", "aml"],
  databeskyttelsesloven:      ["databeskyttelse", "databeskyttelsesloven", "gdpr", "persondataloven"],
  selskabsloven:              ["selskab", "selskabsloven", "sel"],
  finansiel_virksomhed:       ["finansiel virksomhed", "fil", "lov om finansiel"],
  kapitalmarkedsloven:        ["kapitalmarked", "kapitalmarkedsloven", "kml"],
  alternativ_investeringsfond:["alternativ investeringsfond", "faif", "faif-loven", "aifm"],
  funktionærloven:            ["funktionær", "funktionærloven"],
  aftaleloven:                ["aftale", "aftaleloven"],
  købeloven:                  ["køb", "købeloven"],
  straffeloven:               ["straf", "straffeloven", "str"],
  retsplejeloven:             ["retspleje", "retsplejeloven", "rpl"],
  konkursloven:               ["konkurs", "konkursloven"],
  konkurrenceloven:           ["konkurrence", "konkurrenceloven"],
  markedsføringsloven:        ["markedsføring", "markedsføringsloven", "mfl"],
  erstatningsansvarsloven:    ["erstatningsansvar", "erstatningsansvarsloven", "eal"],
  revisorloven:               ["revisor", "revisorloven"],
  tinglysningsloven:          ["tinglysning", "tinglysningsloven", "tl"],
  // Tenancy laws — order matters: more specific (almen*, erhverv*) before "lejeloven"
  // so that "almenlejelovens § 5" doesn't fall through to the lejeloven alias.
  almenlejeloven:             ["almenlejelov", "almenlejeloven"],
  almenboligloven:            ["almenboligloven"],
  erhvervslejeloven:          ["erhvervslejelov", "erhvervslejeloven", "ell"],
  "lov-om-boligforhold-2022-342": ["lov om boligforhold", "boligforholdsloven"],
  "boligreguleringsloven-lbk-2019-929": ["boligreguleringsloven", "boligregulering"],
  lejeloven:                  ["lejeloven"],   // last — "lejeloven" is a suffix of the above
  inkorporeringsloven:        ["emrk", "menneskerettighedskonvention"],
  ferieloven:                 ["ferie", "ferieloven"],
  arbejdsmiljøloven:          ["arbejdsmiljø", "arbejdsmiljøloven"],
  arveloven:                  ["arv", "arveloven"],
  forbrugeraftaleloven:       ["forbrugeraftale", "forbrugeraftaleloven"],
  forsikringsaftaleloven:     ["forsikringsaftale", "forsikringsaftaleloven"],
  ligningsloven:              ["ligning", "ligningsloven", "ll"],
  selskabsskatteloven:        ["selskabsskat", "selskabsskatteloven"],
  momsloven:                  ["moms", "momsloven", "ml"],
  // EUR-Lex
  dora:    ["dora", "2022/2554", "32022r2554", "digital operational resilience"],
  priips:  ["priips", "kid", "1286/2014", "32014r1286"],
};

export function parseCitation(query: string): ParsedCitation {
  const q = query.toLowerCase();

  // § number — capture "§ 7", "§ 15 a", "paragraf 7"
  // We allow a letter suffix only if it's a–e (real paragraph suffix), not i/s/m etc.
  const paraRe = /(?:§\s*|paragraf\s+)(\d+(?:\s*[a-e](?=[\s,.\-]|$))?)/i;
  const paraMatch = q.match(paraRe);
  const sectionNumber = paraMatch
    ? paraMatch[1].trim()
    : null;

  // stk. N
  const stkMatch = q.match(/stk\.?\s*(\d+)/i);
  const subsection = stkMatch ? stkMatch[1] : null;

  // nr. N or litra a/b/c
  const nrMatch = q.match(/nr\.?\s*(\d+)/i) ?? q.match(/litra\s+([a-z])/i);
  const nrLitra = nrMatch ? nrMatch[1] : null;

  // artikel N (EUR-Lex)
  const artMatch = q.match(/art(?:ikel|icle|\.)\s*(\d+)/i);
  const artikel = artMatch ? artMatch[1] : null;

  // Law hint
  let lawHint: string | null = null;
  outer: for (const [lawId, aliases] of Object.entries(LAW_ALIASES)) {
    for (const alias of aliases) {
      if (q.includes(alias.toLowerCase())) {
        lawHint = lawId;
        break outer;
      }
    }
  }

  return { lawHint, sectionNumber, subsection, nrLitra, artikel };
}

// ---------------------------------------------------------------------------
// Step 1: Exact citation lookup (law_chunks table)
// ---------------------------------------------------------------------------

async function exactCitationLookup(
  parsed: ParsedCitation,
  db: ReturnType<typeof createServerSupabase>,
): Promise<LawChunkResult[]> {
  if (!parsed.sectionNumber && !parsed.artikel) return [];

  if (parsed.artikel) {
    // EUR-Lex: still in document_chunks.
    // Match by CELEX number (stored as e.g. "32022R2554") rather than title —
    // the title is in Danish and doesn't contain English acronyms like "DORA".
    const EURLEX_CELEX: Record<string, string> = {
      dora:   "32022R2554",
      priips: "32014R1286",
    };
    let q = db
      .from("document_chunks")
      .select("content, metadata, source")
      .eq("source", "eurlex")
      .eq("metadata->>artikel", parsed.artikel);
    if (parsed.lawHint) {
      const celex = EURLEX_CELEX[parsed.lawHint];
      if (celex) {
        q = q.ilike("metadata->>celex_nummer", `%${celex}%`);
      } else {
        // Unknown regulation — fall back to title search with non-numeric aliases
        const aliases = (LAW_ALIASES[parsed.lawHint] ?? [parsed.lawHint])
          .filter((a) => !/^\d/.test(a));
        if (aliases.length) q = q.ilike("metadata->>forordning_titel", `%${aliases[0]}%`);
      }
    }
    const { data } = await q.limit(10);
    return (data ?? []).map((row) => ({
      source: "eurlex" as const,
      content: row.content,
      url: (row.metadata as Record<string, unknown>).url as string ?? "",
      match_type: "exact" as const,
      similarity: 1.0,
      metadata: row.metadata as Record<string, unknown>,
    }));
  }

  // Retsinformation: law_chunks
  if (!parsed.sectionNumber) return [];

  const SELECT_COLS =
    "id, law_id, law_title, short_names, canonical_citation, chapter_number, chapter_title, section_number, subsection, nr_litra, chunk_level, parent_id, official_text, source_url, effective_date, updated_at";

  // Helper: base query for this section + law
  const baseQ = () => {
    let q = db
      .from("law_chunks")
      .select(SELECT_COLS)
      .eq("section_number", parsed.sectionNumber!)
      .eq("is_current", true);
    if (parsed.lawHint) q = q.eq("law_id", parsed.lawHint);
    return q;
  };

  // ── Case A: specific nr./litra requested (stk. + nr.) ───────────────────
  // Return the litra chunk AND its stk. parent so the model has both the
  // specific content and the surrounding intro text.
  if (parsed.subsection && parsed.nrLitra) {
    const [{ data: litraData }, { data: stkData }] = await Promise.all([
      baseQ()
        .eq("subsection", parsed.subsection)
        .eq("nr_litra", parsed.nrLitra)
        .limit(5),
      baseQ()
        .eq("subsection", parsed.subsection)
        .is("nr_litra", null)
        .limit(3),
    ]);
    const combined = [...(stkData ?? []), ...(litraData ?? [])];
    console.log(
      `[exactCitation] law_id=${parsed.lawHint ?? "(any)"} section=${parsed.sectionNumber} stk=${parsed.subsection} nr=${parsed.nrLitra} → litra:${(litraData ?? []).length} parent:${(stkData ?? []).length}`,
    );
    if (combined.length > 0) {
      return combined.map((row) => toResult(row, "exact"));
    }
    // Fall through to broader lookup if specific litra not found
  }

  // ── Case B: stk. specified (no nr.) — prefer subsection chunk ───────────
  let q = baseQ();
  if (parsed.subsection) {
    q = q.eq("subsection", parsed.subsection).is("nr_litra", null);
  } else {
    q = q.is("subsection", null);
  }

  const { data, error } = await q.limit(15);
  if (error) {
    console.error("[exactCitation] query error:", error.message);
  }
  console.log(
    `[exactCitation] law_id=${parsed.lawHint ?? "(any)"} section=${parsed.sectionNumber} stk=${parsed.subsection ?? "-"} → ${(data ?? []).length} rows`,
  );
  if ((data ?? []).length > 0) {
    return data!.map((row) => toResult(row, "exact"));
  }

  // Subsection fallback: the section may be stored as a single section-level chunk
  // (subsection IS NULL) even when a specific stk was requested. Return the whole
  // section so the model can locate the relevant stk within it.
  if (parsed.subsection) {
    const { data: secData } = await baseQ().is("subsection", null).limit(5);
    console.log(
      `[exactCitation] subsection-fallback (section-level) → ${(secData ?? []).length} rows`,
    );
    if ((secData ?? []).length > 0) {
      return secData!.map((row) => toResult(row, "exact"));
    }
  }

  // Section-number normalisation fallback: parseCitation may return "2 a"
  // (with space) while the DB stores "2a" (no internal space), or vice-versa.
  // If the primary query returned nothing, retry with the opposite form.
  const alt = parsed.sectionNumber!.includes(" ")
    ? parsed.sectionNumber!.replace(/\s+/g, "")   // "2 a" → "2a"
    : parsed.sectionNumber!.replace(/(\d+)([a-e])$/, "$1 $2"); // "2a" → "2 a"

  if (alt !== parsed.sectionNumber) {
    let q2 = db
      .from("law_chunks")
      .select(
        "id, law_id, law_title, short_names, canonical_citation, chapter_number, chapter_title, section_number, subsection, nr_litra, chunk_level, parent_id, official_text, source_url, effective_date, updated_at",
      )
      .eq("section_number", alt)
      .eq("is_current", true);
    if (parsed.lawHint) q2 = q2.eq("law_id", parsed.lawHint);
    if (parsed.subsection) {
      q2 = q2.eq("subsection", parsed.subsection);
    } else {
      q2 = q2.is("subsection", null);
    }
    const { data: data2 } = await q2.limit(15);
    console.log(
      `[exactCitation] alt-form section=${alt} → ${(data2 ?? []).length} rows`,
    );
    return (data2 ?? []).map((row) => toResult(row, "exact"));
  }

  return [];
}

// ---------------------------------------------------------------------------
// Step 2: Full-text search (Danish tsvector)
// ---------------------------------------------------------------------------

async function ftsSearch(
  query: string,
  matchCount: number,
  db: ReturnType<typeof createServerSupabase>,
  filterLawId: string | null = null,
): Promise<LawChunkResult[]> {
  const { data, error } = await db.rpc("search_law_chunks_fts", {
    query_text: query,
    match_count: matchCount,
    filter_law_id: filterLawId,
  });
  if (error) {
    console.error("[lawRetrieval] FTS error:", error.message);
  }
  const ftsRows = data ?? [];
  if (ftsRows.length > 0) {
    return ftsRows.map((row: ReturnType<typeof toResult> extends Promise<infer R> ? never : Parameters<typeof toResult>[0]) =>
      toResult(row, "fts"),
    );
  }

  // FTS fallback: Danish compound words (e.g. "kundekendskab") are not decomposed
  // by PostgreSQL's Danish stemmer, so they don't match compound forms like
  // "kundekendskabsprocedurer". Fall back to ILIKE on the longest significant word.
  const stopWords = new Set(["hvad", "siger", "hvem", "hvilke", "reglerne", "regler",
    "for", "om", "ved", "til", "fra", "med", "den", "det", "der", "som", "kan",
    "skal", "have", "efter", "ifølge", "under", "over", "eller", "ikke"]);
  const words = query
    .toLowerCase()
    .replace(/[?!.,;:()[\]]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 7 && !stopWords.has(w));

  if (words.length === 0) return [];

  // Use the longest word (most domain-specific), then try shorter ones
  words.sort((a, b) => b.length - a.length);
  const searchWord = words[0];

  let ilikeQ = db
    .from("law_chunks")
    .select(
      "id, law_id, law_title, short_names, canonical_citation, chapter_number, chapter_title, section_number, subsection, nr_litra, chunk_level, parent_id, official_text, source_url, effective_date, updated_at",
    )
    .eq("is_current", true)
    .ilike("official_text", `%${searchWord}%`);
  if (filterLawId) ilikeQ = ilikeQ.eq("law_id", filterLawId);
  const { data: ilikeData } = await ilikeQ.limit(matchCount);

  if ((ilikeData ?? []).length > 0) {
    console.log(`[lawRetrieval] FTS fallback (ILIKE '%${searchWord}%'): ${ilikeData!.length} hits`);
  }
  return (ilikeData ?? []).map((row) => toResult(row, "fts"));
}

// ---------------------------------------------------------------------------
// Step 3: Vector search (law_chunks)
// ---------------------------------------------------------------------------

async function vectorSearch(
  embedding: number[],
  matchCount: number,
  db: ReturnType<typeof createServerSupabase>,
  filterLawId: string | null = null,
): Promise<LawChunkResult[]> {
  const { data, error } = await db.rpc("match_law_chunks", {
    query_embedding: embedding,
    match_count: matchCount,
    filter_law_id: filterLawId,
  });
  if (error) {
    console.error("[lawRetrieval] vector search error:", error.message);
    return [];
  }
  return (data ?? []).map((row: { similarity: number } & Record<string, unknown>) =>
    toResult(row, "vector"),
  );
}

// ---------------------------------------------------------------------------
// EUR-Lex vector search (still in document_chunks)
// ---------------------------------------------------------------------------

async function eurlexVectorSearch(
  embedding: number[],
  matchCount: number,
  db: ReturnType<typeof createServerSupabase>,
): Promise<LawChunkResult[]> {
  const { data, error } = await db.rpc("match_document_chunks", {
    query_embedding: embedding,
    match_count: matchCount,
    filter_source: "eurlex",
  });
  if (error) return [];
  return (data ?? []).map((row: { content: string; metadata: Record<string, unknown>; similarity: number }) => ({
    source: "eurlex" as const,
    content: row.content,
    url: (row.metadata.url as string) ?? "",
    match_type: "vector" as const,
    similarity: row.similarity,
    metadata: row.metadata,
  }));
}

// ---------------------------------------------------------------------------
// Step 4: Context expansion — fetch parent + neighbors for child chunks
// ---------------------------------------------------------------------------

async function expandContext(
  results: LawChunkResult[],
  db: ReturnType<typeof createServerSupabase>,
): Promise<LawChunkResult[]> {
  const expansionIds = new Set<string>();
  const existingIds  = new Set<string>(results.map((r) => r.id).filter(Boolean) as string[]);

  for (const r of results) {
    if (r.source !== "retsinformation") continue;
    if (r.parent_id && !existingIds.has(r.parent_id)) expansionIds.add(r.parent_id);
    // Note: prev_id / next_id expansion can be added here if desired
  }

  if (expansionIds.size === 0) return results;

  const { data } = await db
    .from("law_chunks")
    .select(
      "id, law_id, law_title, short_names, canonical_citation, chapter_number, chapter_title, section_number, subsection, nr_litra, chunk_level, parent_id, official_text, source_url, effective_date, updated_at",
    )
    .in("id", [...expansionIds]);

  const expanded = (data ?? []).map((row) => toResult(row, "exact"));
  return [...results, ...expanded];
}

// ---------------------------------------------------------------------------
// Reranking
//
// Score = match_type_bonus + citation_match_bonus + similarity
//   exact  → +2.0
//   fts    → +1.0
//   vector → +0.0
// Citation match (law_id or section_number matches the query hint) → +0.5
// ---------------------------------------------------------------------------

function rerank(
  results: LawChunkResult[],
  parsed: ParsedCitation,
): LawChunkResult[] {
  const typeBonus: Record<string, number> = { exact: 2.0, fts: 1.0, vector: 0.0 };

  return results
    .map((r) => {
      let score = (typeBonus[r.match_type] ?? 0) + r.similarity;

      // Bonus if the result is from the hinted law
      if (parsed.lawHint && r.law_id === parsed.lawHint) score += 0.5;

      // Bonus if section number matches
      if (parsed.sectionNumber && r.section_number === parsed.sectionNumber) score += 0.5;

      return { result: r, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ result }) => result);
}

// ---------------------------------------------------------------------------
// Main retrieval entry point
// ---------------------------------------------------------------------------

export async function retrieveDanishLaw(
  query: string,
  matchCount = 10,
  apiKey?: string | null,
): Promise<LawChunkResult[]> {
  const db = createServerSupabase();
  const parsed = parseCitation(query);

  // 1. Exact citation lookup
  let exactResults: LawChunkResult[] = [];
  if (parsed.sectionNumber || parsed.artikel) {
    try {
      exactResults = await exactCitationLookup(parsed, db);
      if (exactResults.length) {
        console.log(`[lawRetrieval] exact hit: ${exactResults.length} chunks`);
      }
    } catch (err) {
      console.error("[lawRetrieval] exact lookup failed:", err);
    }
  }

  // 2. Embed query (needed for FTS trigger check + vector search)
  let embedding: number[] = [];
  try {
    embedding = await embedQuery(query, apiKey);
  } catch (err) {
    console.error("[lawRetrieval] embedding failed:", err);
  }

  // 3. FTS search — when we have a strong law hint (parsed citation), restrict
  //    FTS to that law so we don't surface same-section-number hits from other laws.
  let ftsResults: LawChunkResult[] = [];
  try {
    ftsResults = await ftsSearch(query, matchCount, db, parsed.lawHint ?? null);
  } catch (err) {
    console.error("[lawRetrieval] FTS failed:", err);
  }

  // 4. Vector search (law_chunks + eurlex)
  let vectorResults: LawChunkResult[] = [];
  if (embedding.length) {
    try {
      const [lawVec, eurlexVec] = await Promise.all([
        vectorSearch(embedding, matchCount, db, parsed.lawHint ?? null),
        eurlexVectorSearch(embedding, Math.ceil(matchCount / 2), db),
      ]);
      vectorResults = [...lawVec, ...eurlexVec];
    } catch (err) {
      console.error("[lawRetrieval] vector search failed:", err);
    }
  }

  // 5. Merge + deduplicate by chunk id (or content prefix for EUR-Lex)
  const seen = new Set<string>();
  const merged: LawChunkResult[] = [];

  const key = (r: LawChunkResult) => r.id ?? r.content.slice(0, 120);

  for (const batch of [exactResults, ftsResults, vectorResults]) {
    for (const r of batch) {
      const k = key(r);
      if (!seen.has(k)) {
        seen.add(k);
        merged.push(r);
      }
    }
  }

  // 6. Context expansion (fetch parents of child chunks)
  const expanded = await expandContext(merged, db);

  // 7. Rerank
  const ranked = rerank(expanded, parsed);

  return ranked.slice(0, matchCount);
}

// ---------------------------------------------------------------------------
// Format retrieved chunks into a system-prompt block for the LLM
// ---------------------------------------------------------------------------

export function formatLawContext(chunks: LawChunkResult[]): string | null {
  if (!chunks.length) return null;

  const header =
    `RELEVANT DANSK LOVGIVNING OG EU-REGULERING:\n` +
    `The following excerpts were retrieved directly from Retsinformation (Danish law) and EUR-Lex (EU regulations).\n` +
    `Base your answer on these excerpts. Do NOT answer from general legal knowledge when excerpts are provided — always refer to the specific text below.\n\n` +
    `CITATION RULES FOR LAW EXCERPTS:\n` +
    `When you reference a law excerpt in your response, cite it using its exact label (e.g. [law-0], [law-1]).\n` +
    `These labels become clickable citation links — do NOT include law citations in a <CITATIONS> block.\n` +
    `Only include uploaded document citations in <CITATIONS> as usual.\n`;

  const entries = chunks.map((c, i) => {
    if (c.source === "eurlex") {
      const m = c.metadata ?? {};
      return (
        `[law-${i}] Artikel ${m.artikel} — ${m.forordning_titel} (${m.celex_nummer})\n` +
        `URL: ${c.url}\n` +
        `${c.content}`
      );
    }
    // retsinformation
    const location = c.subsection
      ? `§ ${c.section_number}, stk. ${c.subsection}`
      : `§ ${c.section_number}`;
    const lawLabel = c.canonical_citation
      ? `${c.law_title} (${c.canonical_citation})`
      : c.law_title ?? "";
    const chapterLine = (c.chapter_number || c.chapter_title)
      ? `Kapitel ${[c.chapter_number, c.chapter_title].filter(Boolean).join(" – ")}\n`
      : "";
    return (
      `[law-${i}] ${location} — ${lawLabel}\n` +
      `${chapterLine}` +
      `URL: ${c.url}\n` +
      `${c.content}`
    );
  });

  return header + "\n" + entries.join("\n\n");
}

// ---------------------------------------------------------------------------
// Internal helper: map a law_chunks DB row to LawChunkResult
// ---------------------------------------------------------------------------

function toResult(
  row: Record<string, unknown>,
  matchType: "exact" | "fts" | "vector",
): LawChunkResult {
  return {
    source: "retsinformation",
    content: row.official_text as string,
    url: (row.source_url as string) ?? "",
    match_type: matchType,
    similarity: (row.similarity as number) ?? (row.rank as number) ?? 1.0,
    id: row.id as string,
    law_id: row.law_id as string,
    law_title: row.law_title as string,
    short_names: row.short_names as string[],
    canonical_citation: row.canonical_citation as string,
    chapter_number: row.chapter_number as string | null,
    chapter_title: row.chapter_title as string | null,
    section_number: row.section_number as string,
    subsection: row.subsection as string | null,
    nr_litra: row.nr_litra as string | null,
    chunk_level: row.chunk_level as string,
    parent_id: row.parent_id as string | null,
    effective_date: row.effective_date as string,
    synced_at: row.updated_at as string | undefined,
  };
}
