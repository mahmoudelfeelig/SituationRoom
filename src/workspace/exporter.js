import { strToU8, zipSync } from "fflate";
import { getDecisionHash } from "../kernel/index.js";

const encoder = new TextEncoder();

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function html(value) {
  return xml(value);
}

function csv(value) {
  const text = value === null || value === undefined
    ? ""
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  const safeText = typeof value === "string" && /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safeText) ? `"${safeText.replaceAll('"', '""')}"` : safeText;
}

function safeFileStem(value) {
  return String(value || "situation-room-case")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "situation-room-case";
}

function sourceLabel(reference, fragmentById, documentById) {
  const fragment = fragmentById.get(reference?.fragmentId);
  const document = documentById.get(reference?.documentId ?? fragment?.documentId);
  const locator = reference?.locator ?? fragment?.locator ?? fragment?.nativeLocator;
  let location = "anchored passage";
  if (typeof locator === "string") location = locator;
  else if (locator?.page) location = `page ${locator.page}`;
  else if (locator?.sheet && locator?.range) location = `${locator.sheet}!${locator.range}`;
  else if (locator?.slide) location = `slide ${locator.slide}`;
  else if (locator?.paragraph) location = `paragraph ${locator.paragraph}`;
  else if (locator?.line) location = `line ${locator.line}`;
  return `${document?.title ?? document?.name ?? "Source"} · ${location}`;
}

export function createDecisionPacket(decisionCase, evaluation, { includeAppendix = true, generatedAt } = {}) {
  if (!decisionCase) throw new Error("An active decision case is required.");
  const alternativeById = new Map(decisionCase.alternatives.map((item) => [item.id, item]));
  const criterionById = new Map(decisionCase.criteria.map((item) => [item.id, item]));
  const fragmentById = new Map(decisionCase.fragments.map((item) => [item.id, item]));
  const documentById = new Map(decisionCase.documents.map((item) => [item.id, item]));
  const claims = decisionCase.claims.map((claim) => ({
    id: claim.id,
    alternative: alternativeById.get(claim.subjectId)?.label ?? claim.subjectId,
    criterion: criterionById.get(claim.criterionId)?.label ?? claim.criterionId,
    value: claim.value,
    status: claim.status,
    confidence: claim.confidence ?? null,
    citations: (claim.sourceRefs ?? []).map((reference) => ({
      label: sourceLabel(reference, fragmentById, documentById),
      documentId: reference.documentId,
      fragmentId: reference.fragmentId,
      quoteHash: reference.quoteHash ?? null,
    })),
  }));
  const candidateReview = decisionCase.domain.packId === "candidate-review";
  const analysis = candidateReview
    ? {
        mode: "requirement-evidence-only",
        authority: "Requirement evidence only. The human panel retains sole authority over every employment outcome.",
        unresolvedCount: evaluation?.unresolvedCount ?? 0,
        alternatives: (evaluation?.results ?? []).map((result) => ({
          id: result.alternativeId,
          label: result.alternative.label,
          requirements: (result.criteria ?? []).map((entry) => ({
            criterionId: entry.criterionId,
            label: entry.criterion?.label ?? entry.criterionId,
            evidenceState: ["unknown", "conflict"].includes(entry.measurement?.status)
              ? entry.measurement.status
              : entry.status === "pass" ? "verified" : entry.status === "fail" ? "not-demonstrated" : "review-required",
            measurementStatus: entry.measurement?.status ?? "unknown",
            sourceAnchorCount: entry.measurement?.sourceRefs?.length ?? 0,
          })),
        })),
      }
    : {
        mode: "deterministic-decision-support",
        recommendation: evaluation?.recommendation
          ? {
              alternativeId: evaluation.recommendation.alternativeId,
              label: evaluation.recommendation.alternative.label,
              eligible: evaluation.recommendation.eligible,
              score: evaluation.recommendation.score,
            }
          : null,
        blockerCount: evaluation?.blockerCount ?? 0,
        unresolvedCount: evaluation?.unresolvedCount ?? 0,
        alternatives: (evaluation?.results ?? []).map((result) => ({
          id: result.alternativeId,
          label: result.alternative.label,
          eligible: result.eligible,
          score: result.score,
          blockers: result.blockers.map((entry) => entry.criterion?.label ?? entry.criterionId),
        })),
      };
  return {
    schemaVersion: 1,
    kind: "situation-room-decision-packet",
    generatedAt: generatedAt ?? new Date().toISOString(),
    case: {
      id: decisionCase.id,
      title: decisionCase.title,
      subtitle: decisionCase.subtitle,
      domainId: decisionCase.domain.packId,
      status: decisionCase.status,
      revision: decisionCase.revision,
      decisionHash: getDecisionHash(decisionCase),
    },
    contract: {
      question: decisionCase.contract.question,
      objective: decisionCase.contract.objective,
      status: decisionCase.contract.status,
      authority: decisionCase.contract.authority,
      evidencePolicy: decisionCase.contract.evidencePolicy,
    },
    analysis,
    claims,
    appendix: includeAppendix
      ? {
          documents: decisionCase.documents.map((document) => ({
            id: document.id,
            name: document.title ?? document.name,
            format: document.format ?? document.mimeType,
            fingerprint: document.fingerprint ?? document.hash ?? document.byteHash ?? null,
            securityStatus: document.securityStatus,
          })),
          sourceAnchors: decisionCase.fragments.map((fragment) => ({
            id: fragment.id,
            documentId: fragment.documentId,
            locator: fragment.locator ?? fragment.nativeLocator ?? null,
            text: fragment.text,
            confidence: fragment.confidence ?? fragment.extractionConfidence ?? null,
          })),
          audit: decisionCase.audit,
        }
      : null,
  };
}

