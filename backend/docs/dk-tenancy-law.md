# Danish Tenancy Law — Legal Set (`dk-tenancy-law`)

## Overview

This legal set indexes 8 laws that together cover Danish tenancy law: the current
laws in force plus historical versions that are necessary for legal analysis
(e.g. understanding what the 2022 reform changed).

All laws are stored in the existing `law_chunks` table using stable, versioned
`law_id`s. Historical laws never overwrite current laws.

## Running the sync

```bash
npm run sync:tenancy-laws --prefix backend
```

The script is safe to re-run. Chunks that haven't changed (same `effective_date`)
are skipped. If any law fails to import, the script exits with code 1 and prints
a summary.

## Laws included

| `law_id` | Title | Role | Historical |
|---|---|---|---|
| `lejeloven` | Lejeloven (gældende) | `current_primary` | No — auto-resolves to latest |
| `erhvervslejeloven` | Erhvervslejeloven (gældende) | `commercial_tenancy` | No — auto-resolves to latest |
| `almenlejeloven` | Almenlejeloven (gældende) | `public_housing` | No — auto-resolves to latest |
| `almenboligloven` | Almenboligloven (gældende) | `public_housing` | No — auto-resolves to latest |
| `lov-om-boligforhold-2022-342` | Lov om boligforhold (nr. 342/2022) | `related_primary` | No — pinned to 2022/342 |
| `lejeloven-2022-341` | Lov om leje — reformloven (nr. 341/2022) | `reform_basis` | **Yes** — pinned to 2022/341 |
| `lejeloven-lbk-2019-927` | Gammel lejelov — LBK nr. 927/2019 | `historical_primary` | **Yes** — pinned to 2019/927 |
| `boligreguleringsloven-lbk-2019-929` | Gammel boligreguleringslov — LBK nr. 929/2019 | `historical_related` | **Yes** — pinned to 2019/929 |

## How historical laws are kept separate

Chunk IDs are prefixed with the `law_id`:

```
dk_lejeloven_p7_s1              ← current lejeloven
dk_lejeloven-2022-341_p7_s1     ← reform act (pinned)
dk_lejeloven-lbk-2019-927_p7_s1 ← old lejelov (pinned)
```

Because the IDs are different, `upsertChunks` treats them as completely
separate rows. Syncing the current lejeloven will never touch historical chunks,
and vice versa.

## Note on lejeloven consolidation

As of May 2026, there is no consolidated LBK for the new lejeloven.
The 2022 reform act (2022/341) is itself the current law and is what
`resolve?q=lejeloven` returns.

This means `lejeloven` and `lejeloven-2022-341` currently index the same
source document under two different `law_id`s. This is intentional:

- `lejeloven` will automatically follow any future LBK consolidation.
- `lejeloven-2022-341` remains permanently pinned to the reform act.

The sync script logs a warning when this duplication is detected.

## Retrieval

No changes to retrieval logic are needed. The existing FTS and vector search
in `lawRetrieval.ts` will find chunks from all 8 laws automatically, since
they are stored in the same `law_chunks` table with `is_current = true`.

## What this MVP does NOT include

- `law_relations` or `legal_sets` database tables
- Provision-level cross-references between old and new law
- Paragraph matching / diff between versions
- Frontend changes — historical law citations look the same as current ones
- Retrieval routing — the model receives results from all matching laws
- Legislative history or case law linking
