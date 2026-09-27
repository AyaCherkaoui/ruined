# Hosted patient demo

The HeadsUp project `aubtnsvksswxpghmamuu` was seeded with **136 synthetic patients, 136 patient alerts, 7 plan/drug coverage checks, 5 formulary changes, and 2 verified CMS releases**. Seven product-level coverage alerts replace the two simulated Humana placeholders. The four demo plans belong to Wellcare and CareSource. Patient identities, enrollment, prescriptions, and staged review statuses are synthetic; insurer names and coverage facts come from CMS.

With the existing Supabase URL and publishable key configured, the dashboard, patient search, reviews, dismissals, resets, policy replay, notification preview, and notification receipts use Supabase. No database password or service-role key is needed. `PATIENT_DATA_SOURCE=local` explicitly restores the original DuckDB workflow. Deploy/rebuild this code on the application host to activate the adapter there; uploading the database does not deploy Next.js.

## Source verification

The existing `download_spuf.py --dry-run` and `download_puf_monthly.py --dry-run` scraper commands confirmed both archives against the live official CMS catalog. `verify-hosted-sources.py` additionally computed each complete archive's SHA-256 and compared all four plan mappings and 26 drug/formulary combinations with the raw source files, including the covered alternatives and missing prescribed products.

| Release | SHA-256 |
| --- | --- |
| Q2 2026 SPUF, published July | `8f67d561cff080cabff1d95d885f68d7b1dc3e64b1c5829be77aa51e1eb0ca14` |
| September 2026 monthly PUF | `51d0d4177f00458ef420da1491f91f2e4f0a17dc11c253232a9bcc06572d21f2` |

Full source URLs, verification times, plan metadata, and matching raw formulary rows are retained in `demo_source_releases`. These are historical snapshot comparisons, not a new live insurer update. The exact effective date is unknown and stored as null. September CMS files do not include prices, so the original engine's estimates reuse Q2 pricing; they are not live quotes. The hosted coverage checker supports the seven exported plan/drug combinations; it returns a clear 404 outside that verified dataset instead of fabricating a result. New drug searches or insurer releases need a new verified export.

## Reproduce the seed

Use the existing populated local demo and extracted CMS archives. Stop local writes before copying the database for export. Commands:

```powershell
npx tsx scripts/export-hosted-demo.ts
python scripts/verify-hosted-sources.py
npx tsx scripts/prepare-hosted-seed.ts
```

The exporter works on a temporary read-only copy and requires exactly the original 136 synthetic panel identities. The verifier uses the official CMS catalog and raw source files. The final command creates `data/raw/hosted-demo/seed.sql`, a single transaction. Apply the two `hosted_patient_demo` / `hosted_demo_dismiss_review` migrations first, then run the seed through the Supabase SQL Editor or MCP SQL tool. Generated evidence and seed files are ignored by Git.

Seed IDs are stable, and rerunning the seed upserts fixtures without overwriting existing doctors' review choices or messaging receipts. Existing local choices and notification receipts are imported only for the original `doctor@test.com` demo account, preserving send deduplication. Only the two known `is_demo=true` Humana placeholders are retired. The hosted dataset contains the active panel; the five archived NovoLog patients stay local.

## Access and checks

Authenticated doctors can read the shared synthetic fixtures. They cannot alter CMS evidence or patients. Review choices and messaging receipts are restricted by `auth.uid()`; selection is validated against the patient's verified alternatives in both application code and a database trigger. The selection, dismissal, reset, and notification reservation functions run with caller permissions. Anonymous users have no table or mutation access.

`supabase/verify-hosted-demo.sql` tests selection persistence, invalid-choice rejection, dismissal preserving selection, reset, duplicate receipt reservation, cross-user isolation, and anonymous grants. Its changes roll back. Run `npx vitest run lib/hostedDemo.test.ts` to verify hosted dashboard routing without DuckDB. Notification verification uses previews/mocked transport and never sends a real message.
