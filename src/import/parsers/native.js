import { ERROR_CODES, SituationRoomError } from "../../kernel/errors.js";

function decoded(text, encoding, diagnostics = []) {
  return { text, encoding, diagnostics };
}

function decodeWithCharset(bytes, charset) {
  const normalized = String(charset ?? "").trim().toLowerCase().replaceAll('"', "");
  if (["windows-1252", "cp1252", "iso-8859-1", "latin1"].includes(normalized)) {
    return new TextDecoder("windows-1252").decode(bytes);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function decodeTextWithMetadata(bytes, charsetHint = undefined) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decoded(new TextDecoder("utf-16le").decode(bytes.slice(2)), "utf-16le");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = bytes.slice(2);
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
    }
    return decoded(new TextDecoder("utf-16le").decode(swapped), "utf-16be");
  }
  const offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  if (charsetHint) {
    const text = decodeWithCharset(bytes.slice(offset), charsetHint);
    return decoded(text, String(charsetHint).toLowerCase());
  }
  try {
    return decoded(new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(offset)), "utf-8");
  } catch {
    return decoded(new TextDecoder("windows-1252").decode(bytes.slice(offset)), "windows-1252", [
      {
        code: "TEXT_ENCODING_FALLBACK",
        severity: "warning",
        message: "Input was not valid UTF-8 and was decoded as Windows-1252; verify punctuation and accented characters.",
        details: { encoding: "windows-1252" },
      },
    ]);
  }
}

export function decodeText(bytes) {
  return decodeTextWithMetadata(bytes).text;
}

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function normalizeWhitespace(text) {
  return decodeEntities(text.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function paragraphBlocks(text) {
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph, index) => ({ kind: "paragraph", text: paragraph, locator: { paragraph: index + 1 } }));
}

export function parseText(bytes) {
  return { blocks: paragraphBlocks(decodeText(bytes)), diagnostics: [] };
}

