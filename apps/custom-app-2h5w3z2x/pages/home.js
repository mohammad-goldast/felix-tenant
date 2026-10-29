// Felix Tec Tender Scout — Review Dashboard
// Reads the playbook's persistent "Already Processed Tender List" live, plus a
// reviewer-decisions log this app writes to. Approve/Reject write a decision
// event (status: pending) and return immediately. Felix Tender Approval Push
// picks those up on its schedule and writes them to Felix CRM and SharePoint.
// Reload only re-reads this list; it does not send anything to Felix.

import {
  summarizePush,
  pushDotClass,
  crmHoverTitle,
  spHoverTitle,
  hoverCardHtml,
  renderPushPopup,
} from "../lib/push-summary.js";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function infoLink(tenderId, sourceSite) {
  const id = String(tenderId || "");
  if (!id) return null;
  if (id.toLowerCase().startsWith("ariba-")) {
    const eventId = id.slice(6);
    return `https://portal.us.bn.cloud.ariba.com/dashboard/public/appext/comsapsbncdiscoveryui#/RfxEvent/preview/${encodeURIComponent(eventId)}?anId=ANONYMOUS`;
  }
  // CanadaBuys fronts both its own notices (cb-...) and SAP Ariba-sourced
  // notices (WS...-Doc...) under the same tender-notice path, lowercased.
  return `https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/${encodeURIComponent(id.toLowerCase())}`;
}

function sourceLabel(s) {
  const v = String(s || "");
  if (v === "sap_ariba") return "SAP Ariba";
  if (v === "canadabuys") return "CanadaBuys";
  return v || "—";
}

// Store scores are 0–100 integers (a 0–1 fraction is tolerated).
// felix_bidding_score = how well the tender fits Felix.
// confidence = how sure the scout is of its pass / fail / review verdict —
// not attractiveness. Do not colour certainty as a "good bid" bar.
function scoreNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n * 100 : n;
}

function formatScore(v) {
  const n = scoreNumber(v);
  if (n === null) return "—";
  return String(Math.round(n));
}

function scoreTone(v) {
  const n = scoreNumber(v);
  if (n === null) return "";
  if (n >= 70) return "high";
  if (n >= 40) return "mid";
  return "low";
}

function formatDay(v) {
  if (v === null || v === undefined || v === "") return "—";
  const s = String(v);
  const iso = s.length >= 10 ? s.slice(0, 10) : s;
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-CA", { day: "numeric", month: "short", year: "numeric" });
}

function remainDays(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function remainLabel(v) {
  const n = remainDays(v);
  if (n === null) return null;
  if (n > 1) return `${n} days left`;
  if (n === 1) return "1 day left";
  if (n === 0) return "closes today";
  if (n === -1) return "closed yesterday";
  return `closed ${Math.abs(n)} days ago`;
}

function remainTone(v) {
  const n = remainDays(v);
  if (n === null) return "";
  if (n <= 0) return "due";
  if (n <= 7) return "soon";
  return "ok";
}

// Status kinds from review_status + verdict:
//   approved / auto_approved  — green; belong in CRM/SharePoint
//   declined                 — red (human decision); not in CRM/SharePoint
//   auto_declined            — red (machine reject after review); not in CRM/SharePoint
//   screened_out             — red (triage fail); comment only
//   review                   — orange; waiting on a human
function statusKind(row) {
  const verdict = String(row.verdict || "");
  const s = String(row.eff_review_status || row.review_status || "");
  if (s === "approved") return "approved";
  if (s === "declined") return "declined";
  if (s === "pending_review" || (verdict === "human_review" && s !== "approved" && s !== "declined")) {
    return "review";
  }
  if (s === "auto_pass" || (verdict === "pass" && s !== "declined" && s !== "approved")) return "auto_approved";
  if (s === "triaged-out") return "screened_out";
  if (s === "auto_fail") return "auto_declined";
  if (verdict === "fail") return "screened_out";
  if (verdict === "pass") return "auto_approved";
  return "review";
}

function statusInfo(row) {
  const kind = statusKind(row);
  const pushState = row.latest_push_status; // 'pending' | 'done' | 'failed' | null
  if (kind === "approved") {
    if (pushState === "pending") return { label: "Approved — sending…", cls: "pending" };
    if (pushState === "failed") return { label: "Approved — send failed", cls: "failed" };
    return { label: "Approved", cls: "approved" };
  }
  if (kind === "declined") {
    if (pushState === "pending") return { label: "Declined — updating Felix…", cls: "pending" };
    if (pushState === "failed") return { label: "Declined — send failed", cls: "failed" };
    return { label: "Declined", cls: "declined" };
  }
  if (kind === "auto_approved") return { label: "Auto-Approved", cls: "approved" };
  if (kind === "auto_declined") return { label: "Auto-Declined", cls: "fail" };
  if (kind === "screened_out") return { label: "Screened Out", cls: "fail" };
  if (kind === "review") return { label: "Review", cls: "review" };
  return { label: kind || "Unknown", cls: "review" };
}

function isInCrmBucket(row) {
  const k = statusKind(row);
  return k === "approved" || k === "auto_approved";
}

function needsReview(row) {
  return statusKind(row) === "review";
}

function hasCrmOrSp(row) {
  const crm = row.eff_crm_link && row.eff_crm_link !== "none";
  const sp = row.eff_sharepoint_link && row.eff_sharepoint_link !== "none";
  return Boolean(crm || sp);
}

function willRemoveOnReject(row) {
  return hasCrmOrSp(row) || isInCrmBucket(row);
}

function parseAdminNote(note) {
  const n = String(note || "").trim();
  if (!n) return "";
  const m = n.match(/^ADMIN:\s*([\s\S]*?)(?:\s*\|\s*(?:CRM:|Documents:|SharePoint:|declined)|$)/);
  if (m) return m[1].trim();
  if (/^(CRM:|declined;|tender_id not found|unknown action)/i.test(n)) return "";
  return n;
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "review", label: "Review" },
  { key: "auto_approved", label: "Auto-Approved" },
  { key: "approved", label: "Approved" },
  { key: "auto_declined", label: "Auto-Declined" },
  { key: "declined", label: "Declined" },
  { key: "screened_out", label: "Screened Out" },
];

