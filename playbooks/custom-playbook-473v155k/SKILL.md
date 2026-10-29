---
name: custom-playbook-473v155k
description: 'Scout new tenders from CanadaBuys (and optionally SAP Ariba), triage
  them against FelixTec''s knowledge base, pull full bid documents for top candidates,
  score fit/win-chance, and recommend pass / fail / human-review with confidence and
  justification. Every tender is named by its CanadaBuys friendly title. Maintains
  one persistent ''Already Processed Tender List'' artifact (fixed identity across
  runs) holding every tender''s verdict plus an admin review_status (auto_pass / auto_fail
  / pending_review / approved / declined / triaged-out) an external app can read and
  update; each run first applies any pending approved/declined rows (approved => push
  that tender''s docs to SharePoint) before scouting new tenders. Preps a Felix CRM-ready
  table and per-tender SharePoint bundles, batch-pushed only in ''push'' CRM mode.
  Use for finding/triaging/recommending new tenders, or applying pending admin decisions.
  Form: start date, max-tenders, filters, sites, triage keep %, QA model, review depth,
  CRM mode.'
---

Felix Tec Tender Scout & Bid Recommender

You find newly-posted tenders from CanadaBuys (and, if asked, SAP Ariba), rule
out the ones already reviewed, triage the rest against FelixTec's own knowledge
base, pull the full bidding documents for the survivors, score each one on fit
and win chance, and recommend a bid decision with a confidence score and a
written justification grounded in the tender's own materials. You never
fabricate a justification, a score, or a document.

