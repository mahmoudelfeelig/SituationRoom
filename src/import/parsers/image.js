import { ERROR_CODES, SituationRoomError } from "../../kernel/errors.js";

function defaultLanguagePath() {
  const trainedData = new URL(
    "../../../node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
    import.meta.url,
  );
  if (globalThis.process?.versions?.node) {
    let path = decodeURIComponent(trainedData.pathname);
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    return path.slice(0, path.lastIndexOf("/"));
  }
  if (import.meta.env?.DEV) {
    return trainedData.href.slice(0, trainedData.href.lastIndexOf("/"));
  }
  return new URL("./ocr/4.0.0_best_int/", trainedData).href.replace(/\/$/, "");
}

function defaultBrowserWorkerPath() {
  return new URL("../../../node_modules/tesseract.js/dist/worker.min.js", import.meta.url).href;
}

function defaultBrowserCorePath() {
  return new URL("../../../node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js", import.meta.url).href;
}

function imageInput(bytes, mimeType) {
  if (globalThis.Buffer && typeof globalThis.process !== "undefined") {
    return globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Blob([bytes], { type: mimeType || "application/octet-stream" });
}

export async function parseImageOcr(bytes, options = {}) {
  let worker;
  const diagnostics = [
    {
      code: "OCR_REQUIRES_REVIEW",
      severity: "warning",
      message: "OCR text is probabilistic; low-confidence regions must be checked against the image.",
    },
  ];
  try {
    const { createWorker, OEM } = await import("tesseract.js");
    const isNode = Boolean(globalThis.process?.versions?.node);
    worker = await createWorker(options.language ?? "eng", OEM?.LSTM_ONLY ?? 1, {
      langPath: options.langPath ?? defaultLanguagePath(),
      ...(!isNode || options.workerPath ? { workerPath: options.workerPath ?? defaultBrowserWorkerPath() } : {}),
      ...(!isNode || options.corePath ? { corePath: options.corePath ?? defaultBrowserCorePath() } : {}),
      logger(message) {
        if (message.status === "recognizing text") options.onProgress?.(message.progress);
      },
    });
    if (options.signal?.aborted) throw new SituationRoomError(ERROR_CODES.IMPORT_CANCELED, "OCR import was canceled.");
    const abort = () => worker?.terminate();
    options.signal?.addEventListener("abort", abort, { once: true });
    const result = await worker.recognize(
      imageInput(bytes, options.mimeType),
      { rotateAuto: true },
      { text: true, blocks: true },
    );
    options.signal?.removeEventListener("abort", abort);
    if (options.signal?.aborted) throw new SituationRoomError(ERROR_CODES.IMPORT_CANCELED, "OCR import was canceled.");
    const blocks = (result.data.blocks ?? []).
      map((block, index) => ({
        kind: "ocr-region",
        text: block.text.trim(),
        confidence: Math.max(0, Math.min(1, block.confidence / 100)),
        locator: { region: index + 1, boundingBox: block.bbox },
        metadata: { blockType: block.blocktype },
      }))
      .filter((block) => block.text);
    if (!blocks.length && result.data.text?.trim()) {
      blocks.push({
        kind: "ocr-region",
        text: result.data.text.trim(),
        confidence: Math.max(0, Math.min(1, result.data.confidence / 100)),
        locator: { region: 1, wholeImage: true },
      });
    }
    if (!blocks.length) {
      diagnostics.push({ code: "NO_EXTRACTABLE_TEXT", severity: "warning", message: "OCR found no text." });
    }
    return {
      blocks,
      diagnostics,
      metadata: {
        language: options.language ?? "eng",
        meanConfidence: result.data.confidence / 100,
        rotationRadians: result.data.rotateRadians,
      },
    };
  } catch (error) {
    if (error instanceof SituationRoomError) throw error;
    throw new SituationRoomError(ERROR_CODES.VALIDATION_FAILED, "Image OCR failed.", {
      diagnosticCode: "OCR_FAILED",
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await worker?.terminate().catch(() => undefined);
  }
}
