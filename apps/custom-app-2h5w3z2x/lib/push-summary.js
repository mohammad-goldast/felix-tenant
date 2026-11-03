function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

const CRM_FIELD_SPEC = [
  { key: "new_name", label: "Name" },
  { key: "new_solisietionnumber", label: "Solicitation number" },
  { key: "new_issuedate", label: "Issue date" },
  { key: "new_closingdatetime", label: "Closing date" },
  { key: "new_timezone", label: "Timezone" },
  { key: "new_tenderurl", label: "Tender URL" },
  { key: "new_organization", label: "Organization" },
  { key: "new_tenderorigin", label: "Tender origin" },
];

function isBlankLink(v) {
  const s = String(v ?? "").trim();
  return !s || s.toLowerCase() === "none" || s.toLowerCase() === "null";
}

function parseCrmFields(text) {
  const re = /fields:\s*\[([^\]]*)\]/gi;
  const keys = [];
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    m[1].split(",").forEach((s) => {
      const k = s.replace(/['"]/g, "").trim();
      if (k) keys.push(k);
    });
  }
  return keys.length ? keys : null;
}

function extractDocCount(text) {
  const m = String(text || "").match(/(\d+)\s+(?:document\(s\)|documents|document|files|file)/i);
  return m ? Number(m[1]) : null;
}

function extractDocNames(text) {
  const m = String(text || "").match(/uploaded\s*\(([^)]+)\)/i);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

function accumulateFilled(blob) {
  const filled = new Set();
  const fromNotes = parseCrmFields(blob) || [];
  fromNotes.forEach((k) => filled.add(k.toLowerCase()));
  return filled;
}

export function summarizePush(row) {
  const note = [row.all_notes, row.latest_note].filter(Boolean).join(" | ").trim();
  const crmPushed = String(row.crm_pushed || "").trim();
  const spPushed = String(row.sharepoint_pushed || "").trim();
  const blob = [note, crmPushed, spPushed].filter(Boolean).join(" | ");
  const crmLink = isBlankLink(row.eff_crm_link) ? "" : String(row.eff_crm_link);
  const spLink = isBlankLink(row.eff_sharepoint_link) ? "" : String(row.eff_sharepoint_link);
  const pushState = row.latest_push_status || "";
  const fully = /fully populated/i.test(blob);
  let crmMode = "unknown";
  if (/updated existing/i.test(blob)) crmMode = "updated";
  else if (/created/i.test(blob)) crmMode = "created";
  else if (crmLink) crmMode = "present";
  const filled = accumulateFilled(blob);
  const fields = filled.size ? [...filled] : null;
  const fieldRows = CRM_FIELD_SPEC.map((f) => {
    let state = "unknown";
    if (fully || filled.has(f.key.toLowerCase())) state = "filled";
    else if (crmLink) state = "missing";
    return { key: f.key, label: f.label, state };
  });
  const datesMissing = Boolean(crmLink)
    && (!filled.has("new_issuedate") || !filled.has("new_closingdatetime"));
  const noDocs = /NO_DOCS|no document source|no source documents/i.test(blob)
    || /^(none)$/i.test(spPushed);
  const docCount = extractDocCount(blob);
  const docNames = extractDocNames(note || blob);
  const ariba = blob.match(/Ariba event\s+(\d+)/i);

  let overall = "none";
  if (pushState === "pending") overall = "pending";
  else if (pushState === "failed") overall = "failed";
  else if (crmLink || spLink || note || (crmPushed && crmPushed.toLowerCase() !== "none")) {
    overall = (datesMissing || noDocs || !crmLink) ? "incomplete" : "ok";
  }
  return {
    overall, pushState, crmLink, spLink, crmMode, fieldRows, fields, fully,
    datesMissing, noDocs, docCount, docNames,
    aribaEvent: ariba ? ariba[1] : "",
    note, crmPushed, spPushed,
  };
}

export function overallLabel(sum) {
  if (sum.overall === "pending") return { text: "Pushing…", cls: "pending" };
  if (sum.overall === "failed") return { text: "Push failed", cls: "failed" };
  if (sum.overall === "incomplete") return { text: "Incomplete", cls: "review" };
  if (sum.overall === "ok") return { text: "Complete", cls: "pass" };
  return { text: "No push recorded", cls: "review" };
}

