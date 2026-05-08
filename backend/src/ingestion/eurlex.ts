import { createServerSupabase } from "../lib/supabase";
import { embedTexts } from "./retsinformation";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config — which regulations to index
// ---------------------------------------------------------------------------

export interface RegulationRef {
  celex: string;
  label?: string;
}

const DEFAULT_REGULATIONS: RegulationRef[] = [
  { celex: "32022R2554", label: "DORA" },
  { celex: "32014R1286", label: "PRIIPs/KID" },
];

export function getRegulationsToIndex(): RegulationRef[] {
  const envVal = process.env.EURLEX_REGULATIONS;
  if (!envVal) return DEFAULT_REGULATIONS;
  return envVal.split(",").map((s) => {
    const trimmed = s.trim();
    const [celex, label] = trimmed.includes(":") ? trimmed.split(":") : [trimmed, undefined];
    return { celex, label };
  });
}

// ---------------------------------------------------------------------------
// EUR-Lex HTML fetching (with WAF retry) and local file fallback
// ---------------------------------------------------------------------------

const RATE_LIMIT_MS = 1_000;
let lastCallTime = 0;

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < RATE_LIMIT_MS) {
    const wait = RATE_LIMIT_MS - elapsed;
    await new Promise((r) => setTimeout(r, wait));
  }
  lastCallTime = Date.now();
  return fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
      "Accept-Language": "da,en;q=0.9",
    },
  });
}

function eurLexHtmlUrl(celex: string): string {
  return `https://eur-lex.europa.eu/legal-content/DA/TXT/HTML/?uri=CELEX:${celex}`;
}

function eurLexUrl(celex: string): string {
  return `https://eur-lex.europa.eu/legal-content/DA/TXT/?uri=CELEX:${celex}`;
}

function localFilePath(celex: string): string {
  return path.resolve(__dirname, "../../data/eurlex", `${celex}.html`);
}

export async function fetchRegulationHtml(celex: string): Promise<string> {
  // Try local file first (placed there by user to bypass WAF).
  const local = localFilePath(celex);
  if (fs.existsSync(local)) {
    console.log(`  Loading from local file: ${local}`);
    return fs.readFileSync(local, "utf-8");
  }

  // Try fetching from EUR-Lex directly.
  const url = eurLexHtmlUrl(celex);
  console.log(`  Fetching ${url}`);
  const res = await rateLimitedFetch(url);

  if (res.status === 202 || !res.ok) {
    throw new Error(
      `EUR-Lex returned ${res.status} for ${celex}. ` +
        `This is likely a WAF challenge. Download the HTML manually from:\n` +
        `  ${url}\n` +
        `Save it as: ${local}`,
    );
  }

  const html = await res.text();
  if (html.includes("challenge.js") || html.includes("AwsWafIntegration")) {
    throw new Error(
      `EUR-Lex returned a WAF challenge page for ${celex}. ` +
        `Download the HTML manually from:\n` +
        `  ${url}\n` +
        `Save it as: ${local}`,
    );
  }

  return html;
}

// ---------------------------------------------------------------------------
// HTML parsing — extract articles from EUR-Lex Danish regulation HTML
// ---------------------------------------------------------------------------

interface ParsedArticle {
  artikelNr: string;
  title: string | null;
  bodyText: string;
}

interface ParsedRegulation {
  title: string;
  celexNr: string;
  articles: ParsedArticle[];
}

