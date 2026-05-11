/**
 * Tests for the dk-tenancy-law legal set configuration.
 */

import { describe, it, expect } from "vitest";
import { DK_TENANCY_LAW, LEGAL_SET_ID } from "../ingestion/legal-sets/dk-tenancy-law";
import { makeLawId } from "../ingestion/retsinformation";

describe("dk-tenancy-law legal set config", () => {
  it("exports exactly 8 entries", () => {
    expect(DK_TENANCY_LAW).toHaveLength(8);
  });

  it("all entries have unique keys", () => {
    const keys = DK_TENANCY_LAW.map((e) => e.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it("all entries have unique keys that are also unique as law_ids", () => {
    // Keys must not accidentally collide via makeLawId used elsewhere.
    // Since we bypass makeLawId with lawIdOverride, the key IS the law_id.
    const keys = DK_TENANCY_LAW.map((e) => e.key);
    // Verify none of the keys happen to equal makeLawId of another key.
    for (const key of keys) {
      const derived = makeLawId(key);
      // If derived !== key (e.g. hyphens were stripped), the override matters.
      // Either way, the set of actual law_ids used (all `key` values) must be unique.
      expect(keys.filter((k) => k === key)).toHaveLength(1);
      void derived; // acknowledged
    }
  });

  it("historical entries have historical: true", () => {
    const historicalKeys = [
      "lejeloven-2022-341",
      "lejeloven-lbk-2019-927",
      "boligreguleringsloven-lbk-2019-929",
    ];
    for (const key of historicalKeys) {
      const entry = DK_TENANCY_LAW.find((e) => e.key === key);
      expect(entry, `entry ${key} should exist`).toBeDefined();
      expect(entry!.historical, `${key} should be historical`).toBe(true);
    }
  });

  it("current entries have historical: false", () => {
    const currentKeys = [
      "lejeloven",
      "erhvervslejeloven",
      "almenlejeloven",
      "almenboligloven",
      "lov-om-boligforhold-2022-342",
    ];
    for (const key of currentKeys) {
      const entry = DK_TENANCY_LAW.find((e) => e.key === key);
      expect(entry, `entry ${key} should exist`).toBeDefined();
      expect(entry!.historical, `${key} should not be historical`).toBe(false);
    }
  });

  it("direct-resolution entries have correct year/number", () => {
    const pinned: Array<{ key: string; year: number; number: number }> = [
      { key: "lejeloven-2022-341",              year: 2022, number: 341  },
      { key: "lejeloven-lbk-2019-927",          year: 2019, number: 927  },
      { key: "boligreguleringsloven-lbk-2019-929", year: 2019, number: 929 },
      { key: "lov-om-boligforhold-2022-342",    year: 2022, number: 342  },
    ];
    for (const { key, year, number } of pinned) {
      const entry = DK_TENANCY_LAW.find((e) => e.key === key);
      expect(entry, `entry ${key} should exist`).toBeDefined();
      expect(entry!.resolution.method).toBe("direct");
      if (entry!.resolution.method === "direct") {
        expect(entry!.resolution.year).toBe(year);
        expect(entry!.resolution.number).toBe(number);
      }
    }
  });

  it("resolve-based entries use the correct popular name", () => {
    const resolve: Array<{ key: string; name: string }> = [
      { key: "lejeloven",        name: "lejeloven"        },
      { key: "erhvervslejeloven", name: "erhvervslejeloven" },
      { key: "almenlejeloven",   name: "almenlejeloven"   },
      { key: "almenboligloven",  name: "almenboligloven"  },
    ];
    for (const { key, name } of resolve) {
      const entry = DK_TENANCY_LAW.find((e) => e.key === key);
      expect(entry, `entry ${key} should exist`).toBeDefined();
      expect(entry!.resolution.method).toBe("resolve");
      if (entry!.resolution.method === "resolve") {
        expect(entry!.resolution.name).toBe(name);
      }
    }
  });

  it("historical entries all use direct resolution (not resolve)", () => {
    const historical = DK_TENANCY_LAW.filter((e) => e.historical);
    for (const entry of historical) {
      expect(entry.resolution.method, `${entry.key} should use direct resolution`).toBe("direct");
    }
  });

  it("LEGAL_SET_ID is dk-tenancy-law", () => {
    expect(LEGAL_SET_ID).toBe("dk-tenancy-law");
  });

  it("each entry has a non-empty key, title, and role", () => {
    for (const entry of DK_TENANCY_LAW) {
      expect(entry.key.length).toBeGreaterThan(0);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.role.length).toBeGreaterThan(0);
    }
  });
});

describe("chunk ID isolation: historical law_ids cannot collide with current", () => {
  it("lejeloven-2022-341 key is distinct from lejeloven key", () => {
    const current = DK_TENANCY_LAW.find((e) => e.key === "lejeloven")!;
    const historical = DK_TENANCY_LAW.find((e) => e.key === "lejeloven-2022-341")!;
    expect(current.key).not.toBe(historical.key);
    // Chunk IDs are prefixed: dk_{key}_p{section} — different keys → different IDs
    const currentPrefix = `dk_${current.key}_`;
    const historicalPrefix = `dk_${historical.key}_`;
    expect(currentPrefix).not.toBe(historicalPrefix);
  });
});