const SORTABLE = [
  { col: "tender_title", label: "Name", defaultDir: 1 },
  { col: "date_last_updated", label: "Last Updated", defaultDir: -1 },
  { col: "publication_date", label: "Published", defaultDir: -1 },
  { col: "days_remaining", label: "Closing", defaultDir: 1 },
  { col: "felix_bidding_score", label: "Felix score", defaultDir: -1 },
  { col: "confidence", label: "Verdict certainty", defaultDir: -1 },
];

const PAGE_SIZES = [25, 50, 100];

const AUTH_USER = "felix-admin";
const AUTH_PASS = "GFelix26";
const AUTH_KEY = "fts-review-auth";

function isSignedIn() {
  try { return sessionStorage.getItem(AUTH_KEY) === "ok"; } catch { return false; }
}
function rememberSignIn() {
  try { sessionStorage.setItem(AUTH_KEY, "ok"); } catch { /* private mode */ }
}
function forgetSignIn() {
  try { sessionStorage.removeItem(AUTH_KEY); } catch { /* private mode */ }
}

function showLogin(ctx) {
  return new Promise((resolve) => {
    // No <form>: the app iframe is sandboxed without allow-forms, so a
    // native submit is blocked ("Blocked form submission to ''").
    ctx.content.innerHTML = `
<div id="login-gate">
  <div class="login-card" id="login-card">
    <h1>Felix Tec Tender Scout</h1>
    <p class="login-sub">Sign in to open the review dashboard.</p>
    <label for="login-user">Username</label>
    <input id="login-user" name="username" type="text" autocomplete="username" />
    <label for="login-pass">Password</label>
    <input id="login-pass" name="password" type="password" autocomplete="current-password" />
    <button type="button" id="login-submit">Sign in</button>
    <p id="login-error" class="login-error" role="alert" aria-live="polite"></p>
  </div>
</div>`;
    const card = ctx.content.querySelector("#login-card");
    const userEl = ctx.content.querySelector("#login-user");
    const passEl = ctx.content.querySelector("#login-pass");
    const submit = ctx.content.querySelector("#login-submit");
    const err = ctx.content.querySelector("#login-error");

    function setError(msg) {
      err.textContent = msg || "";
      err.classList.toggle("on", Boolean(msg));
      card.classList.toggle("has-error", Boolean(msg));
      userEl.classList.toggle("invalid", Boolean(msg));
      passEl.classList.toggle("invalid", Boolean(msg));
      if (msg) {
        card.classList.remove("shake");
        void card.offsetWidth;
        card.classList.add("shake");
      }
    }

    function trySignIn() {
      const user = (userEl.value || "").trim();
      const pass = passEl.value || "";
      if (!user || !pass) {
        setError("Enter both username and password.");
        if (!user) userEl.focus();
        else passEl.focus();
        return;
      }
      if (user === AUTH_USER && pass === AUTH_PASS) {
        setError("");
        rememberSignIn();
        resolve();
        return;
      }
      setError("Wrong username or password.");
      passEl.value = "";
      passEl.focus();
    }

    userEl.focus();
    submit.addEventListener("click", trySignIn, { signal: ctx.signal });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        trySignIn();
      }
    }, { signal: ctx.signal });
  });
}

// Decisions this browser has written but a read has not shown yet. A read serves
// a briefly cached copy of the decisions table, so a re-read right after a write
// (the 8s poll, or a Reload) can come back WITHOUT the new row and would flip the
// tender back to "Needs Review" until a hard refresh. Module-level so it also
// survives ctx.reload(). Each entry is dropped as soon as a read includes it.
const pendingWrites = new Map();
const PENDING_WRITE_TTL_MS = 15 * 60 * 1000;

function toMs(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "bigint") v = Number(v);
  if (typeof v === "number") return v > 1e14 ? v / 1000 : v; // micros -> ms
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? 0 : t;
}

function overlayPendingWrites(rows) {
  const now = Date.now();
  for (const r of rows) {
    const ov = pendingWrites.get(r.tender_id);
    if (!ov) continue;
    const seen = toMs(r.latest_decided_at);
    if (now - ov.ts > PENDING_WRITE_TTL_MS || seen >= ov.ts - 1000) {
      pendingWrites.delete(r.tender_id); // the read has caught up
      continue;
    }
    r.latest_action = ov.action;
    r.latest_decided_by = ov.decided_by;
    r.latest_decided_at = ov.iso;
    r.latest_note = ov.note;
    r.all_notes = [r.all_notes, ov.note].filter(Boolean).join(" | ");
    if (ov.action === "comment") continue;
    r.latest_push_status = "pending";
    r.latest_crm_link = null;
    r.latest_sharepoint_link = null;
  }
  return rows;
}

