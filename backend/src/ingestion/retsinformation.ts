import { createServerSupabase } from "../lib/supabase";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Config — which laws to index
// ---------------------------------------------------------------------------

type LawRef = { year: number; number: number; label?: string };

const DEFAULT_LAWS: LawRef[] = [
  { year: 2018, number: 502, label: "GDPR-implementeringsloven" },
  { year: 2024, number: 1204, label: "NIS2-implementeringsloven" },
  { year: 2017, number: 1002, label: "Funktionærloven" },
];

export function getLawsToIndex(): LawRef[] {
  const envVal = process.env.RETSINFORMATION_LAWS;
  if (!envVal) return DEFAULT_LAWS;
  return envVal.split(",").map((pair) => {
    const trimmed = pair.trim();
    const [yearStr, numStr] = trimmed.split("/");
    return { year: parseInt(yearStr, 10), number: parseInt(numStr, 10) };
  });
}

// ---------------------------------------------------------------------------
// retsinformation-api.dk types (relevant subset)
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
  short_name: string;
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

export async function fetchLaw(
  year: number,
  num: number,
): Promise<LawDocument> {
  const url = `${API_BASE}/${year}/${num}`;
  console.log(`  Fetching ${url}`);
  const res = await rateLimitedFetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}: ${await res.text()}`);
  }
  return (await res.json()) as LawDocument;
}

// ---------------------------------------------------------------------------
// Chunk by legal structure (§ / stk.)
// ---------------------------------------------------------------------------

export interface LawChunk {
  content: string;
  metadata: {
    source: "retsinformation";
    lov_titel: string;
    lov_nummer: string;
    paragraf: string;
    stykke: string | null;
    version_dato: string;
    url: string;
  };
}

// Rough token count: ~4 chars per token for Danish text.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function retsinformationUrl(docId: number, paragrafNr: string): string {
  const cleaned = paragrafNr.replace(/[§.\s]/g, "").trim();
  return `https://www.retsinformation.dk/eli/lta/${docId}#P${cleaned}`;
}

// Build the display text for a single stk, including its litra items.
function stkFullText(stk: Stk): string {
  let text = `${stk.number} ${stk.text}`;
  for (const lit of stk.litra) {
    text += `\n  ${lit.number} ${lit.text}`;
  }
  return text;
}

export function chunkLaw(doc: LawDocument): LawChunk[] {
  const chunks: LawChunk[] = [];
  const lovNummer = doc.accession_number || `${doc.document_type} nr ${doc.number} af ${doc.year}`;
  const versionDato = doc.effective_date;

  for (const chapter of doc.structure.chapters) {
    for (const group of chapter.paragraph_groups) {
      for (const para of group.paragraphs) {
        const paragrafLabel = para.number.replace(/\.$/, "").trim();
        const deepUrl = retsinformationUrl(doc.number, paragrafLabel);

        // Try the whole § as one chunk first.
        const fullParaText = para.stk
          .map((s) => stkFullText(s))
          .join("\n");
        const fullText = `${paragrafLabel}\n${fullParaText}`;

        if (estimateTokens(fullText) <= 800) {
          chunks.push({
            content: fullText,
            metadata: {
              source: "retsinformation",
              lov_titel: doc.title,
              lov_nummer: lovNummer,
              paragraf: paragrafLabel,
              stykke: null,
              version_dato: versionDato,
              url: deepUrl,
            },
          });
        } else {
          // § is too long — split by stk.
          for (const stk of para.stk) {
            const stkLabel = stk.number.replace(/\.$/, "").trim();
            const stkText = `${paragrafLabel}, ${stkLabel}\n${stkFullText(stk)}`;

            if (estimateTokens(stkText) <= 800) {
              chunks.push({
                content: stkText,
                metadata: {
                  source: "retsinformation",
                  lov_titel: doc.title,
                  lov_nummer: lovNummer,
                  paragraf: paragrafLabel,
                  stykke: stkLabel,
                  version_dato: versionDato,
                  url: deepUrl,
                },
              });
            } else {
              // Even a single stk is too long — split litra into sub-chunks.
              let buffer = `${paragrafLabel}, ${stkLabel}\n${stk.number} ${stk.text}`;
              let partIndex = 0;
              for (const lit of stk.litra) {
                const litLine = `\n  ${lit.number} ${lit.text}`;
                if (estimateTokens(buffer + litLine) > 800 && buffer.length > 0) {
                  chunks.push({
                    content: buffer,
                    metadata: {
                      source: "retsinformation",
                      lov_titel: doc.title,
                      lov_nummer: lovNummer,
                      paragraf: paragrafLabel,
                      stykke: `${stkLabel} (del ${++partIndex})`,
                      version_dato: versionDato,
                      url: deepUrl,
                    },
                  });
                  buffer = `${paragrafLabel}, ${stkLabel} (fortsat)\n`;
                }
                buffer += litLine;
              }
              if (buffer.trim()) {
                chunks.push({
                  content: buffer,
                  metadata: {
                    source: "retsinformation",
                    lov_titel: doc.title,
                    lov_nummer: lovNummer,
                    paragraf: paragrafLabel,
                    stykke: partIndex > 0 ? `${stkLabel} (del ${partIndex + 1})` : stkLabel,
                    version_dato: versionDato,
                    url: deepUrl,
                  },
                });
              }
            }
          }
        }
      }
    }
  }

  // Filter out empty chunks and chunks below the minimum useful size.
  return chunks.filter((c) => estimateTokens(c.content) >= 10);
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
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
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
// Upsert into Supabase document_chunks
// ---------------------------------------------------------------------------

export async function upsertChunks(chunks: LawChunk[]): Promise<{ inserted: number; skipped: number }> {
  const db = createServerSupabase();
  let inserted = 0;
  let skipped = 0;

  // Check which chunks already exist with the same version.
  for (const chunk of chunks) {
    const { data: existing } = await db
      .from("document_chunks")
      .select("id, metadata")
      .eq("source", "retsinformation")
      .contains("metadata", {
        lov_nummer: chunk.metadata.lov_nummer,
        paragraf: chunk.metadata.paragraf,
        stykke: chunk.metadata.stykke,
        version_dato: chunk.metadata.version_dato,
      })
      .limit(1);

    if (existing && existing.length > 0) {
      skipped++;
      continue;
    }

    // Delete any old version of this same chunk (different version_dato).
    await db
      .from("document_chunks")
      .delete()
      .eq("source", "retsinformation")
      .contains("metadata", {
        lov_nummer: chunk.metadata.lov_nummer,
        paragraf: chunk.metadata.paragraf,
        stykke: chunk.metadata.stykke,
      });

    // Embed and insert.
    const [embedding] = await embedTexts([chunk.content]);
    const { error } = await db.from("document_chunks").insert({
      content: chunk.content,
      embedding: embedding,
      metadata: chunk.metadata,
      source: "retsinformation",
    });
    if (error) {
      console.error(`  [upsert] Error inserting chunk ${chunk.metadata.paragraf}: ${error.message}`);
    } else {
      inserted++;
    }
  }

  return { inserted, skipped };
}