function packetRows(packet) {
  const candidateReview = packet.analysis.mode === "requirement-evidence-only";
  return [
    ["Case", packet.case.title],
    ["Question", packet.contract.question],
    ["Objective", packet.contract.objective],
    ["Decision revision", packet.case.revision],
    ["Decision hash", packet.case.decisionHash],
    ["Authority", packet.contract.authority.mode],
    ...(candidateReview
      ? [
          ["Analysis mode", "Requirement evidence only"],
          ["Employment authority", "Human panel only"],
        ]
      : [
          ["Recommendation", packet.analysis.recommendation?.label ?? "Unresolved"],
          ["Mandatory blockers", packet.analysis.blockerCount],
        ]),
    ["Unresolved values", packet.analysis.unresolvedCount],
    [],
    ["Alternative", "Criterion", "Value", "Status", "Confidence", "Citations"],
    ...packet.claims.map((claim) => [
      claim.alternative,
      claim.criterion,
      typeof claim.value === "object" ? JSON.stringify(claim.value) : claim.value,
      claim.status,
      claim.confidence,
      claim.citations.map((item) => item.label).join(" | "),
    ]),
  ];
}

function packetHtml(packet) {
  const candidateReview = packet.analysis.mode === "requirement-evidence-only";
  const alternatives = candidateReview
    ? packet.analysis.alternatives.flatMap((item) => item.requirements.map((requirement) => `
      <tr><td>${html(item.label)}</td><td>${html(requirement.label)}</td><td>${html({
        verified: "Verified",
        "not-demonstrated": "Not demonstrated",
        unknown: "Unresolved",
        conflict: "Conflicting evidence",
        "review-required": "Review required",
      }[requirement.evidenceState] ?? "Review required")}</td><td>${requirement.sourceAnchorCount}</td></tr>`)).join("")
    : packet.analysis.alternatives.map((item) => `
      <tr><td>${html(item.label)}</td><td>${item.eligible ? "Eligible" : "Blocked"}</td><td>${html(item.score ?? "—")}</td><td>${html(item.blockers.join(", ") || "None")}</td></tr>`).join("");
  const claims = packet.claims.map((claim) => `
    <tr><td>${html(claim.alternative)}</td><td>${html(claim.criterion)}</td><td>${html(typeof claim.value === "object" ? JSON.stringify(claim.value) : claim.value)}</td><td>${html(claim.status)}</td><td>${html(claim.citations.map((item) => item.label).join("; ") || "Uncited")}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${html(packet.case.title)} · decision report</title><style>
  body{margin:0 auto;max-width:1100px;padding:44px;color:#24211d;background:#f4efe4;font:16px/1.5 Georgia,serif}header{border-top:8px solid #7f2f27;border-bottom:1px solid #756d61;padding:20px 0}h1{margin:.2rem 0;font-size:2.1rem}h2{margin-top:2rem;font-size:1.2rem;text-transform:uppercase;letter-spacing:.07em}dl{display:grid;grid-template-columns:180px 1fr;gap:5px 16px}dt{font-weight:700}dd{margin:0}table{width:100%;border-collapse:collapse;font:13px/1.35 Arial,sans-serif}th,td{padding:8px;border-bottom:1px solid #bbb1a1;text-align:left;vertical-align:top}code{font-size:11px;overflow-wrap:anywhere}.warning{border-left:4px solid #7f2f27;padding-left:12px}@media print{body{background:white;padding:0}a{color:inherit}}</style></head><body>
  <header><small>SITUATIONROOM · CITED DECISION REPORT</small><h1>${html(packet.case.title)}</h1><p>${html(packet.contract.question)}</p></header>
  <h2>Decision record</h2><dl><dt>Revision</dt><dd>${packet.case.revision}</dd><dt>Digest</dt><dd><code>${html(packet.case.decisionHash)}</code></dd><dt>Authority</dt><dd>${html(packet.contract.authority.mode)}</dd><dt>Generated</dt><dd>${html(packet.generatedAt)}</dd></dl>
  <h2>${candidateReview ? "Requirement evidence review" : "Deterministic analysis"}</h2><p class="warning">${candidateReview
    ? "Requirement evidence only. No employment outcome is computed. The human panel retains sole authority."
    : `${packet.analysis.recommendation ? `${html(packet.analysis.recommendation.label)} is the leading eligible result under the declared model.` : "No eligible recommendation is available."} Human authority remains required.`}</p>
  <table><thead><tr>${candidateReview
    ? "<th>Candidate ID</th><th>Job requirement</th><th>Evidence state</th><th>Source anchors</th>"
    : "<th>Alternative</th><th>Gate state</th><th>Score</th><th>Blockers</th>"}</tr></thead><tbody>${alternatives}</tbody></table>
  <h2>Claims and citations</h2><table><thead><tr><th>Alternative</th><th>Criterion</th><th>Value</th><th>Status</th><th>Source anchors</th></tr></thead><tbody>${claims}</tbody></table>
  </body></html>`;
}

function worksheetXml(rows) {
  const cells = rows.map((row, rowIndex) => {
    const entries = row.map((value, columnIndex) => {
      let column = columnIndex + 1;
      let letters = "";
      while (column > 0) {
        column -= 1;
        letters = String.fromCharCode(65 + (column % 26)) + letters;
        column = Math.floor(column / 26);
      }
      const reference = `${letters}${rowIndex + 1}`;
      if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
      return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${entries}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`;
}

function xlsxBytes(rows) {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Decision report" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(worksheetXml(rows)),
  }, { level: 6 });
}

function docxBytes(packet) {
  const paragraphs = packetRows(packet).map((row) => `<w:p><w:r><w:t xml:space="preserve">${xml(row.join(" · "))}</w:t></w:r></w:p>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`),
  }, { level: 6 });
}

export function serializeDecisionPacket(packet, format = "json") {
  const stem = `${safeFileStem(packet.case.title)}-r${packet.case.revision}`;
  if (format === "json") {
    const text = `${JSON.stringify(packet, null, 2)}\n`;
    return { format, fileName: `${stem}.json`, mimeType: "application/json", bytes: encoder.encode(text), text };
  }
  if (format === "jsonld") {
    const value = { "@context": { case: "https://schema.org/Thing", source: "https://schema.org/citation" }, "@type": "DecisionPacket", ...packet };
    const text = `${JSON.stringify(value, null, 2)}\n`;
    return { format, fileName: `${stem}.jsonld`, mimeType: "application/ld+json", bytes: encoder.encode(text), text };
  }
  if (format === "csv") {
    const text = `${packetRows(packet).map((row) => row.map(csv).join(",")).join("\r\n")}\r\n`;
    return { format, fileName: `${stem}.csv`, mimeType: "text/csv;charset=utf-8", bytes: encoder.encode(text), text };
  }
  if (format === "html" || format === "pdf") {
    const text = packetHtml(packet);
    return {
      format,
      fileName: `${stem}.${format === "pdf" ? "print.html" : "html"}`,
      mimeType: "text/html;charset=utf-8",
      bytes: encoder.encode(text),
      text,
      printRequired: format === "pdf",
    };
  }
  if (format === "xlsx") {
    return { format, fileName: `${stem}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: xlsxBytes(packetRows(packet)) };
  }
  if (format === "docx") {
    return { format, fileName: `${stem}.docx`, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: docxBytes(packet) };
  }
  throw new Error(`Unsupported export format '${String(format)}'.`);
}

export function createPortableCaseBundle(decisionCase, evaluation, options = {}) {
  return createDecisionPacket(decisionCase, evaluation, options);
}