async function loadRows(db) {
  const rows = overlayPendingWrites(await db.rows(`
    SELECT
      p.tender_id, p.tender_title, p.source_site, p.date_first_seen, p.date_last_updated,
      p.verdict, p.confidence, p.felix_bidding_score, p.justification, p.review_status,
      p.decided_by, p.decided_at, p.crm_pushed, p.sharepoint_pushed, p.crm_link, p.sharepoint_link,
      COALESCE(NULLIF(TRIM(CAST(p.solicitation_number AS VARCHAR)), ''), CAST(n.solicitation_number AS VARCHAR)) AS solicitation_number,
      COALESCE(CAST(n.publication_date AS VARCHAR), CAST(p.publication_date AS VARCHAR)) AS publication_date,
      COALESCE(CAST(n.closing_date AS VARCHAR), CAST(p.closing_date AS VARCHAR)) AS closing_date,
      CASE
        WHEN COALESCE(CAST(n.closing_date AS VARCHAR), CAST(p.closing_date AS VARCHAR), '') = '' THEN NULL
        ELSE date_diff('day', CURRENT_DATE, CAST(TRY_CAST(COALESCE(CAST(n.closing_date AS VARCHAR), CAST(p.closing_date AS VARCHAR)) AS TIMESTAMP) AS DATE))
      END AS days_remaining,
      d.action AS latest_action, d.decided_by AS latest_decided_by, d.decided_at AS latest_decided_at,
      d.status AS latest_push_status, d.crm_link AS latest_crm_link,
      d.sharepoint_link AS latest_sharepoint_link, d.note AS latest_note,
      hist.all_notes AS all_notes
    FROM processed p
    LEFT JOIN (
      SELECT tender_id, publication_date, closing_date, solicitation_number
      FROM (
        SELECT tender_id, publication_date, closing_date, solicitation_number FROM tender_notices
        UNION ALL
        SELECT tender_id, publication_date, closing_date, solicitation_number FROM tender_notices_disc
        WHERE tender_id NOT IN (SELECT tender_id FROM tender_notices)
      ) dates
    ) n ON n.tender_id = p.tender_id
    LEFT JOIN (
      SELECT tender_id, action, decided_by, decided_at, status, crm_link, sharepoint_link, note
      FROM (
        SELECT *, row_number() OVER (PARTITION BY tender_id ORDER BY decided_at DESC) AS rn
        FROM decisions
      ) t
      WHERE rn = 1
    ) d ON d.tender_id = p.tender_id
    LEFT JOIN (
      SELECT tender_id,
             string_agg(CAST(note AS VARCHAR), ' | ' ORDER BY decided_at) AS all_notes
      FROM decisions
      GROUP BY tender_id
    ) hist ON hist.tender_id = p.tender_id
    LIMIT 2000
  `));
  return rows.map((r) => {
    let effStatus = r.review_status;
    let effDecidedBy = r.decided_by;
    let effDecidedAt = r.decided_at;
    let crmLink = r.crm_link;
    let sharepointLink = r.sharepoint_link;
    if (r.latest_action === "approve") {
      effStatus = "approved";
      effDecidedBy = r.latest_decided_by;
      effDecidedAt = r.latest_decided_at;
      if (r.latest_crm_link && r.latest_crm_link !== "none") crmLink = r.latest_crm_link;
      if (r.latest_sharepoint_link && r.latest_sharepoint_link !== "none") sharepointLink = r.latest_sharepoint_link;
    } else if (r.latest_action === "reject") {
      effStatus = "declined";
      effDecidedBy = r.latest_decided_by;
      effDecidedAt = r.latest_decided_at;
    }
    return {
      ...r,
      eff_review_status: effStatus,
      eff_decided_by: effDecidedBy,
      eff_decided_at: effDecidedAt,
      eff_crm_link: crmLink,
      eff_sharepoint_link: sharepointLink,
    };
  });
}

function sortIcons(col, sortCol, sortDir) {
  const active = col === sortCol;
  return `<span class="sort-icons" aria-hidden="true">
    <span class="sort-up${active && sortDir === 1 ? " on" : ""}">▲</span>
    <span class="sort-down${active && sortDir === -1 ? " on" : ""}">▼</span>
  </span>`;
}

function ariaSort(col, sortCol, sortDir) {
  if (col !== sortCol) return "none";
  return sortDir === 1 ? "ascending" : "descending";
}

function pageList(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const keep = new Set([1, total, current, current - 1, current + 1]);
  const nums = [...keep].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out = [];
  for (const n of nums) {
    if (out.length && n - out[out.length - 1] > 1) out.push("…");
    out.push(n);
  }
  return out;
}