export function parseMarkdown(bytes) {
  const text = decodeText(bytes).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const blocks = [];
  let paragraph = [];
  let inFence = false;
  let code = [];
  let lineStart = 1;
  const flushParagraph = (lineEnd) => {
    const value = paragraph.join(" ").trim();
    if (value) blocks.push({ kind: "paragraph", text: value, locator: { lines: [lineStart, lineEnd] } });
    paragraph = [];
  };
  text.split("\n").forEach((line, index) => {
    const lineNumber = index + 1;
    if (/^\s*```/.test(line)) {
      if (inFence) {
        blocks.push({ kind: "code", text: code.join("\n"), locator: { lines: [lineStart, lineNumber] } });
        code = [];
        inFence = false;
      } else {
        flushParagraph(lineNumber - 1);
        inFence = true;
        lineStart = lineNumber;
      }
      return;
    }
    if (inFence) {
      code.push(line);
      return;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph(lineNumber - 1);
      blocks.push({
        kind: "heading",
        text: heading[2].trim(),
        locator: { line: lineNumber, level: heading[1].length },
      });
      lineStart = lineNumber + 1;
    } else if (!line.trim()) {
      flushParagraph(lineNumber - 1);
      lineStart = lineNumber + 1;
    } else {
      if (!paragraph.length) lineStart = lineNumber;
      paragraph.push(line.trim());
    }
  });
  if (inFence) {
    blocks.push({
      kind: "code",
      text: code.join("\n"),
      locator: { lines: [lineStart, text.split("\n").length], unterminated: true },
    });
  } else {
    flushParagraph(text.split("\n").length);
  }
  return { blocks, diagnostics: [] };
}

function flattenStructured(value, pointer = "", blocks = [], state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 25_000 || depth > 64) {
    throw new SituationRoomError(
      ERROR_CODES.VALIDATION_FAILED,
      "Structured document exceeds safe depth or node limits.",
    );
  }
  if (value && typeof value === "object") {
    const entries = Array.isArray(value) ? value.map((entry, index) => [String(index), entry]) : Object.entries(value);
    if (!entries.length) {
      blocks.push({ kind: "field", text: Array.isArray(value) ? "[]" : "{}", locator: { jsonPointer: pointer || "/" } });
    }
    entries.forEach(([key, child]) => {
      const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
      flattenStructured(child, `${pointer}/${escaped}`, blocks, state, depth + 1);
    });
  } else {
    blocks.push({
      kind: "field",
      text: value === null ? "null" : String(value),
      locator: { jsonPointer: pointer || "/" },
      metadata: { valueType: value === null ? "null" : typeof value, value },
    });
  }
  return blocks;
}

export function parseJson(bytes) {
  const text = decodeText(bytes);
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "JSON parsing failed.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return { blocks: flattenStructured(data), structuredData: data, diagnostics: [] };
}

export async function parseYaml(bytes) {
  const source = decodeText(bytes);
  try {
    const { parseDocument } = await import("yaml");
    const document = parseDocument(source, {
      maxAliasCount: 50,
      merge: false,
      uniqueKeys: true,
      prettyErrors: true,
    });
    if (document.errors.length) {
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "YAML parsing failed.", {
        errors: document.errors.map((error) => error.message),
      });
    }
    const data = document.toJS({ maxAliasCount: 50 });
    return { blocks: flattenStructured(data), structuredData: data, diagnostics: [] };
  } catch (error) {
    if (error instanceof SituationRoomError) throw error;
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "YAML parsing failed.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseDelimited(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Delimited file has an unterminated quoted field.");
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function columnLabel(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

export function parseCsv(bytes, delimiter = ",") {
  const text = decodeText(bytes);
  const rows = parseDelimited(text, delimiter);
  const width = Math.max(0, ...rows.map((row) => row.length));
  const diagnostics = [];
  if (rows.some((row) => row.length !== width)) {
    diagnostics.push({
      code: "RAGGED_ROWS",
      severity: "warning",
      message: "Rows contain different numbers of columns; missing cells remain explicit.",
    });
  }
  const headers = rows[0] ?? [];
  const duplicateHeaders = headers.filter((header, index) => header && headers.indexOf(header) !== index);
  if (duplicateHeaders.length) {
    diagnostics.push({
      code: "DUPLICATE_HEADERS",
      severity: "warning",
      message: "Duplicate column labels require review before schema mapping.",
      details: { headers: [...new Set(duplicateHeaders)] },
    });
  }
  const blocks = [
    {
      kind: "table",
      text: `${rows.length} rows by ${width} columns`,
      locator: { rows: rows.length, columns: width },
      metadata: { headers },
    },
  ];
  rows.forEach((row, rowIndex) => {
    for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
      blocks.push({
        kind: "cell",
        text: row[columnIndex] ?? "",
        locator: { row: rowIndex + 1, column: columnIndex + 1, range: `${columnLabel(columnIndex)}${rowIndex + 1}` },
        metadata: { header: headers[columnIndex] ?? null },
      });
    }
  });
  return { blocks, diagnostics, structuredData: rows };
}

export function parseHtml(bytes) {
  const source = decodeText(bytes);
  const diagnostics = [];
  if (/<(?:script|iframe|object|embed)\b/i.test(source)) {
    diagnostics.push({
      code: "ACTIVE_CONTENT_REMOVED",
      severity: "warning",
      message: "Scripts and embedded active content were removed before extraction.",
    });
  }
  const safe = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const blocks = [];
  const matcher = /<(h[1-6]|p|li|th|td|caption|blockquote)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let match;
  let index = 0;
  while ((match = matcher.exec(safe))) {
    const text = normalizeWhitespace(match[2]);
    if (!text) continue;
    index += 1;
    blocks.push({
      kind: /^h/i.test(match[1]) ? "heading" : /^(?:td|th)$/i.test(match[1]) ? "cell" : "paragraph",
      text,
      locator: { htmlElement: match[1].toLowerCase(), occurrence: index },
    });
  }
  if (!blocks.length) {
    const text = normalizeWhitespace(safe.replace(/<(?:br|\/p|\/div|\/li|\/tr)>/gi, "\n"));
    blocks.push(...paragraphBlocks(text));
  }
  return { blocks, diagnostics };
}

function escapeCdata(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function parseXml(bytes) {
  let source = decodeText(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
    throw new SituationRoomError(
      ERROR_CODES.QUARANTINED,
      "XML declarations containing DTDs or entities are not processed.",
      { diagnosticCode: "XML_EXTERNAL_ENTITY_RISK" },
    );
  }
  source = source
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_match, content) => escapeCdata(content))
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "");
  const tokenPattern = /<([^>]+)>|([^<]+)/g;
  const stack = [];
  const occurrences = new Map();
  const blocks = [];
  let token;
  while ((token = tokenPattern.exec(source))) {
    if (token[1] !== undefined) {
      const raw = token[1].trim();
      if (!raw || raw.startsWith("!")) continue;
      if (raw.startsWith("/")) {
        const name = raw.slice(1).trim().split(/\s/)[0];
        const current = stack.pop();
        if (current !== name) {
          throw new SituationRoomError(
            ERROR_CODES.VALIDATION_FAILED,
            `XML closing tag '${name}' does not match '${current ?? "none"}'.`,
          );
        }
      } else {
        const selfClosing = raw.endsWith("/");
        const opening = raw.replace(/\/$/, "").trim();
        const name = opening.split(/\s/)[0];
        if (!/^[A-Za-z_][\w:.-]*$/.test(name)) {
          throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "XML contains an invalid element name.");
        }
        if (stack.length >= 64) {
          throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "XML nesting exceeds the safe depth limit.");
        }
        const elementPath = `/${[...stack, name].join("/")}`;
        for (const attributeMatch of opening.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
          const attributeName = attributeMatch[1];
          if (/^xmlns(?::|$)/i.test(attributeName)) continue;
          const path = `${elementPath}/@${attributeName}`;
          const occurrence = (occurrences.get(path) ?? 0) + 1;
          occurrences.set(path, occurrence);
          blocks.push({
            kind: "field",
            text: decodeEntities(attributeMatch[2] ?? attributeMatch[3] ?? ""),
            locator: { xpath: path, occurrence },
            metadata: { attribute: true },
          });
        }
        if (!selfClosing) stack.push(name);
      }
    } else {
      const text = decodeEntities(token[2]).replace(/\s+/g, " ").trim();
      if (!text) continue;
      const path = `/${stack.join("/")}`;
      const occurrence = (occurrences.get(path) ?? 0) + 1;
      occurrences.set(path, occurrence);
      blocks.push({ kind: "field", text, locator: { xpath: path, occurrence } });
    }
  }
  if (stack.length) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, `XML element '${stack.at(-1)}' is not closed.`);
  }
  return { blocks, diagnostics: [] };
}

export function parseRtf(bytes) {
  const source = decodeText(bytes);
  if (!source.trimStart().startsWith("{\\rtf")) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "RTF signature is missing.");
  }
  const text = source
    .replace(/\\par[d]?\b/g, "\n")
    .replace(/\\'[0-9a-f]{2}/gi, (match) => String.fromCharCode(Number.parseInt(match.slice(2), 16)))
    .replace(/\\u(-?\d+)\??/g, (_match, code) => String.fromCharCode((Number(code) + 65536) % 65536))
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "")
    .replaceAll("\\\\", "\\");
  return { blocks: paragraphBlocks(text), diagnostics: [] };
}

function parseEmailHeaders(source) {
  const unfolded = source.replace(/\n[ \t]+/g, " ");
  const entries = [];
  const values = new Map();
  unfolded.split("\n").forEach((line, index) => {
    const separator = line.indexOf(":");
    if (separator <= 0) return;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    entries.push({ name, value, line: index + 1 });
    values.set(name, values.has(name) ? `${values.get(name)}, ${value}` : value);
  });
  return { entries, values };
}

function decodeBase64Payload(source) {
  const compact = source.replace(/\s+/g, "");
  if (!compact || /[^a-z0-9+/=]/i.test(compact) || compact.length % 4 === 1) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Email contains malformed base64 MIME content.", {
      diagnosticCode: "MALFORMED_MIME_ENCODING",
    });
  }
  if (globalThis.Buffer) return new Uint8Array(globalThis.Buffer.from(compact, "base64"));
  const binary = globalThis.atob(compact);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeQuotedPrintablePayload(source) {
  const unfolded = source.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let index = 0; index < unfolded.length; index += 1) {
    if (unfolded[index] === "=" && /^[0-9a-f]{2}$/i.test(unfolded.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(unfolded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(unfolded.charCodeAt(index) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function mimeParameter(header, name) {
  const expression = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]+)"|([^;\\s]+))`, "i");
  const match = expression.exec(header ?? "");
  return match?.[1] ?? match?.[2] ?? null;
}

function extractMimeText(headerValues, body, diagnostics, state, depth = 0) {
  if (depth > 5 || state.parts > 100) {
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Email MIME structure exceeds safe traversal limits.", {
      diagnosticCode: "MIME_STRUCTURE_LIMIT",
    });
  }
  state.parts += 1;
  const contentType = headerValues.get("content-type") ?? "text/plain; charset=utf-8";
  const disposition = headerValues.get("content-disposition") ?? "";
  if (/\battachment\b/i.test(disposition)) {
    state.attachments += 1;
    return [];
  }
  if (/^multipart\//i.test(contentType)) {
    const boundary = mimeParameter(contentType, "boundary");
    if (!boundary) {
      diagnostics.push({ code: "MALFORMED_MIME_BOUNDARY", severity: "error", message: "Multipart email has no usable boundary." });
      return [];
    }
    const marker = `--${boundary}`;
    const sections = body.split(marker).slice(1);
    return sections.flatMap((section) => {
      const normalized = section.replace(/^\r?\n/, "").replace(/\r?\n--\s*$/, "");
      if (!normalized.trim() || normalized.trim() === "--") return [];
      const splitAt = normalized.search(/\r?\n\r?\n/);
      const headerSource = splitAt >= 0 ? normalized.slice(0, splitAt) : "";
      const partBody = splitAt >= 0 ? normalized.slice(splitAt).replace(/^\r?\n\r?\n/, "") : normalized;
      return extractMimeText(parseEmailHeaders(headerSource.replaceAll("\r\n", "\n")).values, partBody, diagnostics, state, depth + 1);
    });
  }
  if (!/^text\/(?:plain|html)/i.test(contentType)) {
    state.attachments += 1;
    return [];
  }
  const transfer = (headerValues.get("content-transfer-encoding") ?? "7bit").trim().toLowerCase();
  let payload = null;
  if (transfer === "base64") payload = decodeBase64Payload(body);
  else if (transfer === "quoted-printable") payload = decodeQuotedPrintablePayload(body);
  else if (!["7bit", "8bit", "binary", ""].includes(transfer)) {
    diagnostics.push({
      code: "UNSUPPORTED_MIME_ENCODING",
      severity: "error",
      message: `Email content-transfer-encoding '${transfer}' is not supported.`,
    });
    return [];
  }
  const charset = mimeParameter(contentType, "charset") ?? "utf-8";
  let text = payload ? decodeTextWithMetadata(payload, charset).text : body;
  if (/^text\/html/i.test(contentType)) {
    text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
    text = normalizeWhitespace(text);
    diagnostics.push({ code: "EML_HTML_SANITIZED", severity: "warning", message: "HTML email content was reduced to inert text." });
  }
  return paragraphBlocks(text).map((block) => block.text);
}

