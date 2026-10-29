# CRM push correctness contract

## Incident: TMN, October 27, 2026
The approval sender used a CanadaBuys HTML scrape as the sole source of issue date, closing date and notice URL, even when the processed store already held dates. A failed scrape yielded an empty payload subset. A 2xx PATCH was treated as completion without reading Dynamics back. The dashboard subsequently inferred CRM values from local data, which was incorrect.

A direct Dynamics GET confirmed that TMN had name, solicitation number, organization and tender origin, but no issue date, closing date, timezone or URL. Source-page HTTP requests returned 403. The officially indexed TMN notice states November 13, 2026 at 23:59 EST. Dynamics option metadata identifies EST as option 7 and EDT as option 8; blindly setting 8 is incorrect.

## Acceptance criteria for the sender repair
- Prefer collected authoritative data; HTML is enrichment, not the sole dependency.
- Preserve the source deadline clock and its verified offset. Never interpret an arbitrary timezone-naive timestamp as UTC.
- Use verified Dynamics option metadata rather than a fixed daylight-time option.
- Required CRM fields: name, solicitation number, issue date, closing datetime, timezone, tender URL, organization, tender origin.
- Preserve populated CRM values when no authoritative replacement is available; never overwrite them with blanks.
- A lookup error must not be interpreted as an absent record and must not trigger a duplicate create.
- Read Dynamics after each write and compare intended values with returned values. A 2xx write alone is not verified completion.
- Record unresolved source fields and read-back mismatches explicitly; keep those tenders retryable rather than silently reporting success.
- Reconcile historic incomplete approved records without another reviewer approval; a newer rejection takes precedence over an older approval.
- Treat SharePoint independently. Missing source documents or failed uploads are not successful document delivery and must not block CRM persistence.
- Keep reviewer comments and existing record links on failures.

## Scope
These are sender acceptance criteria, not a claim that deployment or live backfill has finished. The chat's verification report records the actual deployment and remaining blockers. This contract must accompany subsequent sender changes; dashboard colors are not evidence of CRM contents.
