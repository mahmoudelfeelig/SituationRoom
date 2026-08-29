import { ERROR_CODES, SituationRoomError } from "../../kernel/errors.js";

function unionBox(items) {
  const boxes = items.map((item) => {
    const x = item.transform?.[4] ?? 0;
    const y = item.transform?.[5] ?? 0;
    return { x, y, width: item.width ?? 0, height: item.height ?? 0 };
  });
  return {
    x: Math.min(...boxes.map((box) => box.x)),
    y: Math.min(...boxes.map((box) => box.y)),
    width: Math.max(...boxes.map((box) => box.x + box.width)) - Math.min(...boxes.map((box) => box.x)),
    height: Math.max(...boxes.map((box) => box.y + box.height)) - Math.min(...boxes.map((box) => box.y)),
  };
}

function linesFromTextItems(items, pageNumber) {
  const lines = [];
  let current = [];
  let currentY = null;
  const flush = () => {
    if (!current.length) return;
    const text = current.map((entry) => entry.item.str).join(" ").replace(/\s+/g, " ").trim();
    if (text) {
      lines.push({
        kind: "paragraph",
        text,
        locator: {
          page: pageNumber,
          textItems: [current[0].index + 1, current.at(-1).index + 1],
          boundingBox: unionBox(current.map((entry) => entry.item)),
        },
      });
    }
    current = [];
    currentY = null;
  };
  items.forEach((item, index) => {
    if (!item?.str?.trim()) return;
    const y = item.transform?.[5] ?? 0;
    if (currentY !== null && Math.abs(y - currentY) > Math.max(2, (item.height ?? 0) * 0.5)) flush();
    current.push({ item, index });
    currentY = y;
    if (item.hasEOL) flush();
  });
  flush();
  return lines;
}

export async function parsePdf(bytes, options = {}) {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: bytes.slice(),
      password: options.password,
      disableWorker: true,
      isEvalSupported: false,
      useSystemFonts: true,
      stopAtErrors: false,
    });
    const pdf = await loadingTask.promise;
    if (pdf.numPages > (options.maxPages ?? 1_000)) {
      await loadingTask.destroy();
      throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "PDF exceeds the safe page limit.");
    }
    const blocks = [];
    const diagnostics = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (options.signal?.aborted) {
        await loadingTask.destroy();
        throw new SituationRoomError(ERROR_CODES.IMPORT_CANCELED, "PDF import was canceled.");
      }
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      blocks.push(...linesFromTextItems(content.items, pageNumber));
      page.cleanup();
      options.onProgress?.(pageNumber / pdf.numPages);
    }
    const attachments = await pdf.getAttachments().catch(() => null);
    if (attachments && Object.keys(attachments).length) {
      diagnostics.push({
        code: "PDF_ATTACHMENTS_REQUIRE_SEPARATE_IMPORT",
        severity: "warning",
        message: "Embedded PDF attachments were not trusted or imported automatically.",
        details: { count: Object.keys(attachments).length },
      });
    }
    const actions = await pdf.getJSActions().catch(() => null);
    if (actions && Object.keys(actions).length) {
      diagnostics.push({
        code: "PDF_JAVASCRIPT_IGNORED",
        severity: "warning",
        message: "Embedded PDF JavaScript was ignored.",
      });
    }
    if (!blocks.length) {
      diagnostics.push({
        code: "PDF_OCR_REQUIRED",
        severity: "warning",
        message: "The PDF contains no extractable text; import its scanned pages as images for OCR.",
      });
    }
    const metadata = await pdf.getMetadata().catch(() => null);
    await loadingTask.destroy();
    return {
      blocks,
      diagnostics,
      metadata: { pageCount: pdf.numPages, info: metadata?.info ?? null },
    };
  } catch (error) {
    if (error instanceof SituationRoomError) throw error;
    if (/password/i.test(error?.name ?? "") || [1, 2].includes(error?.code)) {
      throw new SituationRoomError(ERROR_CODES.QUARANTINED, "Encrypted PDF requires an explicitly decrypted source.", {
        diagnosticCode: "ENCRYPTED_DOCUMENT",
      });
    }
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "PDF parsing failed.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