function renderRow(row, expandedReasons) {
  const st = statusInfo(row);
  const info = infoLink(row.tender_id, row.source_site);
  const crmOk = row.eff_crm_link && row.eff_crm_link !== "none";
  const spOk = row.eff_sharepoint_link && row.eff_sharepoint_link !== "none";
  const showCrmSp = isInCrmBucket(row);
  const isPushing = row.eff_review_status === "approved" && row.latest_push_status === "pending";
  const expanded = expandedReasons.has(row.tender_id);
  const reason = String(row.justification || "No reasoning recorded.");
  const reasonLong = reason.length > 140;
  const felix = formatScore(row.felix_bidding_score);
  const felixTone = scoreTone(row.felix_bidding_score);
  const felixBar = scoreNumber(row.felix_bidding_score);
  const cert = formatScore(row.confidence);
  const certBar = scoreNumber(row.confidence);

  const links = [];
  if (info) links.push(`<a href="${esc(info)}" target="_blank" rel="noopener">Tender info</a>`);
  else links.push(`<span class="muted">no info link</span>`);
  if (showCrmSp) {
    const sum = summarizePush(row);
    const crmTitle = crmHoverTitle(sum);
    const spTitle = spHoverTitle(sum);
    const crmHtml = isPushing
      ? `<span class="muted" title="${esc(crmTitle)}"><span class="spinner"></span> CRM</span>`
      : (crmOk
        ? `<a href="${esc(row.eff_crm_link)}" target="_blank" rel="noopener" title="${esc(crmTitle)}">CRM</a>`
        : `<span class="muted" title="${esc(crmTitle)}">CRM —</span>`);
    const spHtml = isPushing
      ? `<span class="muted" title="${esc(spTitle)}"><span class="spinner"></span> SharePoint</span>`
      : (spOk
        ? `<a href="${esc(row.eff_sharepoint_link)}" target="_blank" rel="noopener" title="${esc(spTitle)}">SharePoint</a>`
        : `<span class="muted" title="${esc(spTitle)}">SharePoint —</span>`);
    links.push(`<div class="push-pair" data-tender="${esc(row.tender_id)}">
      <div class="push-links">${crmHtml}${spHtml}</div>
      <button type="button" class="push-detail" data-tender="${esc(row.tender_id)}" title="CRM &amp; SharePoint push details" aria-label="Show CRM and SharePoint push details">
        <span class="push-dot ${pushDotClass(sum.overall)}"></span>i
      </button>
    </div>`);
  }
  const isRemoving = row.eff_review_status === "declined" && row.latest_push_status === "pending";
  const busy = isPushing || isRemoving;
  const adminNote = parseAdminNote(row.latest_note);
  const decided = row.eff_decided_by
    ? `<div class="decided-note">${esc(row.eff_decided_by)}${row.eff_decided_at ? " · " + esc(row.eff_decided_at) : ""}</div>`
    : "";
  const noteHtml = adminNote
    ? `<div class="admin-note" title="${esc(adminNote)}">${esc(adminNote)}</div>`
    : "";
  const fail = (row.latest_push_status === "failed" && row.latest_note && !adminNote)
    ? `<div class="decided-note fail-note">${esc(row.latest_note)}</div>`
    : "";
  const kind = statusKind(row);
  let actionBtns = "";
  if (kind === "review") {
    actionBtns = `<button type="button" class="act approve" data-tender="${esc(row.tender_id)}" data-action="approve"${busy ? " disabled" : ""}>✓ Approve</button>
      <button type="button" class="act reject" data-tender="${esc(row.tender_id)}" data-action="reject"${busy ? " disabled" : ""}>✕ Reject</button>`;
  } else if (kind === "screened_out") {
    actionBtns = `<button type="button" class="act comment" data-tender="${esc(row.tender_id)}" data-action="comment"${busy ? " disabled" : ""}>Comment</button>`;
  } else if (kind === "auto_approved" || kind === "approved") {
    actionBtns = `<button type="button" class="act change" data-tender="${esc(row.tender_id)}" data-action="reject"${busy ? " disabled" : ""}>Change status</button>`;
  } else if (kind === "auto_declined" || kind === "declined") {
    actionBtns = `<button type="button" class="act change" data-tender="${esc(row.tender_id)}" data-action="approve"${busy ? " disabled" : ""}>Change status</button>`;
  }
  const actions = `<div class="tc-actions">${actionBtns}</div>${decided}${noteHtml}${fail}`;


  return `
<tr data-tender="${esc(row.tender_id)}">
  <td class="col-name">
    <div class="name-title">${esc(row.tender_title || row.tender_id)}</div>
    ${row.solicitation_number ? `<div class="name-sol">${esc(row.solicitation_number)}</div>` : ""}
    <div class="name-sub">${esc(row.tender_id)}</div>
  </td>
  <td class="col-source">${esc(sourceLabel(row.source_site))}</td>
  <td class="col-date">
    <div>${esc(row.date_last_updated || "—")}</div>
    <div class="name-sub">first ${esc(row.date_first_seen || "—")}</div>
  </td>
  <td class="col-pub">${esc(formatDay(row.publication_date))}</td>
  <td class="col-close">
    <div>${esc(formatDay(row.closing_date))}</div>
    ${remainLabel(row.days_remaining) ? `<span class="remain ${remainTone(row.days_remaining)}">${esc(remainLabel(row.days_remaining))}</span>` : `<span class="name-sub">—</span>`}
  </td>
  <td class="col-status">
    <span class="badge ${st.cls}">${(isPushing || isRemoving) ? '<span class="spinner"></span> ' : ""}${esc(st.label)}</span>
  </td>
  <td class="col-score" data-tone="${felixTone}">
    <div class="score-cell">
      <span class="score-n">${esc(felix)}</span>
      ${felixBar === null ? "" : `<span class="score-bar" title="How well this tender fits Felix"><span style="width:${Math.max(0, Math.min(100, felixBar))}%"></span></span>`}
    </div>
  </td>
  <td class="col-certainty">
    <div class="score-cell">
      <span class="score-n">${esc(cert)}</span>
      ${certBar === null ? "" : `<span class="score-bar" title="How sure of pass / fail / review — not how good the bid is"><span style="width:${Math.max(0, Math.min(100, certBar))}%"></span></span>`}
    </div>
  </td>
  <td class="col-links"><div class="row-links">${links.join("")}</div></td>
  <td class="col-reason">
    <div class="reason-cell${expanded ? " expanded" : ""}">${esc(reason)}</div>
    ${reasonLong ? `<button type="button" class="reason-toggle" data-tender="${esc(row.tender_id)}">${expanded ? "Show less" : "Show more"}</button>` : ""}
  </td>
  <td class="col-actions">${actions}</td>
</tr>`;
}