export function parseRegulationHtml(
  html: string,
  celex: string,
): ParsedRegulation {
  // EUR-Lex HTML has the regulation title early in the document and
  // articles marked as "Artikel N" (sometimes in bold / ti-art class).
  // We extract using regex since the HTML structure varies across docs.

  // Strip HTML tags helper.
  const stripTags = (s: string) =>
    s
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#8217;/g, "'")
      .replace(/&#\d+;/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  // Extract document title — look for the regulation title in the HTML.
  let regTitle = celex;
  const titleMatch = html.match(
    /<p[^>]*class="[^"]*oj-doc-ti[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
  );
  if (titleMatch) {
    regTitle = stripTags(titleMatch[1]).replace(/\s+/g, " ").trim();
  } else {
    const h1Match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (h1Match) {
      const cleaned = stripTags(h1Match[1]).trim();
      if (cleaned && cleaned.length > 10) regTitle = cleaned;
    }
  }

  // Split by article headings. EUR-Lex Danish uses "Artikel N" or
  // "Artikel NN" as standalone paragraphs, usually wrapped in
  // <p class="ti-art"> or <p class="..."> with bold text.
  // We split the entire HTML at each article boundary.
  const articlePattern =
    /(<p[^>]*>[\s\S]*?Artikel\s+(\d+)[\s\S]*?<\/p>)/gi;
  const boundaries: { index: number; artikelNr: string; fullMatch: string }[] =
    [];
  let match: RegExpExecArray | null;
  while ((match = articlePattern.exec(html)) !== null) {
    // Only accept if "Artikel N" is the main content (not embedded in a long paragraph).
    const textContent = stripTags(match[1]);
    if (textContent.replace(/\s+/g, " ").trim().length < 200) {
      boundaries.push({
        index: match.index,
        artikelNr: match[2],
        fullMatch: match[1],
      });
    }
  }

  // Deduplicate: if the same Artikel number appears multiple times, keep the first.
  const seen = new Set<string>();
  const uniqueBoundaries = boundaries.filter((b) => {
    if (seen.has(b.artikelNr)) return false;
    seen.add(b.artikelNr);
    return true;
  });

  const articles: ParsedArticle[] = [];
  for (let i = 0; i < uniqueBoundaries.length; i++) {
    const start = uniqueBoundaries[i];
    const endIdx =
      i + 1 < uniqueBoundaries.length
        ? uniqueBoundaries[i + 1].index
        : html.length;

    const articleHtml = html.slice(
      start.index + start.fullMatch.length,
      endIdx,
    );
    const rawText = stripTags(articleHtml);

    // The first line after the article heading is often the article title.
    const lines = rawText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    let title: string | null = null;
    let bodyStart = 0;

    if (
      lines.length > 0 &&
      lines[0].length < 120 &&
      !lines[0].match(/^\d+[\.\)]/)
    ) {
      title = lines[0];
      bodyStart = 1;
    }

    const bodyText = lines.slice(bodyStart).join("\n");

    if (bodyText.length > 20) {
      articles.push({
        artikelNr: start.artikelNr,
        title,
        bodyText,
      });
    }
  }

  return { title: regTitle, celexNr: celex, articles };
}

// ---------------------------------------------------------------------------
// Chunking — by article, with overflow splitting
// ---------------------------------------------------------------------------

