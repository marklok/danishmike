import { createServerSupabase } from "../lib/supabase";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Known short names / acronyms per law_id.
// Used to populate the short_names[] column so citation lookup can match
// both "hvidvaskloven" and "AML", or "finansiel virksomhed" and "FIL".
// ---------------------------------------------------------------------------

const LAW_ACRONYMS: Record<string, string[]> = {
  hvidvaskloven:           ["hvidvaskloven", "AML"],
  databeskyttelsesloven:   ["databeskyttelsesloven", "GDPR-loven"],
  selskabsloven:           ["selskabsloven", "SEL"],
  "finansiel_virksomhed":  ["finansiel virksomhed", "FIL"],
  kapitalmarkedsloven:     ["kapitalmarkedsloven", "KML"],
  alternativ_investeringsfond: ["alternativ investeringsfond", "FAIF", "FAIF-loven"],
  funktionærloven:         ["funktionærloven"],
  aftaleloven:             ["aftaleloven"],
  købeloven:               ["købeloven"],
  straffeloven:            ["straffeloven", "STR"],
  retsplejeloven:          ["retsplejeloven", "RPL"],
  konkursloven:            ["konkursloven"],
  konkurrenceloven:        ["konkurrenceloven"],
  markedsføringsloven:     ["markedsføringsloven", "MFL"],
  erstatningsansvarsloven: ["erstatningsansvarsloven", "EAL"],
  revisorloven:            ["revisorloven", "RL"],
  selskabsskatteloven:     ["selskabsskatteloven", "SEL-skat"],
  ligningsloven:           ["ligningsloven", "LL"],
  momsloven:               ["momsloven", "ML"],
  tinglysningsloven:       ["tinglysningsloven", "TL"],
  erhvervslejeloven:       ["erhvervslejeloven", "ELL"],
  inkorporeringsloven:     ["inkorporeringsloven", "EMRK"],
  arveloven:               ["arveloven"],
  ferieloven:              ["ferieloven"],
  arbejdsmiljøloven:       ["arbejdsmiljøloven"],
  forbrugeraftaleloven:    ["forbrugeraftaleloven"],
  forsikringsaftaleloven:  ["forsikringsaftaleloven"],
  // Tenancy laws
  lejeloven:               ["lejeloven"],
  "lejeloven-2022-341":    ["lejeloven", "lov om leje 2022"],
  "lejeloven-lbk-2019-927": ["lejeloven", "gammel lejelov", "lejelov 2019"],
  "boligreguleringsloven-lbk-2019-929": ["boligreguleringsloven", "gammel boligreguleringslov"],
  "lov-om-boligforhold-2022-342": ["lov om boligforhold", "boligforholdsloven"],
  almenlejeloven:          ["almenlejeloven"],
  almenboligloven:         ["almenboligloven"],
};

// ---------------------------------------------------------------------------
// Config — which laws to index
// ---------------------------------------------------------------------------

/**
 * A law reference. Either a pinned version or a name-based ref that is
 * resolved to the latest consolidated version at sync time.
 *
 * Env format (comma-separated):
 *   "hvidvaskloven"             → name-based, auto-resolves to latest
 *   "2025/1493:kapitalmarkedsloven" → pinned version with explicit label
 *   "2025/52"                   → pinned version, label derived from API title
 */
type LawRef =
  | { year: number; number: number; label: string }
  | { name: string; label?: string };

const DEFAULT_LAWS: LawRef[] = [
  // Data & privacy
  { name: "databeskyttelsesloven" },
  { year: 2024, number: 1204, label: "nis2-implementeringsloven" },
  // Contract & civil law
  { name: "aftaleloven" },
  { name: "købeloven" },
  { name: "erstatningsansvarsloven" },
  { name: "forbrugeraftaleloven" },
  { name: "forsikringsaftaleloven" },
  // Corporate & commercial
  { name: "selskabsloven" },
  { name: "hvidvaskloven" },
  { name: "markedsføringsloven" },
  { name: "konkursloven" },
  { name: "tinglysningsloven" },
  { name: "revisorloven" },
  // Employment
  { name: "funktionærloven" },
  { name: "ferieloven" },
  { name: "arbejdsmiljøloven" },
  // Criminal & procedural
  { name: "straffeloven" },
  { name: "retsplejeloven" },
  // Family
  { name: "arveloven" },
  // Tenancy
  { name: "lejeloven" },
  { name: "erhvervslejeloven" },
  { name: "almenlejeloven" },
  { name: "almenboligloven" },
];