Every tender is always identified to a human by its **CanadaBuys friendly
title** (the tender's own display name in the CanadaBuys feed, e.g. "Supply
and Delivery of Accommodation Ladders") — never by its bare tender/event id
alone. The id is still carried everywhere as the join/dedup key, but every
table, artifact and report column meant for a person shows the title first.

## Requirements

- **Felix Dynamics 365 CRM** (`felixtec.crm3.dynamics.com`) — read the CRM's
  **`new_tender` ("Tenders") entity** schema (Step 5, always; **not**
  `new_project`/"Project" and **not** the standard `opportunity` entity —
  both were tried and are wrong: `opportunity` rejects writes with a
  missing-privilege error, and `new_project` is FelixTec's *won-bid delivery
  tracker*, a different object from the tender record itself) and push the
  passed-tenders table into it when CRM operation mode is "push". Declared in
  `connector_requirements`; the form pre-flight-checks it. If it isn't
  connected, tell the user to connect it and stop. Resolve the connector id
  from `list_custom_apis`; never a user-typed id.
- **Microsoft Graph** (`graph.microsoft.com`) — needed whenever any tender's
  documents must reach SharePoint: batch pushes in CRM mode "push", and
  per-tender pushes triggered by an admin's `approved` decision found in the
  status store (Step `process_admin_decisions` — this happens regardless of
  the run's CRM mode, since an explicit admin approval is its own
  push-safety clearance). Not declared as a hard requirement; check it at
  runtime before either kind of push and, if it isn't connected, tell the user
  and fall back to reporting the bundle/pending decision only.
- **SAP Ariba WebLogin** (`service.ariba.com`) — needed only when "Sites to
  search" includes SAP Ariba, to log in and download tender attachments by
  event/tender ID via the `ariba-tender-downloader-v3` skill
  (`use_skill(skill_name="ariba-tender-downloader-v3")`). Check it at runtime
  before Step 3 when SAP is selected, and also before Step
  `process_admin_decisions` if an approved tender's documents need
  re-fetching from Ariba; if missing, tell the user and continue with
  CanadaBuys documents only, noting the gap.
- **CanadaBuys** — a public tender listing, not a Custom API. Fetch it with
  `execute_python` (`requests`) against CanadaBuys' open tender-notice data /
  search pages, or `web_search` for discovery; no connector needed. This is
  also the source of each tender's friendly title.
- **FelixTec knowledge base** — the room's Virtual Memories
  (`list_memories` / `ask_memory` / `knowledge_graph_search`) and any
  FelixTec-related data/embedding/graph pipeline outputs already in the room
  feature-views table (search by name/description, e.g. prior `felix_*`
  tables). This is what tenders are triaged and scored against — never guess
  FelixTec's capabilities from general knowledge when the knowledge base can
  answer it.

## Inputs

- **Start date** — only tenders opened, posted or amended on/after this date.
- **Max number of tenders (optional)** — cap on new tenders to process; blank
  means ALL new tenders found since the start date.
- **Tender filters (plain text)** — a plain-language filter (type, category,
  keywords, value), e.g. `only "Goods" type tenders`.
- **Sites to search** — CanadaBuys always; CanadaBuys + SAP Ariba adds the SAP
  Ariba supplier portal (materials pulled by tender/event ID via
  `ariba-tender-downloader-v3`).
- **Triage keep %** — the top X% of new tenders (by fit against the FelixTec
  knowledge base) that advance to full document review.
- **Adversarial / QA model (optional)** — an extra model or Custom API name
  used to challenge the scoring for accuracy. Blank uses the Corvic default
  judge only.
- **Review depth** — `fast` (single-pass scoring, no adversarial re-check even
  if a QA model was named), `standard` (one adversarial/QA pass over
  borderline and passed tenders), or `thorough` (adversarial QA over every
  scored tender, plus a second independent pass over anything not unanimously
  decided).
- **CRM operation mode** — `dry-run` (build the CRM-ready table and the
  document bundles, push nothing) or `push` (also write to Dynamics 365 CRM and
  upload bundles to SharePoint for this run's `pass`-verdict tenders).

## Verdict rules (Step `analyze_score` — important)

The **method** (two scores, hard-fail gates, history cap, QA) lives in
`felix-tender-deep-scoring`. Step `analyze_score` loads that skill and follows
it. Do not invent a parallel scoring recipe in this Playbook.

Every reviewed tender still gets exactly one verdict, a 0–100 `confidence`
(certainty of the verdict, **not** attractiveness), a separate
`felix_bidding_score` (attractiveness, filled by that skill), and a
justification citing specifics from the tender's own documents and the
FelixTec knowledge-base match:

- **pass** — clear fit against FelixTec's demonstrated capabilities/history,
  eligibility requirements met, no disqualifying condition, confidence over the
  scoring threshold. Recommend bidding. Status-store `review_status` =
  `auto_pass`.
- **fail** — ineligible (wrong category/region/certification), infeasible
  scope/timeline, or a clear capability/history mismatch. Recommend dropping.
  Status-store `review_status` = `auto_fail`.
- **human_review** — borderline confidence, conflicting signals, missing
  information that can't be resolved from the documents, or unusually high
  value/risk. Prefer resolving it yourself (re-reading the documents, a second
  adversarial pass) over reflexively punting — only mark `human_review` when a
  person genuinely must weigh in, and say what they need to decide.
  Status-store `review_status` = `pending_review`, awaiting an admin's
  `approved`/`declined` decision (see below).

## The persistent Tender Review Status store (important)

This is the **single durable record of every tender this Playbook has ever
seen**, across all runs, and it is what an external admin app is meant to read
and write. It lives as **one artifact with one fixed identity** —
`artifact_name = "Already Processed Tender List"` — that every run finds and
updates in place via `write_artifact` with that exact `artifact_name` and its
already-established `run_key`. **Never allocate a new artifact identity for
it and never rename it** — a rename or a fresh `run_key` forks the store in
two, and an admin app pointed at the old identity would stop seeing updates.

Schema (one row per tender, superset of what any single run needs):

- `tender_id`, `tender_title` (CanadaBuys friendly title), `source_site`
- `solicitation_number` — CanadaBuys / Ariba solicitation or reference number. This is the CRM required field `new_solisietionnumber`. Copy it from the listing at fetch time (`referenceNumber` / `solicitationNumber` / equivalent). Never guess it from `tender_title` when the listing field is present. Null only when the source truly had none. The Review Dashboard reads this column from this store — do not drop it on merge.
- `date_first_seen`, `date_last_updated`
- `publication_date` (ISO date/datetime from the notice — CanadaBuys
  `publicationDate-datePublication`), `closing_date` (ISO datetime from the
  notice — CanadaBuys `tenderClosingDate-appelOffresDateCloture`). These are
  the same names the Review Dashboard uses for Published / Closing. **Do not
  store `days_remaining`** — the App computes it live from `closing_date`
  (`date_diff` vs `CURRENT_DATE`). Null when the listing did not carry a date
  (Ariba-only, or a closed notice no longer in the open feed).
- `verdict` (`pass` / `fail` / `human_review`), `confidence` (0–100 integer —
  certainty of the verdict, **not** attractiveness), `felix_bidding_score`
  (0–100 integer, nullable — how attractive the bid is for Felix; filled by
  deep scoring, never copied from `confidence`; leave null until that score
  exists), `justification`, `key_facts`, `fit_rationale`, `admin_note`
  (free-text from the admin App or a person; **never overwrite a non-empty
  existing `admin_note`**)
- `review_status` — `auto_pass` | `auto_fail` | `pending_review` | `approved`
  | `declined` | `triaged-out`. Starts at `auto_pass`/`auto_fail`/`pending_review`
  per the verdict rules above for tenders that reached full scoring. Tenders
  fetched this run that did **not** survive triage (below the keep % cut, or
  dropped as TOO_SOON / EXPIRED / INACTIVE / DUPLICATE_VARIANT) are written with
  `review_status = triaged-out`, `verdict = fail`, `confidence` = the triage
  fit score (0–100), and that same score named in `justification` (the
  reasoning column), e.g. `Triage score 42/100. Reason BELOW_KEEP. Ranked below
  the keep threshold; not sent to full document review. …`. Triaged-out rows use this
  same schema (including `publication_date` / `closing_date`); do not invent
  extra columns for them. **An admin app changes `pending_review`
  rows to `approved` or `declined` directly in this artifact between runs** —
  this Playbook only ever reads that field for `pending_review` rows and
  reacts to a change; it never sets `approved`/`declined` itself, and it never
  treats `triaged-out` as an admin decision.
- `decided_by`, `decided_at` — filled in when `review_status` becomes
  `approved`/`declined` (by the admin app, or by a person via chat override as
  already used once for WS5558902943).
- `crm_pushed`, `sharepoint_pushed` — what has actually been pushed and where
  (record ids / folder path), or `none` / `none (dry-run)`.
- `crm_link`, `sharepoint_link` — the actual clickable URL to that pushed
  record/folder, so a person (or the admin app) can open it directly, or
  `none` / `none (dry-run)` matching the sibling `*_pushed` field. `crm_link`
  is built from the created/updated **`new_tender`** record id:
  `https://felixtec.crm3.dynamics.com/main.aspx?etn=new_tender&id=<record_id>&pagetype=entityrecord`
  (never `etn=new_project` — that entity is FelixTec's separate won-bid
  delivery tracker, not the tender record).
  `sharepoint_link` is the folder's own `webUrl`, resolved via a Microsoft
  Graph `GET /drives/<drive_id>/root:/<url-encoded folder path>` call right
  after the upload (read its `webUrl` field) — never hand-construct the
  SharePoint URL, since the space-vs-`%20` and library-name escaping is easy
  to get wrong and Graph already knows the real one.

"Approve means push docs to SharePoint" is implemented literally: Step
`process_admin_decisions` (below) is what performs that push, driven only by
this field — the admin app itself never needs Graph/SharePoint access, only
read/write on this one artifact table.

## Step: process_admin_decisions — Act on pending admin decisions

Run this **every invocation**, right after Step `load_processed`, before
fetching anything new:

1. From `data.processed_list` (the just-loaded status store), select every row
   where `review_status` is `approved` or `declined` **and** the corresponding
   push/finalization hasn't happened yet (`sharepoint_pushed` still
   `none`/empty for an `approved` row; no action needed for a `declined` row
   beyond leaving it finalized).
2. For each newly `declined` row: nothing to push. It stays excluded from all
   future triage (Step `load_processed`'s dedup already keeps it out) — just
   carry it forward unchanged into this run's merge.
3. For each newly `approved` row: this is the admin's own explicit push
   clearance for that one tender, independent of this run's CRM mode input —
   apply it exactly like the manual chat override already performed once for
   WS5558902943.
   - Check the Microsoft Graph connector; if missing, leave the row
     `sharepoint_pushed = none (Graph not connected)` and note the gap in the
     final report — don't block the rest of the run.
   - Get that tender's documents: if a still-resolvable file table from the
     run that originally fetched them exists in the room (search the room
     feature-views table by tender id in lineage/description), reuse it;
     otherwise re-fetch fresh via the same method Step `fetch_documents` uses
     for that `source_site`.
   - Create (if needed) the SharePoint folder named after the tender's
     **CRM/friendly title** (`tender_title`, e.g. "W355B-270105B Laser
     Geometric Measuring & Bore Alignment System" — never the bare tender id
     like `WS5811557851-Doc5856578974`) under the **"Tender" document library
     on the "MS Dynamics 365" SharePoint site** (see the site/drive and
     folder-naming note under Step `tender_bundles` below — never the root
     Communication site's default "Documents" library, even though a folder
     there is misleadingly named `MSDynamics365`), path
     `<current year> Tenders/<tender_title, sanitized>`, and upload every
     document, same as the batch bundle push in Step `tender_bundles`.
   - Record the outcome (`sharepoint_pushed` = folder path + file count,
     `decided_by`/`decided_at` if not already set).
4. Produce `data.admin_actions_applied` — every row touched this step and what
   happened. This is merged into the status store at Step
   `update_processed_list`, not written separately — the store is written
   once per run.

## CRM / SharePoint push-safety rule (important)

- Read the Felix CRM's tender entity schema before building the CRM-ready
  table (Step `crm_prep`) in **every** run, dry-run included — the table must
  already match the schema.
- Batch path: only write to Dynamics 365 CRM or create/upload to SharePoint
  for this run's tenders when CRM operation mode is **push**, and only for
  `pass`-verdict tenders. In dry-run, show exactly what would be pushed and
  push nothing.
- Per-tender admin-approval path (Step `process_admin_decisions`): pushing a
  tender to SharePoint because its `review_status` is `approved` is allowed
  regardless of this run's CRM mode — the admin's approval **is** the
  required human sign-off that the general rule exists to enforce. This is
  the only exception to "never push a `fail`/`human_review` tender": an
  `approved` former-`human_review` tender is, by that decision, cleared.
  Never push a row whose `review_status` is still `pending_review`,
  `auto_fail`, `declined`, or `triaged-out`.
- Record exactly what was pushed (or would be pushed) — tender ids, titles,
  CRM record ids if created (plus the `crm_link` built from that id),
  SharePoint folder path and file counts (plus the `sharepoint_link` resolved
  from Graph after upload).

## Automation note

Designed to run on a recurring schedule (e.g. "every Monday, tenders since last
run") as well as on demand. Because it is scheduled, the Tender Review Status
store is a **persistent artifact across runs, not a per-run table** — see
Steps `load_processed` and `process_admin_decisions` below for how to find,
act on, and update it.

## How this Playbook runs (staged execution)

This Playbook is **staged**: each plan step below owns a section you load *just
in time*. For every stage: (1) call
`use_skill(skill_name="custom-playbook-473v155k", step_id="<id>")`; (2) call
`report_playbook_progress(step_id="<id>", status="started")`; (3) when its
outputs exist, call `report_playbook_progress(step_id="<id>", status="done")`
(once per stage; use `status="failed"` with a short, user-safe note if it
cannot complete).

Stages: `load_processed → process_admin_decisions → fetch_tenders → triage →
fetch_documents → analyze_score → crm_prep → tender_bundles →
update_processed_list → final_report`. `process_admin_decisions` and
`fetch_tenders` both depend only on `load_processed` and may run in parallel.
`crm_prep` and `tender_bundles` both depend only on `analyze_score` and may
run in parallel; `update_processed_list` waits for `crm_prep`,
`tender_bundles`, and `process_admin_decisions`.

## Completeness contract (self-verify before finishing)

Confirm each `required_output` exists; never drop one silently:
`data.admin_actions_applied` (pending approve/decline rows acted on),
`data.new_tenders` (fetched high-level tender list, already-processed
excluded, each carrying its CanadaBuys friendly title), `data.triage_all`
(every fetched notice with listing fit and reason code), `data.triage_candidates`
(kept after listing-triage hard filters and keep %), `data.triaged_out`
(not kept — below keep %, TOO_SOON, EXPIRED, INACTIVE, DUPLICATE_VARIANT —
with triage fit score), `data.scored_tenders` (every candidate with title +
verdict + confidence + `felix_bidding_score` + justification), `data.crm_ready` (CRM-schema-shaped
table of this run's passed tenders), `artifact.tender_bundles` (per-passed-tender
document bundle), `data.processed_list_updated` (the one persistent status
store, same identity, updated with **every tender in `data.new_tenders` this
run** — scored survivors **and** `triaged-out` rows — **and** every admin
decision applied this run), `artifact.report` (final report +
passed/failed/review tables + pending-review/admin-action summary).

## Step: load_processed — Load the Tender Review Status store

This store must persist **across separate runs** of this Playbook, so it is not
a fresh table each time — it is a durable artifact you find and update in
place:

1. Check for a `Scheduler context` block (a scheduled firing) naming a prior
   run's history feature view; if present, query it
   (`SELECT history FROM "<ledger_id>:history" WHERE history LIKE
   '%allocate_artifact%'`) for a previous `allocate_artifact`/`write_artifact`
   call named `Already Processed Tender List` and read off its exact
   `run_key`.
2. Otherwise, search the room feature-views table for an existing artifact
   named `Already Processed Tender List` (trait `sys/artifact`) from an earlier
   run in this room/thread lineage, and `preview_feature_view` it to confirm
   its shape and recover its `run_key` context.
3. If found, `preview_feature_view` its full contents — this is
   `data.processed_list`, now the full status-store schema (tender id, title,
   source site, verdict, confidence, justification, `review_status`,
   `crm_pushed`, `sharepoint_pushed`, decided_by/at). A store written before
   this schema existed will be missing the newer columns — treat those as
   `auto_pass`/`auto_fail` (from its old `verdict`) or blank, never as
   `pending_review` by default.
4. If genuinely not found anywhere (first-ever run), treat the list as empty
   and note this is the first run; you will `allocate_artifact` it fresh in
   Step `update_processed_list` and every tender fetched this run is "new" by
   definition, and there are no admin decisions to apply yet.

Never invent a `run_key` when history shows one already exists — that forks
the store into two and Step `fetch_tenders`' dedup silently breaks, and an
admin app pointed at the old identity stops seeing updates.

If a loaded store is missing `publication_date`, `closing_date`,
`felix_bidding_score`, `admin_note`, or `solicitation_number`, add those
columns as null on the existing identity — never fork a new artifact to
widen the schema. When `solicitation_number` is blank on an existing row
and this run has the listing/verdict value for that `tender_id`, fill it
(do not overwrite a non-empty value).

## Step: fetch_tenders — Fetch new tender listings

Fetch tenders opened/posted/amended on or after the start date from CanadaBuys
(`execute_python` + `requests` against CanadaBuys' tender notice search/API, or
`web_search` to locate the current endpoint/listing pages), and from SAP Ariba
too if "Sites to search" includes it (list/search mode of
`ariba-tender-downloader-v3`, not the by-ID download yet). Apply the plain-text
tender filters and the max-tenders cap (blank = no cap). Drop any tender whose
id already appears in `data.processed_list` from Step `load_processed` — do not
re-fetch or re-score it. For every surviving tender collect, without yet
loading its documents: **the CanadaBuys friendly title (`tender_title`) —
required, and the field every later step and table displays first**, plus
category/commodity type, organization, **`solicitation_number` under that exact
column name** (CanadaBuys `referenceNumber` / solicitation number — this is the
CRM required field; do not omit it even when the friendly title has no number),
**`publication_date` and `closing_date`
under those exact column names** (CanadaBuys `publicationDate-datePublication`
and `tenderClosingDate-appelOffresDateCloture`; keep the source ISO string),
amendment date(s), a summarized description, stated conditions/eligibility requirements,
expected duration/value, and its source site + tender/event id. Produce
`data.new_tenders`.

## Step: triage — Triage against the FelixTec knowledge base

**Nested skill (required).** Load and follow
`use_skill(skill_name="felix-tender-listing-triage")` before ranking or
dropping any notice. That skill owns listing-only method: hard filters
(EXPIRED, INACTIVE, TOO_SOON, DUPLICATE_VARIANT), listing fit 0–100 on every
row, keep % on the **eligible** pool only, and the three output tables. Do not
inline a different ranking. Do not download documents in this stage.

Pass it `data.new_tenders` and the form's **Triage keep %** (default 20).
100% keep still drops hard-filtered rows. A missing `closing_date` stays
eligible (`UNKNOWN_CLOSING`) — do not guess a close date.

Produce `data.triage_all` (every fetched notice with reason code),
`data.triage_candidates` (kept), and `data.triaged_out` (everything not kept,
including TOO_SOON / EXPIRED / INACTIVE / DUPLICATE_VARIANT / BELOW_KEEP).
Keep `tender_title`, `publication_date`, and `closing_date` on every row. If
keep % is 100% and nothing hard-filters, `data.triaged_out` may be empty.

## Step: fetch_documents — Pull full tender documents & amendments

For every tender in `data.triage_candidates`, fetch its complete set of
bidding documents and amendments and land them in a file table
(`{path, content, mime_type}`, one row per document, tagged with tender id,
tender title, and source site):

- **CanadaBuys tenders** — download every listed attachment/amendment via
  `execute_python` + `requests` from the tender's detail page.
- **SAP Ariba tenders / tenders with an SAP bidding project** — when "Sites to
  search" includes SAP Ariba and the tender has a known Ariba event/tender id,
  use `use_skill(skill_name="ariba-tender-downloader-v3")` direct-by-ID path to
  download the attachment ZIP, then unpack it into the same file table
  (read-only retrieval only — never submit or fill a bid form, per that
  skill's safety contract).

If a tender's documents can't be retrieved, record why against that tender
rather than silently dropping it. Produce `data.tender_documents`.

## Step: analyze_score — Digitize, analyze & score

**Nested skill (required).** Load and follow
`use_skill(skill_name="felix-tender-deep-scoring")`. That skill owns
digitize-and-verdict method: two independent scores (`confidence` vs
`felix_bidding_score`), hard-fail gates, history as a 10-point signal not the
foundation, admin notes as input (never overwrite), and review-depth QA. Do
not inline a different verdict recipe.

Pass it `data.triage_candidates`, `data.tender_documents`, **Review depth**
(missing → `fast`), Felix memories / CRM history, and any `admin_note` already
on those `tender_id`s in the store. The skill itself loads
`use_skill(skill_name="pdf-processing")` before scoring PDFs — that nested
call is required, not optional.

Produce `data.scored_tenders` with **one row per candidate** (never drop for
missing docs): `tender_id`, `tender_title`, `solicitation_number`, `source_site`, `publication_date`,
`closing_date`, `verdict`, `confidence`, `felix_bidding_score`, `justification`,
`key_facts`, `fit_rationale`, `review_status`, `docs_available`, `qa_note`.
Copy `solicitation_number` from `data.new_tenders` for that `tender_id`.
Never `pass` without a substantive solicitation document. Never copy
`confidence` onto `felix_bidding_score`. Never write `admin_note`.

## Step: crm_prep — Build the Felix CRM-ready tenders table

FelixTec's tender record lives in a **dedicated custom entity, `new_tender`**
(display name "Tender", entity set `new_tenders`, primary key
`new_tenderid`, primary name field `new_name`) — found by searching
`EntityDefinitions` for logical names containing `tender` (`contains()` isn't
supported on that endpoint; list all entities and filter client-side). This is
**not** the standard `opportunity` entity (write rejected with a
`prvWriteOpportunity` privilege error) and **not** `new_project` (that is
FelixTec's separate *won-bid delivery/execution tracker* — a project only
exists once a tender is won; creating a `new_project` row for a freshly-passed
tender is the wrong object and has to be corrected by hand if it happens).
Always read the live schema via **Felix Dynamics 365 CRM** Custom API
(`execute_python`, credentials injected — never hardcoded) rather than
assuming field names, but the confirmed mapping from the CRM web UI's tender
form to the `new_tender` API fields is:

| Web UI label | API logical name | Type | Notes |
|---|---|---|---|
| Solicitation Name | `new_name` | String (primary name) | = `tender_title` |
| Solicitation Number | `new_solisietionnumber` | String | = `solicitation_number` from the listing/store (required CRM field; note the field's own spelling). Never leave blank when `solicitation_number` is known. Never guess from `tender_title` if that column is present. |
| Issue Date | `new_issuedate` | DateTime | date-only (`YYYY-MM-DD`), no time component |
| Closing Date & Time | `new_closingdatetime` | DateTime | full timestamp; combine with Time Zone below |
| Time Zone | `new_timezone` | Picklist | resolve the option value from `.../Attributes(LogicalName='new_timezone')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$expand=OptionSet` — never hardcode a value without re-checking, but at last check EST/EDT = 7/8 |
| Tender URL | `new_tenderurl` | String | the CanadaBuys (or Ariba) tender notice URL |
| Organization | `new_organization` | Picklist | FelixTec's own bidding org (e.g. "Felix Technology Inc"), resolved the same way as Time Zone — not the government contracting entity |
| Tender Origin | `new_tenderorigin` | Picklist | country/region of origin, e.g. "Canada" — resolve the option value live |
| Client | `new_client` (bind as `new_Client@odata.bind`) | Lookup → `account` | the government end-user/contracting entity (e.g. "Department of National Defence Canada (DND)", "Canadian Coast Guard (CCG)"); search `accounts` by name (`contains(name, '<keyword>')`) for the best match, and if none exists don't invent one — leave unset and note the gap |
| SharePoint URL | `new_sharepointurl` | String | the folder's resolved `webUrl` (same value as `sharepoint_link`) |

Write via `POST .../new_tenders` with the lookup as an `@odata.bind` (e.g.
`"new_Client@odata.bind": "/accounts(<account_id>)"` — the navigation
property name `new_Client`, found via `.../new_tender)/ManyToOneRelationships`,
not the raw attribute name `new_client`, is what OData needs for the bind).
Shape this run's `pass`-verdict tenders from `data.scored_tenders` into a
table matching this schema. This runs in every mode, dry-run included.

**Check-before-create — never create a duplicate `new_tender` record
(important, learned the hard way: two duplicate records were once created
for the same tender by a retried push and had to be hard-deleted).** Before
writing *any* row in push mode, query for an existing record for that tender
first — `GET .../new_tenders?$filter=new_solisietionnumber eq
'<solicitation number>'` (fall back to `new_name eq '<tender_title>'` if the
solicitation number is blank/unreliable for that tender) — and branch on the
result:
- **No match** → `POST .../new_tenders` to create it.
- **Exactly one match** → `PATCH .../new_tenders(<that new_tenderid>)` to
  update it instead of creating a second one (this is also what makes a
  re-run or a retried push idempotent — the same tender pushed twice ends up
  as one record, not two).
- **More than one match** → this is the duplicate state itself; do not create
  a third. Keep the earliest-`createdon` record as canonical, `PATCH` it with
  the current field values, and report the extra duplicate id(s) in the final
  report for the user to confirm before deleting (hard-delete via `DELETE
  .../new_tenders(<id>)` if the user confirms and the API accepts it, since
  writable-entity records can be hard-deleted here unlike `opportunity`).

If CRM operation mode is **push**, resolve as above (create or update) and
record the resulting `new_tenderid`; if **dry-run**, do not write anything —
not even the duplicate-check read is required — and show the shaped table as
what would be pushed. Never include `fail`/`human_review` tenders (an
admin-`approved` tender is pushed to SharePoint by Step
`process_admin_decisions`, not routed through this CRM batch path — and that
step's SharePoint-only push never touches `new_tender` records, so it has no
duplicate-creation risk of its own). Produce `data.crm_ready` and
`delivery.crm_pushed` (the pushed `new_tenderid`s plus each one's `crm_link`,
or `none` / `none (dry-run)`).

## Step: tender_bundles — Build per-tender document bundles

For every `pass`-verdict tender from this run, assemble a bundle of all of its
downloaded documents from `data.tender_documents` (one folder-shaped group per
tender, labelled by tender title). Publish the full set as a durable artifact
(`allocate_artifact` once, keyed to this Playbook's stable identity, then
`write_artifact`) so the bundles survive the run.

**SharePoint site/drive — read this before ever calling Graph (important,
learned the hard way):** FelixTec's tender documents belong on the
**"MS Dynamics 365" SharePoint site** (`https://felixtecca.sharepoint.com/sites/MSDynamics365`,
Graph site id `felixtecca.sharepoint.com,6c941507-17c9-4db9-aab8-28f8f9ce8ee9,034bc11d-7ac8-4d1f-aeac-3ef01f9ccf4e`),
in its own dedicated **"Tender" document library** — the drive whose `name`
is `Tender` and whose `webUrl` is
`https://felixtecca.sharepoint.com/sites/MSDynamics365/new_tender` when you
list `GET /sites/<site_id>/drives`. That library already holds `2025 Tenders`
and `2026 Tenders` folders from other CRM-driven uploads — upload into
`<year> Tenders/<tender_id>` there. **This is not the same thing as the root
"Communication site"'s default "Documents" library**
(`https://felixtecca.sharepoint.com/Shared Documents`, reached via
`GET /sites/felixtecca.sharepoint.com` with no `/sites/...` path) — that
root site can itself contain a folder literally *named* `MSDynamics365`,
which looks right by name alone but is the wrong site entirely (this mistake
was made once, on 2026-08-28/29, and had to be corrected: files copied to the
correct "Tender" library, wrong copies deleted, CRM `new_sharepointurl`
values re-patched). Always resolve the drive id by listing
`GET /sites/<MS Dynamics 365 site id>/drives` and matching `name == "Tender"`
rather than reusing a cached/hardcoded drive id, in case it ever changes —
but never fall back to the root site's default drive.

**Folder naming — the CRM/friendly title, never the tender id (important):**
name every SharePoint folder after the tender's **CRM/friendly title**
(`tender_title`, the same value written to `new_name` in Step `crm_prep`),
not its bare tender id (`WS5811557851-Doc5856578974`-style ids are the
internal join key, never a folder name a person should see). Sanitize the
title for SharePoint's illegal path characters (`\ / : * ? " < > | # %`) and
trim trailing spaces/periods, but keep it otherwise readable. Dynamics 365
itself **auto-creates an empty folder named after `new_name`** the moment a
`new_tender` record is created (its own document-management convention) —
so when CRM operation mode is push and Step `crm_prep` has already created
that tender's `new_tender` record, **check for and reuse that
already-existing same-named folder** (`GET /root:/<year> Tenders/<title>`)
rather than creating a second one; only create a new folder by that name
when none exists yet (e.g. crm_prep hasn't run/finished, or CRM push wasn't
done for this tender). If a stray tender-id-named folder is ever found for a
tender that also has a title-named folder, move its contents into the
title-named one and remove the id-named duplicate — never leave two folders
for the same tender.

If CRM operation mode is **push**, create (or reuse, per the note just above)
a folder named after the tender's CRM/friendly title under that **"Tender"
library's** `<current year> Tenders` path via the **Microsoft Graph** Custom
API and upload that tender's documents into it (check the connector first; if
missing, report the gap and continue with the artifact bundle only), then
resolve each folder's own `webUrl` via a Graph
`GET /drives/<tender_library_drive_id>/root:/<path>` call right after upload
and record it as `sharepoint_link`. In dry-run, only build and report the
bundle — never touch SharePoint, and leave `sharepoint_link`
`none (dry-run)`. This is the batch path for this run's fresh `pass` tenders
only; it does not touch `human_review`/`pending_review` tenders — those are
Step `process_admin_decisions`'s job once an admin approves them. Produce
`artifact.tender_bundles` and `delivery.sharepoint_pushed` (folder paths, file
counts, and each folder's `sharepoint_link`, or `none (dry-run)`).

## Step: update_processed_list — Record everything back to the status store

Merge four things into the one persistent Tender Review Status store:
(1) `data.processed_list` from Step `load_processed` (everything already
there), (2) `data.admin_actions_applied` from Step `process_admin_decisions`
(this run's approve/decline outcomes), (3) every tender in
`data.scored_tenders` from this run (regardless of verdict), each with its
initial `review_status`, `crm_pushed`/`sharepoint_pushed` and their matching
`crm_link`/`sharepoint_link` from Steps `crm_prep`/`tender_bundles`, and
(4) every tender in `data.triaged_out` (and any other `data.new_tenders` id
not already in (1) or (3) — **every fetched tender must land in the store**).
For (4) use the same store schema: set `review_status = triaged-out`,
`verdict = fail`, `confidence` = the triage fit score (0–100 integer),
`justification` = a reasoning string that **includes that score and the
listing-triage reason code** (e.g. `Triage score 42/100. Reason BELOW_KEEP.
Ranked below the keep threshold; not sent to full document review.
{fit_rationale}`), `fit_rationale` from triage,
`publication_date`/`closing_date` copied from `data.new_tenders` (null if
missing), `felix_bidding_score` = null, `admin_note` = null,
`crm_pushed`/`sharepoint_pushed`/`crm_link`/`sharepoint_link` = `none`,
`date_first_seen`/`date_last_updated` = this run's date. For (3) copy
`publication_date`/`closing_date` and `solicitation_number` from `data.new_tenders` and
`felix_bidding_score` from `data.scored_tenders` when present (else null).
For (4) also copy `solicitation_number` from `data.new_tenders` (null only if
the listing had none). Never overwrite an existing store row for the same `tender_id`,
except: fill a blank `solicitation_number` when this run has the listing value.
Never overwrite a non-empty `admin_note`. Never replace a filled
`publication_date`/`closing_date`/`solicitation_number` with null. The Review
Dashboard selects `p.solicitation_number` from this store — every new row must
carry the column. Publish it back to the **same**
artifact identity found (or newly allocated only on a genuine first run) in
Step `load_processed` (`write_artifact` with that exact
`run_key`/`artifact_name`, never a new one) so the next run's Step
`load_processed` — and any admin app — see it, and Step `fetch_tenders` will
skip these ids. Produce `data.processed_list_updated`.

## Step: final_report — Deliver the final report

Run the completeness self-check first. Build the final report (Markdown or
HTML) naming: which admin decisions (approved/declined) were applied this run
and what was pushed as a result, how many new tenders were found, how many
survived triage, how many were recorded as `triaged-out` (with their triage
scores), the full passed / failed / human_review tables (tender title,
verdict, confidence, `felix_bidding_score`, justification), how many tenders are now sitting in
`pending_review` awaiting an admin decision, what was pushed to CRM and
SharePoint this run (or would be, in dry-run) **with the actual `crm_link` and
`sharepoint_link` for each pushed tender** so a reader can open the record/
folder directly, and links to the downloaded-document bundles. Publish it as an artifact (`allocate_artifact` →
build the table → `write_artifact`). Produce `artifact.report`.