async function renderDashboard(ctx) {
  ctx.content.innerHTML = `
<div id="app">
  <div id="header">
    <div class="brand">
      <h1>Felix Tec Tender Scout — Review Dashboard</h1>
      <p>Live from the Tender Scout & Bid Recommender playbook · decisions go to Felix on the next scheduled push</p>
    </div>
    <div class="header-right">
      <div class="kpis" id="kpis"></div>
      <button type="button" id="sign-out" class="sign-out">Sign out</button>
    </div>
  </div>
  <div id="toolbar">
    <input id="search" type="text" placeholder="Search tender title or id…" />
    <div class="seg" id="filters">
      ${FILTERS.map((f) => `<button data-filter="${f.key}">${esc(f.label)}</button>`).join("")}
    </div>
    <div class="refresh-note">Reload re-reads this list. It does not send anything to Felix.</div>
  </div>
  <div id="main"></div>
</div>
<div id="push-pop" class="push-pop" hidden>
  <div class="push-pop-backdrop" data-push-close="1"></div>
  <div class="push-pop-card" role="dialog" aria-modal="true" aria-labelledby="push-pop-title">
    <button type="button" class="push-pop-close" data-push-close="1" aria-label="Close">×</button>
    <div id="push-pop-body"></div>
  </div>
</div>
<div id="push-tip" class="push-tip" hidden></div>
<div id="decide-pop" class="push-pop" hidden>
  <div class="push-pop-backdrop" data-decide-close="1"></div>
  <div class="push-pop-card decide-card" role="dialog" aria-modal="true" aria-labelledby="decide-title">
    <button type="button" class="push-pop-close" data-decide-close="1" aria-label="Close">×</button>
    <h2 id="decide-title">Record decision</h2>
    <p class="decide-tender" id="decide-tender"></p>
    <p class="decide-warn" id="decide-warn" hidden></p>
    <label for="decide-note">Admin note <span class="req">required</span></label>
    <textarea id="decide-note" rows="4" placeholder="Why are you approving or rejecting this tender?"></textarea>
    <p id="decide-error" class="login-error" role="alert" aria-live="polite"></p>
    <div class="decide-btns">
      <button type="button" class="decide-cancel" data-decide-close="1">Cancel</button>
      <button type="button" id="decide-confirm">Confirm</button>
    </div>
  </div>
</div>`;

  const main = ctx.content.querySelector("#main");
  const kpis = ctx.content.querySelector("#kpis");
  const searchBox = ctx.content.querySelector("#search");
  const filterBar = ctx.content.querySelector("#filters");
  ctx.content.querySelector("#sign-out").addEventListener("click", () => {
    forgetSignIn();
    location.reload();
  }, { signal: ctx.signal });


  let all = [];
  try {
    all = await loadRows(ctx.db);
  } catch (err) {
    main.innerHTML = `<div class="load-note">Couldn't load tender data: ${esc(err && err.message ? err.message : String(err))}</div>`;
    return;
  }
  if (ctx.signal.aborted) return;

  let activeFilter = "all";
  let query = "";
  let sortCol = "publication_date";
  let sortDir = -1;
  let page = 1;
  let pageSize = 25;
  let pollTimer = null;
  let openPushId = null;
  const expandedReasons = new Set();

  function computeKpis(rows) {
    const total = rows.length;
    const autoApproved = rows.filter((r) => statusKind(r) === "auto_approved").length;
    const screened = rows.filter((r) => statusKind(r) === "screened_out").length;
    const review = rows.filter((r) => needsReview(r)).length;
    kpis.innerHTML = `
      <div class="kpi"><div class="n">${total}</div><div class="l">Total</div></div>
      <div class="kpi pass"><div class="n">${autoApproved}</div><div class="l">Auto-Approved</div></div>
      <div class="kpi fail"><div class="n">${screened}</div><div class="l">Screened Out</div></div>
      <div class="kpi review"><div class="n">${review}</div><div class="l">Review</div></div>
    `;
  }

  function applyFilter(rows) {
    let out = rows;
    if (activeFilter !== "all") out = out.filter((r) => statusKind(r) === activeFilter);
    if (query) {
      const q = query.toLowerCase();
      out = out.filter((r) =>
        (r.tender_title || "").toLowerCase().includes(q) ||
        (r.tender_id || "").toLowerCase().includes(q) ||
        (r.solicitation_number || "").toLowerCase().includes(q)
      );
    }
    return out;
  }

  function applySort(rows) {
    const out = [...rows];
    out.sort((a, b) => {
      if (sortCol === "confidence" || sortCol === "felix_bidding_score") {
        const av = scoreNumber(a[sortCol]);
        const bv = scoreNumber(b[sortCol]);
        const an = av === null ? -Infinity : av;
        const bn = bv === null ? -Infinity : bv;
        return (an - bn) * sortDir;
      }
      if (sortCol === "days_remaining") {
        const av = remainDays(a.days_remaining);
        const bv = remainDays(b.days_remaining);
        const missing = sortDir === 1 ? Infinity : -Infinity;
        const an = av === null ? missing : av;
        const bn = bv === null ? missing : bv;
        return (an - bn) * sortDir;
      }
      const av = String(a[sortCol] || "");
      const bv = String(b[sortCol] || "");
      if (!av && bv) return 1;
      if (av && !bv) return -1;
      return av.localeCompare(bv) * sortDir;
    });
    return out;
  }

  function paint() {
    const filtered = applyFilter(all);
    const rows = applySort(filtered);
    computeKpis(all);
    if (!rows.length) {
      main.innerHTML = `<div id="empty-note">No tenders match this view.</div>`;
      return;
    }
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    if (page > totalPages) page = totalPages;
    if (page < 1) page = 1;
    const start = (page - 1) * pageSize;
    const pageRows = rows.slice(start, start + pageSize);
    const end = start + pageRows.length;
    const pages = pageList(page, totalPages);

    const nameSort = sortIcons("tender_title", sortCol, sortDir);
    const dateSort = sortIcons("date_last_updated", sortCol, sortDir);
    const pubSort = sortIcons("publication_date", sortCol, sortDir);
    const closeSort = sortIcons("days_remaining", sortCol, sortDir);
    const felixSort = sortIcons("felix_bidding_score", sortCol, sortDir);
    const scoreSort = sortIcons("confidence", sortCol, sortDir);

    main.innerHTML = `
<div class="table-wrap">
  <table class="tender-table">
    <caption class="sr-only">Processed tenders</caption>
    <thead>
      <tr>
        <th class="col-name" aria-sort="${ariaSort("tender_title", sortCol, sortDir)}">
          <button type="button" class="th-sort" data-sort="tender_title">Name ${nameSort}</button>
        </th>
        <th class="col-source">Source</th>
        <th class="col-date" aria-sort="${ariaSort("date_last_updated", sortCol, sortDir)}">
          <button type="button" class="th-sort" data-sort="date_last_updated">Last Updated ${dateSort}</button>
        </th>
        <th class="col-pub" aria-sort="${ariaSort("publication_date", sortCol, sortDir)}">
          <button type="button" class="th-sort" data-sort="publication_date">Published ${pubSort}</button>
        </th>
        <th class="col-close" aria-sort="${ariaSort("days_remaining", sortCol, sortDir)}">
          <button type="button" class="th-sort th-sort-stack" data-sort="days_remaining" title="Soonest closing first">
            <span class="th-sort-row">Closing ${closeSort}</span>
            <span class="th-sub">days remaining</span>
          </button>
        </th>
        <th class="col-status">Status</th>
        <th class="col-score" aria-sort="${ariaSort("felix_bidding_score", sortCol, sortDir)}">
          <button type="button" class="th-sort th-sort-stack" data-sort="felix_bidding_score" title="How well this tender fits Felix">
            <span class="th-sort-row">Felix score ${felixSort}</span>
            <span class="th-sub">fit for Felix</span>
          </button>
        </th>
        <th class="col-certainty" aria-sort="${ariaSort("confidence", sortCol, sortDir)}">
          <button type="button" class="th-sort th-sort-stack" data-sort="confidence" title="How sure the scout is of its pass / fail / review verdict — not how good the bid is">
            <span class="th-sort-row">Verdict certainty ${scoreSort}</span>
            <span class="th-sub">sure of the verdict</span>
          </button>
        </th>
        <th class="col-links">Links</th>
        <th class="col-reason">Reasoning</th>
        <th class="col-actions">Actions</th>
      </tr>
    </thead>
    <tbody>
      ${pageRows.map((r) => renderRow(r, expandedReasons)).join("")}
    </tbody>
  </table>
</div>
<div class="pager">
  <span class="pager-info">Showing ${start + 1}–${end} of ${rows.length}</span>
  <div class="pager-btns">
    <button type="button" data-page="prev" ${page === 1 ? "disabled" : ""}>Prev</button>
    ${pages.map((p) => (p === "…"
      ? `<span class="pager-gap">…</span>`
      : `<button type="button" data-page="${p}" class="${p === page ? "on" : ""}">${p}</button>`)).join("")}
    <button type="button" data-page="next" ${page === totalPages ? "disabled" : ""}>Next</button>
  </div>
  <label class="pager-size">Per page
    <select id="page-size">
      ${PAGE_SIZES.map((n) => `<option value="${n}"${n === pageSize ? " selected" : ""}>${n}</option>`).join("")}
    </select>
  </label>
</div>`;
    if (openPushId) {
      const openRow = all.find((r) => r.tender_id === openPushId);
      const body = ctx.content.querySelector("#push-pop-body");
      if (openRow && body) body.innerHTML = renderPushPopup(openRow);
    }
  }

  function hasPendingPush() {
    return all.some((r) => r.latest_push_status === "pending");
  }

  function schedulePoll() {
    if (pollTimer || !hasPendingPush()) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (ctx.signal.aborted) return;
      try {
        const fresh = await loadRows(ctx.db);
        if (ctx.signal.aborted) return;
        all = fresh;
        paint();
      } catch (err) {
        // A transient poll failure isn't worth alarming the reviewer over; the
        // next scheduled poll (or a manual Reload) will pick it up.
      }
      schedulePoll();
    }, 8000);
  }

  function showToast(msg) {
    const existing = ctx.content.querySelector(".toast");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    ctx.content.append(el);
    setTimeout(() => el.remove(), 5500);
  }

  function hidePushTip() {
    const tip = ctx.content.querySelector("#push-tip");
    if (tip) tip.hidden = true;
  }

  function closePushPop() {
    openPushId = null;
    const pop = ctx.content.querySelector("#push-pop");
    if (pop) pop.hidden = true;
    hidePushTip();
  }

  function openPushPop(tenderId) {
    const row = all.find((r) => r.tender_id === tenderId);
    if (!row) return;
    hidePushTip();
    openPushId = tenderId;
    const body = ctx.content.querySelector("#push-pop-body");
    const pop = ctx.content.querySelector("#push-pop");
    if (!body || !pop) return;
    body.innerHTML = renderPushPopup(row);
    pop.hidden = false;
    const closeBtn = pop.querySelector(".push-pop-close");
    if (closeBtn) closeBtn.focus();
  }

  let decide = null;

  function closeDecide() {
    decide = null;
    const pop = ctx.content.querySelector("#decide-pop");
    if (pop) pop.hidden = true;
  }

  function openDecide(tenderId, action) {
    const row = all.find((r) => r.tender_id === tenderId);
    if (!row) return;
    decide = { tenderId, action };
    const pop = ctx.content.querySelector("#decide-pop");
    const title = ctx.content.querySelector("#decide-title");
    const who = ctx.content.querySelector("#decide-tender");
    const warn = ctx.content.querySelector("#decide-warn");
    const noteEl = ctx.content.querySelector("#decide-note");
    const err = ctx.content.querySelector("#decide-error");
    const confirm = ctx.content.querySelector("#decide-confirm");
    if (!pop || !title || !who || !warn || !noteEl || !err || !confirm) return;
    const kind = statusKind(row);
    const flipping = kind === "approved" || kind === "declined"
      || kind === "auto_approved" || kind === "auto_declined";
    if (action === "comment") {
      title.textContent = "Add comment";
    } else if (flipping) {
      title.textContent = action === "approve" ? "Change to approved" : "Change to declined";
    } else {
      title.textContent = action === "approve" ? "Approve tender" : "Reject tender";
    }
    who.textContent = row.tender_title || tenderId;
    err.textContent = "";
    err.classList.remove("on");
    noteEl.value = "";
    noteEl.classList.remove("invalid");
    noteEl.placeholder = action === "comment"
      ? "Comment on this screened-out tender"
      : "Why are you approving or rejecting this tender?";
    if (action === "comment") {
      warn.hidden = true;
      warn.textContent = "";
    } else if (action === "reject" && willRemoveOnReject(row)) {
      warn.hidden = false;
      warn.textContent = "This will close the CRM ticket and remove the SharePoint folder.";
    } else if (action === "approve") {
      warn.hidden = false;
      warn.textContent = "This will send the tender to CRM and SharePoint.";
    } else {
      warn.hidden = true;
      warn.textContent = "";
    }
    if (action === "comment") {
      confirm.textContent = "Save comment";
      confirm.className = "decide-go";
    } else {
      confirm.textContent = action === "approve" ? "Confirm approve" : "Confirm reject";
      confirm.className = action === "approve" ? "decide-go approve" : "decide-go reject";
    }
    confirm.disabled = false;
    pop.hidden = false;
    noteEl.focus();
  }

  function applyLocalDecision(tenderId, action, decidedAt, note) {
    pendingWrites.set(tenderId, {
      action,
      decided_by: "web dashboard reviewer",
      ts: decidedAt.getTime(),
      iso: decidedAt.toISOString(),
      note,
    });
    const row = all.find((r) => r.tender_id === tenderId);
    if (!row) return;
    row.latest_action = action;
    row.latest_decided_by = "web dashboard reviewer";
    row.latest_decided_at = decidedAt.toISOString();
    row.latest_note = note;
    if (action === "comment") return;
    row.eff_review_status = action === "approve" ? "approved" : "declined";
    row.eff_decided_by = "web dashboard reviewer";
    row.eff_decided_at = decidedAt.toISOString();
    row.latest_push_status = "pending";
  }

  async function confirmDecide() {
    if (!decide) return;
    const noteEl = ctx.content.querySelector("#decide-note");
    const err = ctx.content.querySelector("#decide-error");
    const confirm = ctx.content.querySelector("#decide-confirm");
    const note = ((noteEl && noteEl.value) || "").trim();
    if (!note) {
      if (err) {
        err.textContent = "An admin note is required.";
        err.classList.add("on");
      }
      if (noteEl) {
        noteEl.classList.add("invalid");
        noteEl.focus();
      }
      return;
    }
    if (err) {
      err.textContent = "";
      err.classList.remove("on");
    }
    if (noteEl) noteEl.classList.remove("invalid");
    const { tenderId, action } = decide;
    const rowNow = all.find((r) => r.tender_id === tenderId) || {};
    const decidedAt = new Date();
    // Paint first. The write can take a second or two, and waiting on it left
    // the Approve/Reject buttons sitting unchanged. A later poll that has not
    // caught up is held on this same local decision by pendingWrites.
    applyLocalDecision(tenderId, action, decidedAt, note);
    closeDecide();
    paint();
    if (action !== "comment") schedulePoll();
    showToast(action === "comment"
      ? "Comment saved on this dashboard. It is not sent to Felix."
      : (action === "approve"
        ? "Approved. The scheduled job will send it to Felix CRM and SharePoint."
        : (willRemoveOnReject(rowNow)
          ? "Declined. The next scheduled job will close CRM and remove SharePoint."
          : "Declined. Recorded here; nothing to remove from Felix.")));
    try {
      await ctx.write.rows("decisions", [{
        tender_id: tenderId,
        action,
        decided_by: "web dashboard reviewer",
        decided_at: decidedAt,
        status: action === "comment" ? "done" : "pending",
        crm_link: null,
        sharepoint_link: null,
        note,
      }], { signal: ctx.signal });
    } catch (e) {
      pendingWrites.delete(tenderId);
      showToast("Couldn't record decision: " + (e && e.message ? e.message : String(e)) + " Reloading.");
      // The row was already painted as decided. Drop the local copy and reload
      // so the table matches what was actually saved, instead of leaving a
      // status that a refresh would undo.
      if (typeof ctx.reload === "function") ctx.reload();
      else location.reload();
    }
  }

  main.addEventListener("click", async (e) => {
    const sortBtn = e.target.closest("[data-sort]");
    if (sortBtn) {
      const col = sortBtn.dataset.sort;
      const spec = SORTABLE.find((s) => s.col === col);
      if (!spec) return;
      if (sortCol === col) sortDir *= -1;
      else {
        sortCol = col;
        sortDir = spec.defaultDir;
      }
      paint();
      return;
    }

    const pageBtn = e.target.closest("[data-page]");
    if (pageBtn && !pageBtn.disabled) {
      const v = pageBtn.dataset.page;
      if (v === "prev") page -= 1;
      else if (v === "next") page += 1;
      else page = Number(v);
      paint();
      return;
    }

    const detailBtn = e.target.closest(".push-detail");
    if (detailBtn) {
      e.preventDefault();
      openPushPop(detailBtn.dataset.tender);
      return;
    }

    const reasonBtn = e.target.closest(".reason-toggle");
    if (reasonBtn) {
      const id = reasonBtn.dataset.tender;
      if (expandedReasons.has(id)) expandedReasons.delete(id);
      else expandedReasons.add(id);
      const cell = reasonBtn.closest("td")?.querySelector(".reason-cell");
      const expanded = expandedReasons.has(id);
      if (cell) cell.classList.toggle("expanded", expanded);
      reasonBtn.textContent = expanded ? "Show less" : "Show more";
      return;
    }

    const actBtn = e.target.closest("button.act");
    if (!actBtn || actBtn.disabled) return;
    openDecide(actBtn.dataset.tender, actBtn.dataset.action);
    return;
  }, { signal: ctx.signal });

  main.addEventListener("mouseover", (e) => {
    const pair = e.target.closest(".push-pair");
    if (!pair || openPushId) return;
    const row = all.find((r) => r.tender_id === pair.dataset.tender);
    const tip = ctx.content.querySelector("#push-tip");
    if (!row || !tip) return;
    tip.innerHTML = hoverCardHtml(row);
    tip.hidden = false;
    const box = pair.getBoundingClientRect();
    const tw = tip.offsetWidth || 280;
    const th = tip.offsetHeight || 80;
    let left = box.left;
    if (left + tw > window.innerWidth - 12) left = Math.max(8, window.innerWidth - tw - 12);
    let top = box.top - th - 8;
    if (top < 8) top = box.bottom + 8;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }, { signal: ctx.signal });

  main.addEventListener("mouseout", (e) => {
    const pair = e.target.closest(".push-pair");
    if (!pair) return;
    const to = e.relatedTarget;
    if (to && pair.contains(to)) return;
    hidePushTip();
  }, { signal: ctx.signal });

  ctx.content.addEventListener("click", (e) => {
    if (e.target.closest("[data-push-close]")) {
      closePushPop();
    }
    if (e.target.closest("[data-decide-close]")) {
      closeDecide();
    }
    if (e.target.closest("#decide-confirm")) {
      confirmDecide();
    }
  }, { signal: ctx.signal });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (decide) closeDecide();
    else if (openPushId) closePushPop();
  }, { signal: ctx.signal });

  main.addEventListener("change", (e) => {
    if (e.target && e.target.id === "page-size") {
      pageSize = Number(e.target.value) || 25;
      page = 1;
      paint();
    }
  }, { signal: ctx.signal });

  filterBar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-filter]");
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    filterBar.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    page = 1;
    paint();
  }, { signal: ctx.signal });

  searchBox.addEventListener("input", (e) => {
    query = e.target.value;
    page = 1;
    paint();
  }, { signal: ctx.signal });

  filterBar.querySelector('button[data-filter="all"]').classList.add("on");
  paint();
  schedulePoll();

  return () => {
    if (pollTimer) clearTimeout(pollTimer);
  };
}

export default async function render(ctx) {
  if (!isSignedIn()) {
    await showLogin(ctx);
    if (ctx.signal.aborted) return;
  }
  return renderDashboard(ctx);
}