// ---------------------------------------------------------------------------
// Resolve a law name to the latest {year, number} via retsinformation-api.dk
// ---------------------------------------------------------------------------

interface ResolveResult { year: number; number: number }

/**
 * Laws that can't be resolved via the /resolve?q= endpoint (no popular_title
 * registered) but can be identified by a unique phrase in their full title.
 *
 * Strategy: search by keyword, filter for consolidated/original acts
 * (document_type LBK/LBKH/LOV/LOVH), discard historical versions, pick the
 * one whose title contains the required phrase with the highest year/number.
 */
const TITLE_SEARCH_MAP: Record<string, { keyword: string; titleContains: string }> = {
  kapitalmarkedsloven:         { keyword: "kapitalmarkeder",           titleContains: "lov om kapitalmarkeder" },
  finansiel_virksomhed:        { keyword: "finansiel virksomhed",      titleContains: "lov om finansiel virksomhed" },
  alternativ_investeringsfond: { keyword: "alternative investeringsfonde", titleContains: "forvaltere af alternative investeringsfonde" },
  erklæringsloven:             { keyword: "erklæringsudbydere",        titleContains: "erklæringsudbydere" },
};

const CONSOLIDATED_TYPES = new Set(["LBK", "LBKH", "LOV", "LOVH"]);

async function resolveByTitleSearch(name: string): Promise<ResolveResult | null> {
  const entry = TITLE_SEARCH_MAP[name];
  if (!entry) return null;

  const base = "https://retsinformation-api.dk/v1/lovgivning";
  try {
    const url = `${base}/?search=${encodeURIComponent(entry.keyword)}&pageSize=100`;
    const r = await rateLimitedFetch(url);
    if (!r.ok) return null;

    const body = await r.json() as { data: Array<{
      year: number; number: number; title: string;
      document_type: string; historical: boolean;
    }> };

    const phrase = entry.titleContains.toLowerCase();
    const candidates = (body.data ?? [])
      .filter(
        (d) =>
          !d.historical &&
          CONSOLIDATED_TYPES.has(d.document_type) &&
          d.title.toLowerCase().includes(phrase),
      )
      .sort((a, b) => b.year - a.year || b.number - a.number);

    if (candidates.length > 0) {
      const best = candidates[0];
      console.log(`  [resolve] "${name}" via title-search → ${best.year}/${best.number} (${best.title.slice(0, 60)})`);
      return { year: best.year, number: best.number };
    }
  } catch {
    // fall through
  }
  return null;
}

export async function resolveLatestVersion(name: string): Promise<ResolveResult | null> {
  const base = "https://retsinformation-api.dk/v1/lovgivning";

  // Strategy 1: /resolve?q={name} — works for laws with a popular_title.
  try {
    const r = await rateLimitedFetch(`${base}/resolve?q=${encodeURIComponent(name)}`);
    if (r.ok) {
      const d = await r.json() as { year?: number; number?: number };
      if (d.year && d.number) {
        console.log(`  [resolve] "${name}" → ${d.year}/${d.number}`);
        return { year: d.year, number: d.number };
      }
    }
  } catch {
    // fall through
  }

  // Strategy 2: title-search fallback for laws without a popular_title.
  const byTitle = await resolveByTitleSearch(name);
  if (byTitle) return byTitle;

  console.warn(`  [resolve] Could not resolve "${name}" — skipping`);
  return null;
}

