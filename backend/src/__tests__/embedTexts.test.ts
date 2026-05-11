import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Mock OpenAI so embedTexts can run without a real API key.
// vi.hoisted ensures mockCreate is initialised before the module graph loads,
// making it safe to reference inside the vi.mock factory.
// ---------------------------------------------------------------------------

const { mockCreate } = vi.hoisted(() => {
  const mockCreate = vi.fn().mockImplementation(
    async ({ input }: { input: string[] }) => ({
      data: input.map((_t, i) => ({ embedding: Array(1536).fill(i * 0.001) })),
    }),
  );
  return { mockCreate };
});

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    embeddings: { create: mockCreate },
  })),
}));

// Import after mock is registered.
import { embedTexts } from "../ingestion/retsinformation";

const MAX_EMBED_CHARS = 20_000; // must match the constant in retsinformation.ts

describe("embedTexts — token truncation regression", () => {
  beforeAll(() => {
    process.env.OPENAI_API_KEY = "test-key-for-mock";
  });

  afterAll(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("truncates text longer than 20,000 chars before sending to OpenAI", async () => {
    mockCreate.mockClear();
    const longText = "x".repeat(25_000);
    await embedTexts([longText]);

    expect(mockCreate).toHaveBeenCalledOnce();
    const sentInput: string[] = mockCreate.mock.calls[0][0].input;
    expect(sentInput[0].length).toBe(MAX_EMBED_CHARS);
  });

  it("does not truncate text shorter than 20,000 chars", async () => {
    mockCreate.mockClear();
    const shortText = "Hej verden. Dette er en kort tekst.";
    await embedTexts([shortText]);

    const sentInput: string[] = mockCreate.mock.calls[0][0].input;
    expect(sentInput[0]).toBe(shortText);
  });

  it("text of exactly 20,000 chars is sent unchanged", async () => {
    mockCreate.mockClear();
    const exactText = "y".repeat(MAX_EMBED_CHARS);
    await embedTexts([exactText]);

    const sentInput: string[] = mockCreate.mock.calls[0][0].input;
    expect(sentInput[0].length).toBe(MAX_EMBED_CHARS);
  });

  it("returns one embedding vector per input", async () => {
    const texts = ["tekst 1", "tekst 2", "tekst 3"];
    const result = await embedTexts(texts);
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(1536);
  });

  it("batches 21 texts into two OpenAI calls (batch size is 20)", async () => {
    mockCreate.mockClear();
    const texts = Array.from({ length: 21 }, (_, i) => `tekst ${i}`);
    await embedTexts(texts);
    // Batch size = 20, so 21 texts → 2 calls: [0..19] and [20]
    expect(mockCreate).toHaveBeenCalledTimes(2);
    const firstBatch: string[] = mockCreate.mock.calls[0][0].input;
    const secondBatch: string[] = mockCreate.mock.calls[1][0].input;
    expect(firstBatch).toHaveLength(20);
    expect(secondBatch).toHaveLength(1);
  });
});
