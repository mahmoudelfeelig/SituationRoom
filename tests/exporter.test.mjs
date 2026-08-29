import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import {
  candidateReviewPack,
  createCandidateReviewFixture,
  createProcurementFixture,
  procurementPack,
} from "../src/domain-packs/index.js";
import { evaluateWithDomainPack, getDecisionHash } from "../src/kernel/index.js";
import { createDecisionPacket, serializeDecisionPacket } from "../src/workspace/exporter.js";

const decisionCase = createProcurementFixture();
const evaluation = evaluateWithDomainPack(decisionCase, procurementPack);
const packet = createDecisionPacket(decisionCase, evaluation, {
  generatedAt: "2026-08-28T12:00:00.000Z",
});

test("decision packet retains revision, digest, authority, and exact source anchors", () => {
  assert.equal(packet.case.revision, decisionCase.revision);
  assert.equal(packet.case.decisionHash, getDecisionHash(decisionCase));
  assert.equal(packet.contract.authority.humanConfirmationRequired, true);
  assert.ok(packet.claims.length > 0);
  assert.ok(packet.claims.every((claim) => claim.citations.length > 0));
  assert.ok(packet.appendix.sourceAnchors.every((source) => source.locator));
  const documentsById = new Map(decisionCase.documents.map((document) => [document.id, document]));
  assert.ok(
    packet.appendix.documents.every(
      (document) => document.fingerprint === documentsById.get(document.id).byteHash,
    ),
  );
});

test("CSV exports neutralize formula-leading strings without changing numeric cells", () => {
  const unsafePacket = structuredClone(packet);
  unsafePacket.claims = [
    {
      id: "formula-shaped-strings",
      alternative: "=2+2",
      criterion: "+cmd",
      value: "-1+2",
      status: "@SUM",
      confidence: -0.25,
      citations: [{ label: "=link" }],
    },
    {
      id: "ordinary-number",
      alternative: "Ordinary value",
      criterion: "Signed number",
      value: -42,
      status: "accepted",
      confidence: 0.9,
      citations: [],
    },
  ];

  const exported = serializeDecisionPacket(unsafePacket, "csv");
  assert.match(exported.text, /'=2\+2,'\+cmd,'-1\+2,'@SUM,-0\.25,'=link/);
  assert.match(exported.text, /Ordinary value,Signed number,-42,accepted,0\.9,/);
  assert.doesNotMatch(exported.text, /Ordinary value,Signed number,'-42/);
});

test("text exports are parseable and preserve human-authority language", () => {
  const json = serializeDecisionPacket(packet, "json");
  assert.equal(JSON.parse(json.text).case.decisionHash, packet.case.decisionHash);

  const jsonld = serializeDecisionPacket(packet, "jsonld");
  assert.equal(JSON.parse(jsonld.text)["@type"], "DecisionPacket");

  const csv = serializeDecisionPacket(packet, "csv");
  assert.match(csv.text, /Alternative,Criterion,Value,Status,Confidence,Citations/);
  assert.match(csv.text, /Decision hash/);

  const html = serializeDecisionPacket(packet, "html");
  assert.match(html.text, /Human authority remains required/);
  assert.match(html.text, new RegExp(packet.case.decisionHash));

  const printable = serializeDecisionPacket(packet, "pdf");
  assert.equal(printable.printRequired, true);
  assert.match(printable.fileName, /\.print\.html$/);
});

test("Office exports are valid OOXML packages with expected canonical content", () => {
  const xlsx = unzipSync(serializeDecisionPacket(packet, "xlsx").bytes);
  assert.ok(xlsx["xl/workbook.xml"]);
  assert.match(strFromU8(xlsx["xl/worksheets/sheet1.xml"]), /Decision hash/);

  const docx = unzipSync(serializeDecisionPacket(packet, "docx").bytes);
  assert.ok(docx["word/document.xml"]);
  assert.match(strFromU8(docx["word/document.xml"]), new RegExp(packet.case.decisionHash));
});

test("candidate packets expose requirement evidence without machine employment outcomes in every format", () => {
  const candidateCase = createCandidateReviewFixture();
  const candidateEvaluation = evaluateWithDomainPack(candidateCase, candidateReviewPack);
  const candidatePacket = createDecisionPacket(candidateCase, candidateEvaluation, {
    generatedAt: "2026-08-28T12:00:00.000Z",
  });

  assert.equal(candidatePacket.analysis.mode, "requirement-evidence-only");
  for (const forbiddenKey of ["recommendation", "ranking", "blockerCount", "eligible", "score", "blockers"]) {
    assert.equal(Object.hasOwn(candidatePacket.analysis, forbiddenKey), false, `${forbiddenKey} must not be present`);
    assert.equal(candidatePacket.analysis.alternatives.some((entry) => Object.hasOwn(entry, forbiddenKey)), false);
  }
  assert.ok(candidatePacket.analysis.alternatives.every((entry) => entry.requirements.length > 0));
  assert.ok(candidatePacket.analysis.alternatives.some((entry) =>
    entry.requirements.some((requirement) => requirement.evidenceState === "not-demonstrated"),
  ));

  const textArtifacts = ["json", "jsonld", "csv", "html", "pdf"]
    .map((format) => serializeDecisionPacket(candidatePacket, format).text);
  const xlsx = unzipSync(serializeDecisionPacket(candidatePacket, "xlsx").bytes);
  const docx = unzipSync(serializeDecisionPacket(candidatePacket, "docx").bytes);
  textArtifacts.push(strFromU8(xlsx["xl/worksheets/sheet1.xml"]));
  textArtifacts.push(strFromU8(docx["word/document.xml"]));

  for (const content of textArtifacts) {
    assert.doesNotMatch(content, /No eligible recommendation|leading eligible result|>Blocked<|>Eligible<|<th>Score<\/th>|<th>Blockers<\/th>/i);
  }
  assert.match(serializeDecisionPacket(candidatePacket, "html").text, /Requirement evidence only/);
  assert.match(serializeDecisionPacket(candidatePacket, "html").text, /Not demonstrated/);
  assert.match(serializeDecisionPacket(candidatePacket, "csv").text, /Employment authority,Human panel only/);
});