export async function getLawsToIndex(): Promise<Array<{ year: number; number: number; label: string }>> {
  const envVal = process.env.RETSINFORMATION_LAWS;
  const refs: LawRef[] = envVal
    ? envVal.split(",").map((entry) => {
        const trimmed = entry.trim();
        // "year/number:label" or "year/number" → pinned
        if (/^\d{4}\/\d+/.test(trimmed)) {
          const [versionPart, labelPart] = trimmed.split(":");
          const [yearStr, numStr] = versionPart.split("/");
          return {
            year: parseInt(yearStr, 10),
            number: parseInt(numStr, 10),
            label: labelPart?.trim() ?? versionPart,
          };
        }
        // plain name → name-based resolve
        return { name: trimmed };
      })
    : DEFAULT_LAWS;

  const resolved: Array<{ year: number; number: number; label: string }> = [];
  for (const ref of refs) {
    if ("name" in ref) {
      const r = await resolveLatestVersion(ref.name);
      if (r) resolved.push({ ...r, label: ref.label ?? ref.name });
    } else {
      resolved.push(ref);
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// retsinformation-api.dk types
// ---------------------------------------------------------------------------

interface Litra {
  number: string;
  text: string;
}

interface Stk {
  number: string;
  text: string;
  litra: Litra[];
}

interface Paragraph {
  id: string;
  number: string;
  stk: Stk[];
}

interface ParagraphGroup {
  id: string;
  number: string;
  heading: string;
  paragraphs: Paragraph[];
}

interface Chapter {
  chapter_number: string;
  chapter_title: string;
  paragraph_groups: ParagraphGroup[];
}

interface LawDocument {
  title: string;
  short_name: string;     // canonical citation, e.g. "LBK nr 1463 af 18/11/2025"
  accession_number: string;
  year: number;
  number: number;
  effective_date: string;
  eli_uri: string;
  document_type: string;
  structure: {
    title: string;
    preamble?: string[];
    chapters: Chapter[];
  };
}

// ---------------------------------------------------------------------------
// Fetch with rate-limit queue (10 s between calls)
// ---------------------------------------------------------------------------

let lastCallTime = 0;
const RATE_LIMIT_MS = 10_000;

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < RATE_LIMIT_MS) {
    const wait = RATE_LIMIT_MS - elapsed;
    console.log(`  [rate-limit] waiting ${(wait / 1000).toFixed(1)}s…`);
    await new Promise((r) => setTimeout(r, wait));
  }
  lastCallTime = Date.now();
  return fetch(url);
}

const API_BASE = "https://retsinformation-api.dk/v1/lovgivning";

export async function fetchLaw(year: number, num: number): Promise<LawDocument> {
  const url = `${API_BASE}/${year}/${num}`;
  console.log(`  Fetching ${url}`);
  const res = await rateLimitedFetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}: ${await res.text()}`);
  }
  return (await res.json()) as LawDocument;
}

// ---------------------------------------------------------------------------
// ID and text helpers
// ---------------------------------------------------------------------------

/** Produce a stable, lowercase slug from a law label. */
export function makeLawId(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9æøå_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Stable chunk ID.
 * Format: dk_{law_id}_p{section}[_s{stk}][_l{litra}]
 * Section numbers may contain letters (§ 15 a → p15a).
 */
export function makeChunkId(
  lawId: string,
  sectionNumber: string,
  subsection?: string | null,
  nrLitra?: string | null,
): string {
  const sec = sectionNumber.replace(/\s+/g, "").toLowerCase();
  const parts = [`dk`, lawId, `p${sec}`];
  if (subsection) parts.push(`s${subsection.replace(/\s+/g, "").toLowerCase()}`);
  if (nrLitra) parts.push(`l${nrLitra.replace(/\s+/g, "").toLowerCase()}`);
  return parts.join("_");
}

/** Deep-link URL to a specific § on retsinformation.dk. */
function retsinformationUrl(year: number, docId: number, paragrafNr: string): string {
  const cleaned = paragrafNr.replace(/[§.\s]/g, "").trim();
  return `https://www.retsinformation.dk/eli/lta/${year}/${docId}#P${cleaned}`;
}

/**
 * Build the embedding_text for a chunk: a compact legal context header
 * followed by the official text. The header is only used for embedding —
 * official_text is what we store and display verbatim.
 */