export function pushDotClass(overall) {
  if (overall === "ok") return "ok";
  if (overall === "incomplete") return "warn";
  if (overall === "failed") return "bad";
  if (overall === "pending") return "pending";
  return "muted";
}

export function crmHoverTitle(sum) {
  if (sum.overall === "pending") return "CRM push in progress…";
  if (!sum.crmLink && sum.overall === "failed") return "CRM push failed — open details";
  if (!sum.crmLink) return "No CRM record — open details";
  const missing = sum.fieldRows.filter((f) => f.state === "missing").map((f) => f.label);
  if (missing.length) {
    return "CRM record exists. Missing: " + missing.join(", ") + ". Open details for the full response.";
  }
  const nFilled = sum.fieldRows.filter((f) => f.state === "filled").length;
  if (nFilled === sum.fieldRows.length) {
    return "CRM record has all required fields (any push). Open details for the full response.";
  }
  if (nFilled) {
    return "CRM record exists with " + nFilled + " of " + sum.fieldRows.length + " required fields. Open details.";
  }
  return "CRM record exists. Open details for field-by-field status.";
}

export function spHoverTitle(sum) {
  if (sum.overall === "pending") return "SharePoint push in progress…";
  if (sum.noDocs) return "No documents uploaded to SharePoint. Open details for the full response.";
  if (sum.docCount != null) {
    return String(sum.docCount) + " document(s) on SharePoint. Open details for the full response.";
  }
  if (sum.spLink) return "SharePoint folder exists. Open details for the full response.";
  return "No SharePoint folder. Open details for the full response.";
}

export function hoverCardHtml(row) {
  const sum = summarizePush(row);
  const badge = overallLabel(sum);
  const missing = sum.fieldRows.filter((f) => f.state === "missing").map((f) => f.label);
  const nFilled = sum.fieldRows.filter((f) => f.state === "filled").length;
  let crmLine;
  if (sum.overall === "pending") crmLine = "CRM: waiting…";
  else if (!sum.crmLink) crmLine = "CRM: not created";
  else if (missing.length) crmLine = "CRM: " + sum.crmMode + " · missing " + missing.join(", ");
  else if (nFilled === sum.fieldRows.length) crmLine = "CRM: all required fields present";
  else if (sum.crmMode === "created") crmLine = "CRM: created, required fields present";
  else if (sum.crmMode === "updated") crmLine = "CRM: updated, required fields present";
  else crmLine = "CRM: record exists";
  let spLine;
  if (sum.overall === "pending") spLine = "SharePoint: waiting…";
  else if (sum.noDocs) spLine = "SharePoint: no documents";
  else if (sum.docCount != null) spLine = "SharePoint: " + sum.docCount + " document(s)";
  else if (sum.spLink) spLine = "SharePoint: folder created";
  else spLine = "SharePoint: none";
  return "<div class=\"tip-badge\">" + esc(badge.text) + "</div>"
    + "<div>" + esc(crmLine) + "</div>"
    + "<div>" + esc(spLine) + "</div>"
    + "<div class=\"tip-more\">Click the i for the full response</div>";
}