export interface EurLexChunk {
  content: string;
  metadata: {
    source: "eurlex";
    forordning_titel: string;
    celex_nummer: string;
    artikel: string;
    version_dato: string;
    url: string;
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function chunkRegulation(parsed: ParsedRegulation): EurLexChunk[] {
  const chunks: EurLexChunk[] = [];
  const versionDato = new Date().toISOString().slice(0, 10);
  const url = eurLexUrl(parsed.celexNr);

  for (const article of parsed.articles) {
    const header = article.title
      ? `Artikel ${article.artikelNr} — ${article.title}`
      : `Artikel ${article.artikelNr}`;
    const fullText = `${header}\n${article.bodyText}`;

    if (estimateTokens(fullText) <= 800) {
      chunks.push({
        content: fullText,
        metadata: {
          source: "eurlex",
          forordning_titel: parsed.title,
          celex_nummer: parsed.celexNr,
          artikel: article.artikelNr,
          version_dato: versionDato,
          url,
        },
      });
    } else {
      // Split long articles by numbered paragraphs (1., 2., etc.)
      const paragraphPattern = /^(\d+)[\.\)]/m;
      const lines = article.bodyText.split("\n");
      const paragraphs: { nr: string; text: string }[] = [];
      let current: { nr: string; lines: string[] } | null = null;

      for (const line of lines) {
        const pMatch = line.match(paragraphPattern);
        if (pMatch) {
          if (current) {
            paragraphs.push({ nr: current.nr, text: current.lines.join("\n") });
          }
          current = { nr: pMatch[1], lines: [line] };
        } else if (current) {
          current.lines.push(line);
        } else {
          // Preamble text before first numbered paragraph.
          if (!paragraphs.length && line.trim()) {
            paragraphs.push({ nr: "0", text: line });
          }
        }
      }
      if (current) {
        paragraphs.push({ nr: current.nr, text: current.lines.join("\n") });
      }

      if (paragraphs.length <= 1) {
        // Can't split by paragraphs — just split by token limit.
        const parts = splitByTokenLimit(fullText, 800);
        parts.forEach((part, idx) => {
          chunks.push({
            content: `${header} (del ${idx + 1})\n${part}`,
            metadata: {
              source: "eurlex",
              forordning_titel: parsed.title,
              celex_nummer: parsed.celexNr,
              artikel: `${article.artikelNr} (del ${idx + 1})`,
              version_dato: versionDato,
              url,
            },
          });
        });
      } else {
        // Group paragraphs into chunks under the token limit.
        let buffer = header;
        let bufferNrs: string[] = [];
        for (const para of paragraphs) {
          const addition = `\n${para.text}`;
          if (
            estimateTokens(buffer + addition) > 800 &&
            bufferNrs.length > 0
          ) {
            chunks.push({
              content: buffer,
              metadata: {
                source: "eurlex",
                forordning_titel: parsed.title,
                celex_nummer: parsed.celexNr,
                artikel: article.artikelNr,
                version_dato: versionDato,
                url,
              },
            });
            buffer = `${header} (fortsat)`;
            bufferNrs = [];
          }
          buffer += addition;
          bufferNrs.push(para.nr);
        }
        if (buffer.trim() && bufferNrs.length > 0) {
          chunks.push({
            content: buffer,
            metadata: {
              source: "eurlex",
              forordning_titel: parsed.title,
              celex_nummer: parsed.celexNr,
              artikel: article.artikelNr,
              version_dato: versionDato,
              url,
            },
          });
        }
      }
    }
  }

  return chunks.filter((c) => estimateTokens(c.content) >= 10);
}

function splitByTokenLimit(text: string, limit: number): string[] {
  const parts: string[] = [];
  const words = text.split(/\s+/);
  let current: string[] = [];

  for (const word of words) {
    current.push(word);
    if (estimateTokens(current.join(" ")) > limit) {
      const last = current.pop()!;
      if (current.length > 0) parts.push(current.join(" "));
      current = [last];
    }
  }
  if (current.length > 0) parts.push(current.join(" "));
  return parts;
}

// ---------------------------------------------------------------------------
// Upsert into Supabase document_chunks
// ---------------------------------------------------------------------------

export async function upsertEurLexChunks(
  chunks: EurLexChunk[],
): Promise<{ inserted: number; skipped: number }> {
  const db = createServerSupabase();
  let inserted = 0;
  let skipped = 0;

  for (const chunk of chunks) {
    const { data: existing } = await db
      .from("document_chunks")
      .select("id, metadata")
      .eq("source", "eurlex")
      .contains("metadata", {
        celex_nummer: chunk.metadata.celex_nummer,
        artikel: chunk.metadata.artikel,
        version_dato: chunk.metadata.version_dato,
      })
      .limit(1);

    if (existing && existing.length > 0) {
      skipped++;
      continue;
    }

    // Delete any old version of this same chunk.
    await db
      .from("document_chunks")
      .delete()
      .eq("source", "eurlex")
      .contains("metadata", {
        celex_nummer: chunk.metadata.celex_nummer,
        artikel: chunk.metadata.artikel,
      });

    const [embedding] = await embedTexts([chunk.content]);
    const { error } = await db.from("document_chunks").insert({
      content: chunk.content,
      embedding,
      metadata: chunk.metadata,
      source: "eurlex",
    });
    if (error) {
      console.error(
        `  [upsert] Error inserting Artikel ${chunk.metadata.artikel}: ${error.message}`,
      );
    } else {
      inserted++;
    }
  }

  return { inserted, skipped };
}