function buildEmbeddingText(opts: {
  lawTitle: string;
  shortNames: string[];
  canonicalCitation: string;
  chapterNumber: string | null;
  chapterTitle: string | null;
  sectionNumber: string;
  subsection: string | null;
  nrLitra: string | null;
  officialText: string;
}): string {
  const lines: string[] = [];
  lines.push(`Lov: ${opts.lawTitle}`);
  if (opts.shortNames.length > 0) {
    lines.push(`Alternativ titel: ${opts.shortNames.join(", ")}`);
  }
  if (opts.chapterNumber || opts.chapterTitle) {
    const chapterParts = [opts.chapterNumber, opts.chapterTitle].filter(Boolean);
    lines.push(`Kapitel: ${chapterParts.join(" – ")}`);
  }
  lines.push(`Paragraf: § ${opts.sectionNumber}`);
  if (opts.subsection) lines.push(`Stykke: stk. ${opts.subsection}`);
  if (opts.nrLitra) lines.push(`Nr./litra: ${opts.nrLitra}`);

  // Canonical citation for this specific chunk
  const citParts = [`§ ${opts.sectionNumber}`];
  if (opts.subsection) citParts.push(`stk. ${opts.subsection}`);
  if (opts.nrLitra) citParts.push(`nr. ${opts.nrLitra}`);
  lines.push(`Citation: ${opts.canonicalCitation}, ${citParts.join(", ")}`);

  lines.push("");
  lines.push(opts.officialText);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Chunk row type — mirrors the law_chunks DB schema
// ---------------------------------------------------------------------------

export interface LawChunkRow {
  id: string;
  law_id: string;
  law_title: string;
  short_names: string[];
  accession_number: string;
  canonical_citation: string;
  year: number;
  number: number;
  chapter_number: string | null;
  chapter_title: string | null;
  section_number: string;
  subsection: string | null;
  nr_litra: string | null;
  chunk_level: "section" | "subsection" | "litra";
  parent_id: string | null;
  prev_id: string | null;
  next_id: string | null;
  official_text: string;
  embedding_text: string;
  source_url: string;
  effective_date: string;
  is_current: boolean;
}

// ---------------------------------------------------------------------------
// Token estimation (rough: ~4 chars/token for Danish)
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Build official_text for a single stk (including its litra)
// ---------------------------------------------------------------------------

function stkOfficialText(stk: Stk): string {
  let text = `${stk.number} ${stk.text}`;
  for (const lit of stk.litra) {
    text += `\n  ${lit.number} ${lit.text}`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Main chunking function
// ---------------------------------------------------------------------------

export function chunkLaw(
  doc: LawDocument,
  labelForId: string,
  /** If provided, used as law_id directly instead of makeLawId(labelForId). */
  lawIdOverride?: string,
): LawChunkRow[] {
  const rows: LawChunkRow[] = [];
  const lawId = lawIdOverride ?? makeLawId(labelForId);
  const shortNames = LAW_ACRONYMS[lawId] ?? [labelForId];
  const canonicalCitation = doc.short_name || `${doc.document_type} nr ${doc.number} af ${doc.year}`;

  const baseOpts = {
    lawTitle: doc.title,
    shortNames,
    canonicalCitation,
  };

  for (const chapter of doc.structure.chapters) {
    const chapterNumber = chapter.chapter_number?.trim() || null;
    const chapterTitle  = chapter.chapter_title?.trim()  || null;

    for (const group of chapter.paragraph_groups) {
      for (const para of group.paragraphs) {
        const rawNumber = para.number.replace(/\.$/, "").trim();
        // Strip leading § so section_number is just the number (e.g. "7", "15 a")
        const sectionNumber = rawNumber.replace(/^§\s*/, "").trim();
        const sectionId = makeChunkId(lawId, sectionNumber);
        const sourceUrl = retsinformationUrl(doc.year, doc.number, sectionNumber);

        const sharedMeta = {
          ...baseOpts,
          chapterNumber,
          chapterTitle,
          sectionNumber,
          sourceUrl,
          effectiveDate: doc.effective_date,
        };

        // ----------------------------------------------------------------
        // Case A: Whole § fits in 800 tokens → one section-level chunk.
        // We also use this when the § has only one stk with no litra.
        // ----------------------------------------------------------------
        const fullParaText = para.stk.map((s) => stkOfficialText(s)).join("\n");
        const fullSectionText = `${rawNumber}\n${fullParaText}`;

        if (estimateTokens(fullSectionText) <= 800 || para.stk.length <= 1) {
          rows.push({
            id: sectionId,
            law_id: lawId,
            law_title: doc.title,
            short_names: shortNames,
            accession_number: doc.accession_number,
            canonical_citation: canonicalCitation,
            year: doc.year,
            number: doc.number,
            chapter_number: chapterNumber,
            chapter_title: chapterTitle,
            section_number: sectionNumber,
            subsection: null,
            nr_litra: null,
            chunk_level: "section",
            parent_id: null,
            prev_id: null,  // set in post-processing
            next_id: null,
            official_text: fullSectionText,
            embedding_text: buildEmbeddingText({
              ...sharedMeta,
              subsection: null,
              nrLitra: null,
              officialText: fullSectionText,
            }),
            source_url: sourceUrl,
            effective_date: doc.effective_date,
            is_current: true,
          });
          continue;
        }

        // ----------------------------------------------------------------
        // Case B: § is too long — split by stk.
        // Store parent § row with embedding=null (for context expansion).
        // ----------------------------------------------------------------

        // Parent row (no embedding — stored for context expansion only)
        rows.push({
          id: sectionId,
          law_id: lawId,
          law_title: doc.title,
          short_names: shortNames,
          accession_number: doc.accession_number,
          canonical_citation: canonicalCitation,
          year: doc.year,
          number: doc.number,
          chapter_number: chapterNumber,
          chapter_title: chapterTitle,
          section_number: sectionNumber,
          subsection: null,
          nr_litra: null,
          chunk_level: "section",
          parent_id: null,
          prev_id: null,
          next_id: null,
          official_text: fullSectionText,
          embedding_text: buildEmbeddingText({
            ...sharedMeta,
            subsection: null,
            nrLitra: null,
            officialText: fullSectionText,
          }),
          source_url: sourceUrl,
          effective_date: doc.effective_date,
          is_current: true,
          // embedding will remain null — marked below after insert
        } as LawChunkRow & { _skipEmbedding?: true });

        // Mark this row as embed=null. We add a runtime sentinel.
        (rows[rows.length - 1] as LawChunkRow & { _skipEmbedding: boolean })._skipEmbedding = true;

        // Child stk chunks
        const stkIds: string[] = para.stk.map((stk) => {
          const stkLabel = stk.number.replace(/\.$/, "").trim();
          const stkNumber = stkLabel.replace(/^stk\.\s*/i, "").trim();
          return makeChunkId(lawId, sectionNumber, stkNumber);
        });

        for (let stkIdx = 0; stkIdx < para.stk.length; stkIdx++) {
          const stk = para.stk[stkIdx];
          const stkLabel   = stk.number.replace(/\.$/, "").trim();
          const stkNumber  = stkLabel.replace(/^stk\.\s*/i, "").trim();
          const stkId      = stkIds[stkIdx];
          const stkText    = stkOfficialText(stk);
          const stkFullText = `${rawNumber}, ${stkLabel}\n${stkText}`;

          if (estimateTokens(stkFullText) <= 800 || stk.litra.length === 0) {
            // Single stk chunk
            rows.push({
              id: stkId,
              law_id: lawId,
              law_title: doc.title,
              short_names: shortNames,
              accession_number: doc.accession_number,
              canonical_citation: canonicalCitation,
              year: doc.year,
              number: doc.number,
              chapter_number: chapterNumber,
              chapter_title: chapterTitle,
              section_number: sectionNumber,
              subsection: stkNumber,
              nr_litra: null,
              chunk_level: "subsection",
              parent_id: sectionId,
              prev_id: stkIds[stkIdx - 1] ?? null,
              next_id: stkIds[stkIdx + 1] ?? null,
              official_text: stkFullText,
              embedding_text: buildEmbeddingText({
                ...sharedMeta,
                subsection: stkNumber,
                nrLitra: null,
                officialText: stkFullText,
              }),
              source_url: sourceUrl,
              effective_date: doc.effective_date,
              is_current: true,
            });
          } else {
            // stk is too long — split by litra
            // Store parent stk row with embedding=null
            rows.push({
              id: stkId,
              law_id: lawId,
              law_title: doc.title,
              short_names: shortNames,
              accession_number: doc.accession_number,
              canonical_citation: canonicalCitation,
              year: doc.year,
              number: doc.number,
              chapter_number: chapterNumber,
              chapter_title: chapterTitle,
              section_number: sectionNumber,
              subsection: stkNumber,
              nr_litra: null,
              chunk_level: "subsection",
              parent_id: sectionId,
              prev_id: stkIds[stkIdx - 1] ?? null,
              next_id: stkIds[stkIdx + 1] ?? null,
              official_text: stkFullText,
              embedding_text: buildEmbeddingText({
                ...sharedMeta,
                subsection: stkNumber,
                nrLitra: null,
                officialText: stkFullText,
              }),
              source_url: sourceUrl,
              effective_date: doc.effective_date,
              is_current: true,
            } as LawChunkRow & { _skipEmbedding?: boolean });
            (rows[rows.length - 1] as LawChunkRow & { _skipEmbedding: boolean })._skipEmbedding = true;

            const litraIds = stk.litra.map((lit) => {
              const litraLabel = lit.number.replace(/[.)]$/, "").trim();
              return makeChunkId(lawId, sectionNumber, stkNumber, litraLabel);
            });

            for (let litraIdx = 0; litraIdx < stk.litra.length; litraIdx++) {
              const lit = stk.litra[litraIdx];
              const litraLabel = lit.number.replace(/[.)]$/, "").trim();
              const litraText  = `${rawNumber}, ${stkLabel}, ${litraLabel}\n${litraLabel} ${lit.text}`;

              rows.push({
                id: litraIds[litraIdx],
                law_id: lawId,
                law_title: doc.title,
                short_names: shortNames,
                accession_number: doc.accession_number,
                canonical_citation: canonicalCitation,
                year: doc.year,
                number: doc.number,
                chapter_number: chapterNumber,
                chapter_title: chapterTitle,
                section_number: sectionNumber,
                subsection: stkNumber,
                nr_litra: litraLabel,
                chunk_level: "litra",
                parent_id: stkId,
                prev_id: litraIds[litraIdx - 1] ?? null,
                next_id: litraIds[litraIdx + 1] ?? null,
                official_text: litraText,
                embedding_text: buildEmbeddingText({
                  ...sharedMeta,
                  subsection: stkNumber,
                  nrLitra: litraLabel,
                  officialText: litraText,
                }),
                source_url: sourceUrl,
                effective_date: doc.effective_date,
                is_current: true,
              });
            }
          }
        }
      }
    }
  }

  // Post-processing: filter out chunks below minimum useful size.
  return rows.filter((r) => estimateTokens(r.official_text) >= 10);
}

// ---------------------------------------------------------------------------
// Embedding via OpenAI text-embedding-3-small (1536 dimensions)
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL = "text-embedding-3-small" as const;
const EMBED_BATCH_SIZE = 20;

function getOpenAI(): OpenAI {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is required for embeddings");
  return new OpenAI({ apiKey: key });
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const client = getOpenAI();
  const results: number[][] = [];
  const MAX_EMBED_CHARS = 20_000; // ~6.5k tokens at ~3 chars/token for dense Danish legal text
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE).map((t) => t.slice(0, MAX_EMBED_CHARS));
    const res = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });
    for (const item of res.data) {
      results.push(item.embedding);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Upsert into law_chunks
// ---------------------------------------------------------------------------

export async function upsertChunks(
  rows: LawChunkRow[],
): Promise<{ inserted: number; updated: number; skipped: number }> {
  const db = createServerSupabase();
  let inserted = 0;
  let updated  = 0;
  let skipped  = 0;

  // Fetch existing rows for these IDs in one query.
  const ids = rows.map((r) => r.id);
  const { data: existing } = await db
    .from("law_chunks")
    .select("id, effective_date")
    .in("id", ids);

  const existingMap = new Map<string, string>(
    (existing ?? []).map((e) => [e.id, e.effective_date as string]),
  );

  // Separate rows that need embedding from structural (parent) rows.
  const toEmbed: Array<{ row: LawChunkRow; idx: number }> = [];
  const toUpsertNoEmbed: LawChunkRow[] = [];

  for (const row of rows) {
    const skipEmbed = (row as LawChunkRow & { _skipEmbedding?: boolean })._skipEmbedding;
    const existingDate = existingMap.get(row.id);

    if (existingDate === row.effective_date) {
      skipped++;
      continue;
    }

    if (skipEmbed) {
      toUpsertNoEmbed.push(row);
    } else {
      toEmbed.push({ row, idx: toEmbed.length });
    }
  }

  // Upsert structural (no-embed / parent) rows FIRST so FK references exist.
  for (const row of toUpsertNoEmbed) {
    const { _skipEmbedding: _, ...cleanRow } = row as LawChunkRow & { _skipEmbedding?: boolean };
    const wasExisting = existingMap.has(row.id);

    const { error } = await db.from("law_chunks").upsert({
      ...cleanRow,
      embedding: null,
      updated_at: new Date().toISOString(),
    });

    if (error) {
      console.error(`  [upsert-parent] Error on ${row.id}: ${error.message}`);
    } else {
      wasExisting ? updated++ : inserted++;
    }
  }

  // Embed child rows in batches (parents already exist so FK is satisfied).
  if (toEmbed.length > 0) {
    const texts = toEmbed.map(({ row }) => row.embedding_text);
    const embeddings = await embedTexts(texts);

    for (let i = 0; i < toEmbed.length; i++) {
      const { row } = toEmbed[i];
      const { _skipEmbedding: _, ...cleanRow } = row as LawChunkRow & { _skipEmbedding?: boolean };
      const wasExisting = existingMap.has(row.id);

      const { error } = await db.from("law_chunks").upsert({
        ...cleanRow,
        embedding: embeddings[i],
        updated_at: new Date().toISOString(),
      });

      if (error) {
        console.error(`  [upsert] Error on ${row.id}: ${error.message}`);
      } else {
        wasExisting ? updated++ : inserted++;
      }
    }
  }

  return { inserted, updated, skipped };
}
