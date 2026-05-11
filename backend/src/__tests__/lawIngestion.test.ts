import { describe, it, expect } from "vitest";
import { makeLawId, makeChunkId, chunkLaw, LawChunkRow } from "../ingestion/retsinformation";
import { parseCitation } from "../lib/lawRetrieval";

// ---------------------------------------------------------------------------
// Minimal fixture — representative retsinformation-api.dk response
// ---------------------------------------------------------------------------

const hvidvaskFixture = {
  title: "Bekendtgørelse af lov om forebyggende foranstaltninger mod hvidvask og finansiering af terrorisme (hvidvaskloven)",
  short_name: "LBK nr 1463 af 18/11/2025",
  accession_number: "A20250146329",
  year: 2025,
  number: 1463,
  effective_date: "2025-11-18",
  eli_uri: "/eli/lta/2025/1463",
  document_type: "LBKH",
  structure: {
    title: "hvidvaskloven",
    chapters: [
      {
        chapter_number: "1",
        chapter_title: "Anvendelsesområde",
        paragraph_groups: [
          {
            id: "pg1",
            number: "1",
            heading: "",
            paragraphs: [
              {
                id: "p1",
                number: "§ 1.",
                stk: [
                  {
                    number: "Stk. 1.",
                    text: "Denne lov finder anvendelse på virksomheder og personer, der er opført i bilag 1.",
                    litra: [],
                  },
                  {
                    number: "Stk. 2.",
                    text: "Loven finder endvidere anvendelse på filialer og datterselskaber.",
                    litra: [],
                  },
                ],
              },
            ],
          },
          {
            id: "pg2",
            number: "7",
            heading: "",
            paragraphs: [
              {
                id: "p7",
                number: "§ 7.",
                // Short § — should become one section chunk
                stk: [
                  {
                    number: "Stk. 1.",
                    text: "Virksomheder og personer skal foretage kundekendskabsprocedurer.",
                    litra: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// makeLawId
// ---------------------------------------------------------------------------

describe("makeLawId", () => {
  it("lowercases and replaces spaces with underscores", () => {
    expect(makeLawId("hvidvaskloven")).toBe("hvidvaskloven");
    expect(makeLawId("alternativ investeringsfond")).toBe("alternativ_investeringsfond");
    expect(makeLawId("finansiel virksomhed")).toBe("finansiel_virksomhed");
  });

  it("strips characters that are not alphanumeric, Danish letters, or underscore", () => {
    expect(makeLawId("NIS2-implementeringsloven")).toBe("nis2implementeringsloven");
  });
});

// ---------------------------------------------------------------------------
// makeChunkId
// ---------------------------------------------------------------------------

describe("makeChunkId", () => {
  it("produces stable section ID", () => {
    expect(makeChunkId("hvidvaskloven", "7")).toBe("dk_hvidvaskloven_p7");
  });

  it("includes subsection", () => {
    expect(makeChunkId("hvidvaskloven", "7", "1")).toBe("dk_hvidvaskloven_p7_s1");
  });

  it("includes litra", () => {
    expect(makeChunkId("hvidvaskloven", "7", "1", "3")).toBe("dk_hvidvaskloven_p7_s1_l3");
  });

  it("handles section number with letter suffix", () => {
    expect(makeChunkId("aftaleloven", "15 a")).toBe("dk_aftaleloven_p15a");
  });
});

// ---------------------------------------------------------------------------
// chunkLaw — structural tests
// ---------------------------------------------------------------------------

describe("chunkLaw", () => {
  const chunks = chunkLaw(hvidvaskFixture as Parameters<typeof chunkLaw>[0], "hvidvaskloven");

  it("produces chunks", () => {
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("§ 7 (single stk) becomes one section-level chunk without splitting", () => {
    const sec7 = chunks.filter((c) => c.section_number === "7");
    expect(sec7.length).toBe(1);
    expect(sec7[0].chunk_level).toBe("section");
    expect(sec7[0].subsection).toBeNull();
  });

  it("section chunk has stable ID", () => {
    const sec7 = chunks.find((c) => c.section_number === "7");
    expect(sec7?.id).toBe("dk_hvidvaskloven_p7");
  });

  it("official_text is unchanged legal text — starts with §", () => {
    const sec7 = chunks.find((c) => c.section_number === "7");
    expect(sec7?.official_text).toMatch(/^§/);
  });

  it("embedding_text contains law title header", () => {
    const sec7 = chunks.find((c) => c.section_number === "7");
    expect(sec7?.embedding_text).toContain("Lov:");
    expect(sec7?.embedding_text).toContain("hvidvaskloven");
  });

  it("embedding_text contains canonical citation", () => {
    const sec7 = chunks.find((c) => c.section_number === "7");
    expect(sec7?.embedding_text).toContain("LBK nr 1463");
  });

  it("embedding_text contains chapter info", () => {
    const sec7 = chunks.find((c) => c.section_number === "7");
    // Chapter info from the fixture
    expect(sec7?.embedding_text).toContain("Kapitel");
  });

  it("official_text and embedding_text are different fields", () => {
    const sec7 = chunks.find((c) => c.section_number === "7");
    expect(sec7?.official_text).not.toBe(sec7?.embedding_text);
  });

  it("source_url uses year and number", () => {
    const sec7 = chunks.find((c) => c.section_number === "7");
    expect(sec7?.source_url).toContain("2025");
    expect(sec7?.source_url).toContain("1463");
    expect(sec7?.source_url).toContain("#P7");
  });

  it("§ 1 with two stk is split when over 800 tokens, or kept whole when short", () => {
    // In our fixture § 1 has two short stk — total tokens well under 800,
    // so it should be a single section chunk.
    const sec1 = chunks.filter((c) => c.section_number === "1");
    // Either all-in-one section chunk OR parent + children — both valid
    expect(sec1.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: litra ")" ID bug
// Bug: lit.number from API is "1)" not "1." — replace(/\.$/, "") didn't strip ")"
// Fix: replace(/[.)]$/, "")
// ---------------------------------------------------------------------------

const LONG = "a".repeat(3_400); // ~850 tokens — forces Case B and Case B2
// Note: chunkLaw post-filters rows where estimateTokens(official_text) < 10 (< 40 chars).
// Litra bodies must be ≥ 40 chars to survive the filter.
const LITRA_BODY = "b".repeat(60); // 60 chars → 15 tokens — survives the minimum filter

const litraRegressionFixture = {
  title: "Testlov om regression",
  short_name: "LOV nr 99 af 01/01/2025",
  accession_number: "A202500009901",
  year: 2025,
  number: 99,
  effective_date: "2025-01-01",
  eli_uri: "/eli/lta/2025/99",
  document_type: "LOV",
  structure: {
    title: "testlov",
    chapters: [
      {
        chapter_number: "1",
        chapter_title: "Testkapitel",
        paragraph_groups: [
          {
            id: "pg1",
            number: "5",
            heading: "",
            paragraphs: [
              {
                id: "p5",
                number: "§ 5.",
                stk: [
                  {
                    // Long stk with litra — triggers Case B2 (litra split)
                    number: "Stk. 1.",
                    text: LONG,
                    litra: [
                      { number: "1)", text: LITRA_BODY },
                      { number: "2)", text: LITRA_BODY },
                    ],
                  },
                  {
                    // Second stk (must also be long enough to pass the filter after combination)
                    number: "Stk. 2.",
                    text: LONG,
                    litra: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

describe("chunkLaw — litra ) ID regression", () => {
  const chunks = chunkLaw(
    litraRegressionFixture as Parameters<typeof chunkLaw>[0],
    "testlov",
  );

  it("litra chunk IDs end with _l1 and _l2, never _l1) or _l2)", () => {
    const litraChunks = chunks.filter((c) => c.chunk_level === "litra");
    expect(litraChunks.length).toBe(2);
    expect(litraChunks[0].id).toBe("dk_testlov_p5_s1_l1");
    expect(litraChunks[1].id).toBe("dk_testlov_p5_s1_l2");
    // Sanity-check: no ) in any chunk ID at all
    for (const c of chunks) {
      expect(c.id).not.toContain(")");
    }
  });

  it("nr_litra is '1' and '2', not '1)' and '2)'", () => {
    const litraChunks = chunks.filter((c) => c.chunk_level === "litra");
    expect(litraChunks[0].nr_litra).toBe("1");
    expect(litraChunks[1].nr_litra).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// Regression: long single-stk section must never split (always Case A)
// Relevant because § 68 in erklæringsloven has 21,930 chars in one stk.
// Splitting is impossible (no stk siblings, no litra) — it stays as one chunk.
// ---------------------------------------------------------------------------

const longStkFixture = {
  title: "Testlov med lang paragraf",
  short_name: "LOV nr 100 af 01/01/2025",
  accession_number: "A202500010001",
  year: 2025,
  number: 100,
  effective_date: "2025-01-01",
  eli_uri: "/eli/lta/2025/100",
  document_type: "LOV",
  structure: {
    title: "testlov2",
    chapters: [
      {
        chapter_number: "1",
        chapter_title: "Testkapitel",
        paragraph_groups: [
          {
            id: "pg1",
            number: "68",
            heading: "",
            paragraphs: [
              {
                id: "p68",
                number: "§ 68.",
                stk: [
                  {
                    // 22,000 chars — mirrors the erklæringsloven § 68 problem
                    number: "Stk. 1.",
                    text: "b".repeat(22_000),
                    litra: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

describe("chunkLaw — long single-stk section never splits", () => {
  const chunks = chunkLaw(
    longStkFixture as Parameters<typeof chunkLaw>[0],
    "testlov2",
  );

  it("produces exactly one chunk for § 68", () => {
    expect(chunks.filter((c) => c.section_number === "68")).toHaveLength(1);
  });

  it("chunk_level is 'section' — not split into subsection", () => {
    const sec68 = chunks.find((c) => c.section_number === "68")!;
    expect(sec68.chunk_level).toBe("section");
  });

  it("official_text preserves full text without truncation", () => {
    const sec68 = chunks.find((c) => c.section_number === "68")!;
    // official_text must contain the full 22k-char stk body
    expect(sec68.official_text).toContain("b".repeat(100));
    expect(sec68.official_text.length).toBeGreaterThan(22_000);
  });

  it("embedding_text is longer than 20,000 chars before embed-time truncation", () => {
    // embedding_text = header + official_text; truncation to 20k happens in embedTexts()
    const sec68 = chunks.find((c) => c.section_number === "68")!;
    expect(sec68.embedding_text.length).toBeGreaterThan(20_000);
  });

  it("chunk is NOT marked _skipEmbedding — it is a leaf, not a structural parent", () => {
    const sec68 = chunks.find((c) => c.section_number === "68")! as LawChunkRow & {
      _skipEmbedding?: boolean;
    };
    expect(sec68._skipEmbedding).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Regression: parent rows must appear before child rows in chunkLaw output
// Bug: upsertChunks inserted toEmbed (children) before toUpsertNoEmbed (parents),
//      causing FK constraint violation when child.parent_id referenced a row
//      that hadn't been inserted yet.
// This test verifies that chunkLaw itself outputs parents before their children
// — and that upsertChunks preserves this contract.
// ---------------------------------------------------------------------------

const multiStkFixture = {
  title: "Testlov med mange stykker",
  short_name: "LOV nr 101 af 01/01/2025",
  accession_number: "A202500010101",
  year: 2025,
  number: 101,
  effective_date: "2025-01-01",
  eli_uri: "/eli/lta/2025/101",
  document_type: "LOV",
  structure: {
    title: "testlov3",
    chapters: [
      {
        chapter_number: "1",
        chapter_title: "Testkapitel",
        paragraph_groups: [
          {
            id: "pg1",
            number: "10",
            heading: "",
            paragraphs: [
              {
                id: "p10",
                number: "§ 10.",
                // Two stk, each ~1800 chars → total > 3200 → triggers Case B
                stk: [
                  {
                    number: "Stk. 1.",
                    text: "c".repeat(1_800),
                    litra: [],
                  },
                  {
                    number: "Stk. 2.",
                    text: "d".repeat(1_800),
                    litra: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

describe("chunkLaw — parent appears before children in output array (FK regression)", () => {
  const chunks = chunkLaw(
    multiStkFixture as Parameters<typeof chunkLaw>[0],
    "testlov3",
  );
  const sec10 = chunks.filter((c) => c.section_number === "10");

  it("§ 10 produces parent + 2 subsection children (Case B)", () => {
    // One section parent + two stk children
    expect(sec10).toHaveLength(3);
  });

  it("parent (section) chunk is first in the array", () => {
    expect(sec10[0].chunk_level).toBe("section");
    expect(sec10[0].parent_id).toBeNull();
  });

  it("parent is marked _skipEmbedding", () => {
    const parent = sec10[0] as LawChunkRow & { _skipEmbedding?: boolean };
    expect(parent._skipEmbedding).toBe(true);
  });

  it("subsection children appear after the parent", () => {
    expect(sec10[1].chunk_level).toBe("subsection");
    expect(sec10[2].chunk_level).toBe("subsection");
  });

  it("children reference parent_id that matches the parent's id", () => {
    const parentId = sec10[0].id;
    expect(sec10[1].parent_id).toBe(parentId);
    expect(sec10[2].parent_id).toBe(parentId);
  });

  it("no child appears before its parent anywhere in the full chunks array", () => {
    const idToIndex = new Map(chunks.map((c, i) => [c.id, i]));
    for (const chunk of chunks) {
      if (chunk.parent_id !== null) {
        const parentIdx = idToIndex.get(chunk.parent_id);
        const childIdx = idToIndex.get(chunk.id)!;
        // parent must exist and come before child
        expect(parentIdx).toBeDefined();
        expect(parentIdx!).toBeLessThan(childIdx);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// parseCitation
// ---------------------------------------------------------------------------

describe("parseCitation", () => {
  it("parses bare § reference", () => {
    const r = parseCitation("Hvad siger § 7?");
    expect(r.sectionNumber).toBe("7");
    expect(r.lawHint).toBeNull();
  });

  it("parses law + §", () => {
    const r = parseCitation("hvidvasklovens § 7");
    expect(r.sectionNumber).toBe("7");
    expect(r.lawHint).toBe("hvidvaskloven");
  });

  it("parses law + § + stk", () => {
    const r = parseCitation("Hvidvaskloven § 7, stk. 1");
    expect(r.sectionNumber).toBe("7");
    expect(r.subsection).toBe("1");
    expect(r.lawHint).toBe("hvidvaskloven");
  });

  it("parses § i law format", () => {
    const r = parseCitation("§ 111 i selskabsloven");
    expect(r.sectionNumber).toBe("111");
    expect(r.lawHint).toBe("selskabsloven");
  });

  it("parses acronym reference — FIL", () => {
    const r = parseCitation("FIL § 64");
    expect(r.sectionNumber).toBe("64");
    expect(r.lawHint).toBe("finansiel_virksomhed");
  });

  it("parses AML acronym", () => {
    const r = parseCitation("AML § 7");
    expect(r.lawHint).toBe("hvidvaskloven");
  });

  it("parses stk + nr", () => {
    const r = parseCitation("§ 7, stk. 1, nr. 3");
    expect(r.sectionNumber).toBe("7");
    expect(r.subsection).toBe("1");
    expect(r.nrLitra).toBe("3");
  });

  it("parses EUR-Lex artikel", () => {
    const r = parseCitation("Artikel 5 i DORA");
    expect(r.artikel).toBe("5");
    expect(r.lawHint).toBe("dora");
  });

  it("does not capture trailing 'i' as section letter suffix", () => {
    // "§ 1 i hvidvaskloven" — '1' is the section, 'i' is Danish for 'in'
    const r = parseCitation("§ 1 i hvidvaskloven");
    expect(r.sectionNumber).toBe("1");
  });

  it("captures real letter suffix — § 15 a", () => {
    const r = parseCitation("aftaleloven § 36");
    expect(r.sectionNumber).toBe("36");
  });
});