export function parseEml(bytes) {
  const decodedSource = decodeTextWithMetadata(bytes);
  const source = decodedSource.text.replaceAll("\r\n", "\n");
  const splitAt = source.indexOf("\n\n");
  const headerSource = splitAt >= 0 ? source.slice(0, splitAt) : source;
  const body = splitAt >= 0 ? source.slice(splitAt + 2) : "";
  const parsedHeaders = parseEmailHeaders(headerSource);
  const blocks = [];
  parsedHeaders.entries.forEach((entry) => {
    blocks.push({
      kind: "email-header",
      text: entry.value,
      locator: { header: entry.name, line: entry.line },
    });
  });
  const diagnostics = [...decodedSource.diagnostics];
  const state = { parts: 0, attachments: 0 };
  const bodyParagraphs = extractMimeText(parsedHeaders.values, body, diagnostics, state);
  blocks.push(...bodyParagraphs.map((text, index) => ({ kind: "paragraph", text, locator: { bodyParagraph: index + 1 } })));
  if (state.attachments || /content-disposition:\s*attachment/i.test(source)) {
    diagnostics.push({
      code: "EML_ATTACHMENTS_REQUIRE_SEPARATE_IMPORT",
      severity: "warning",
      message: "Email attachments are not trusted implicitly and should be imported as separate files.",
      details: { count: Math.max(state.attachments, 1) },
    });
  }
  return { blocks, diagnostics };
}