export function renderPushPopup(row) {
  const sum = summarizePush(row);
  const badge = overallLabel(sum);
  const title = row.tender_title || row.tender_id;
  const missing = sum.fieldRows.filter((f) => f.state === "missing").map((f) => f.label);
  let headline;
  if (sum.overall === "pending") {
    headline = "The approval job is still running. CRM and SharePoint usually update within a couple of minutes.";
  } else if (sum.overall === "failed") {
    headline = "The push finished with an error. See the response below.";
  } else if (sum.overall === "incomplete") {
    const bits = [];
    if (!sum.crmLink) bits.push("no CRM record");
    if (sum.datesMissing) bits.push("issue or closing date not on the CRM record");
    else if (missing.length) bits.push("missing " + missing.join(", "));
    if (sum.noDocs || !sum.spLink) bits.push("no SharePoint documents from this job");
    headline = bits.length
      ? "Something did not land: " + bits.join("; ") + "."
      : "The push completed with gaps.";
  } else if (sum.overall === "ok") {
    headline = "CRM record and SharePoint documents both landed.";
  } else {
    headline = "No CRM / SharePoint push has been recorded for this tender yet.";
  }

  const fieldsHtml = sum.fieldRows.map((f) => {
    const mark = f.state === "filled" ? "ok" : f.state === "missing" ? "missing" : "unk";
    const glyph = f.state === "filled" ? "\u2713" : f.state === "missing" ? "\u2715" : "\u00b7";
    return "<li class=\"pf " + mark + "\"><span class=\"pf-g\">" + glyph + "</span><span>" + esc(f.label) + "</span></li>";
  }).join("");

  const crmAction = sum.crmMode === "updated" ? "Updated existing record"
    : sum.crmMode === "created" ? "Created new record"
    : sum.crmLink ? "CRM record exists"
    : "No CRM record";
  const crmLinkHtml = sum.crmLink
    ? "<a href=\"" + esc(sum.crmLink) + "\" target=\"_blank\" rel=\"noopener\">Open in Dynamics 365</a>"
    : "<span class=\"muted\">No record URL</span>";

  let spBody;
  if (sum.overall === "pending") {
    spBody = "<p class=\"muted\">Waiting for documents\u2026</p>";
  } else if (sum.noDocs) {
    spBody = "<p class=\"warn-line\">This job did not upload documents (no source files found). A SharePoint URL on the CRM record, if any, was not written by this job.</p>";
  } else if (sum.docCount != null) {
    const names = sum.docNames.length
      ? "<ul class=\"doc-list\">" + sum.docNames.map((n) => "<li>" + esc(n) + "</li>").join("") + "</ul>"
      : "";
    const ariba = sum.aribaEvent ? "<div class=\"muted\">Ariba event " + esc(sum.aribaEvent) + "</div>" : "";
    spBody = "<p>" + sum.docCount + " document(s) uploaded.</p>" + names + ariba;
  } else if (sum.spLink) {
    spBody = "<p>SharePoint folder created. Document count was not recorded.</p>";
  } else {
    spBody = "<p class=\"muted\">No SharePoint folder.</p>";
  }
  const spLinkHtml = sum.spLink
    ? "<p><a href=\"" + esc(sum.spLink) + "\" target=\"_blank\" rel=\"noopener\">Open SharePoint folder</a></p>"
    : "";

  const responseText = sum.note
    || [sum.crmPushed, sum.spPushed].filter((s) => s && s.toLowerCase() !== "none").join(" | ");
  const noteHtml = responseText
    ? "<pre class=\"push-note\">" + esc(responseText) + "</pre>"
    : "<p class=\"muted\">No push response recorded yet.</p>";

  const datesWarn = sum.datesMissing
    ? "<p class=\"warn-line\">Issue date and/or closing date were never in a recorded CRM write for this tender.</p>"
    : "<p class=\"muted\">Green means a recorded push wrote this field to CRM. The dashboard does not assume values from our local dates.</p>";

  return "<h2 id=\"push-pop-title\">CRM &amp; SharePoint push</h2>"
    + "<p class=\"push-pop-tender\">" + esc(title) + "</p>"
    + "<p class=\"name-sub\">" + esc(row.tender_id) + "</p>"
    + "<div class=\"push-head\"><span class=\"badge " + badge.cls + "\">" + esc(badge.text) + "</span></div>"
    + "<p class=\"push-headline\">" + esc(headline) + "</p>"
    + "<section class=\"push-sec\"><h3>CRM</h3>"
    + "<p>" + esc(crmAction) + " \u00b7 " + crmLinkHtml + "</p>"
    + "<ul class=\"pf-list\">" + fieldsHtml + "</ul>" + datesWarn + "</section>"
    + "<section class=\"push-sec\"><h3>SharePoint</h3>" + spLinkHtml + spBody + "</section>"
    + "<section class=\"push-sec\"><h3>Push response</h3>" + noteHtml + "</section>";
}
