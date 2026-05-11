/**
 * Legal set: Danish tenancy law (dk-tenancy-law)
 *
 * Defines the 8 laws that together form the core of Danish tenancy law —
 * both the current laws and key historical versions needed for legal analysis.
 *
 * Each entry has a stable law_id that is used as the primary key in law_chunks.
 * Historical entries use versioned law_ids (e.g. lejeloven-lbk-2019-927) so
 * they never overwrite the current law.
 *
 * Resolution methods:
 *   "resolve"  — call /v1/lovgivning/resolve?q={name} at sync time; follows
 *                the API's popular_title to whatever is the current version.
 *                Use this for laws where we always want the latest.
 *   "direct"   — fixed year/number; never changes.
 *                Use this for pinned historical versions.
 */

export type LegalSetRole =
  | "current_primary"    // The current governing law for general tenancy
  | "reform_basis"       // The reform act that replaced the old law
  | "historical_primary" // The primary law that was in force before the reform
  | "historical_related" // A related law that was in force before the reform
  | "related_primary"    // A current law that replaced a historical related law
  | "commercial_tenancy" // Governs commercial leases
  | "public_housing";    // Governs public/social housing

export interface TenancyLawEntry {
  /** Stable identifier used as law_id in law_chunks. Never change this. */
  key: string;
  /** Human-readable title for logging and documentation. */
  title: string;
  /** Role within the legal set. */
  role: LegalSetRole;
  /**
   * Whether this entry represents a historical (no longer current) version.
   * Historical entries always use "direct" resolution and a versioned key so
   * they cannot overwrite the current law.
   */
  historical: boolean;
  /** How to resolve this law to a year/number at sync time. */
  resolution:
    | { method: "resolve"; name: string }
    | { method: "direct"; year: number; number: number };
}

export const LEGAL_SET_ID = "dk-tenancy-law";

/**
 * The 8 tenancy laws to index.
 *
 * Note: as of 2025, there is no consolidated LBK for lejeloven yet — the 2022
 * reform law (2022/341) is itself the current law. When Retsinformation
 * publishes an LBK, the "lejeloven" entry (resolve-based) will automatically
 * follow it; "lejeloven-2022-341" will remain pinned to the reform act.
 */
export const DK_TENANCY_LAW: TenancyLawEntry[] = [
  // ── Current laws ────────────────────────────────────────────────────────────
  {
    key: "lejeloven",
    title: "Lejeloven (gældende)",
    role: "current_primary",
    historical: false,
    resolution: { method: "resolve", name: "lejeloven" },
  },
  {
    key: "erhvervslejeloven",
    title: "Erhvervslejeloven (gældende)",
    role: "commercial_tenancy",
    historical: false,
    resolution: { method: "resolve", name: "erhvervslejeloven" },
  },
  {
    key: "almenlejeloven",
    title: "Almenlejeloven (gældende)",
    role: "public_housing",
    historical: false,
    resolution: { method: "resolve", name: "almenlejeloven" },
  },
  {
    key: "almenboligloven",
    title: "Almenboligloven (gældende)",
    role: "public_housing",
    historical: false,
    resolution: { method: "resolve", name: "almenboligloven" },
  },
  {
    key: "lov-om-boligforhold-2022-342",
    title: "Lov om boligforhold (lov nr. 342 af 22. marts 2022)",
    role: "related_primary",
    historical: false,
    resolution: { method: "direct", year: 2022, number: 342 },
  },

  // ── Historical versions ──────────────────────────────────────────────────────
  {
    key: "lejeloven-2022-341",
    title: "Lov om leje (lov nr. 341 af 22. marts 2022) — reformloven",
    role: "reform_basis",
    historical: true,
    resolution: { method: "direct", year: 2022, number: 341 },
  },
  {
    key: "lejeloven-lbk-2019-927",
    title: "Lejelov — LBK nr. 927 af 4. september 2019 (gammel lejelov)",
    role: "historical_primary",
    historical: true,
    resolution: { method: "direct", year: 2019, number: 927 },
  },
  {
    key: "boligreguleringsloven-lbk-2019-929",
    title: "Boligreguleringslov — LBK nr. 929 af 4. september 2019",
    role: "historical_related",
    historical: true,
    resolution: { method: "direct", year: 2019, number: 929 },
  },
];
