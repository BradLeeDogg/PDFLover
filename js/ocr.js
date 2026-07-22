/* ==========================================================================
   PDFLover OCR — recognize text in scanned pages with Tesseract.js.
   Everything (engine, wasm core, English model) is vendored, so OCR runs
   fully offline. Recognized words are stored per page in display-space
   coordinates, feed the Ctrl+F search index, and are baked into exports as
   an invisible text layer, turning scans into searchable PDFs.
   ========================================================================== */
"use strict";

const OCR_SCALE = 2;          // render pages at 144 dpi for recognition
const OCR_MIN_CONFIDENCE = 35;

let ocrWorkerPromise = null;

function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = Tesseract.createWorker("eng", 1, {
      workerPath: "vendor/tesseract/worker.min.js",
      corePath: "vendor/tesseract",
      langPath: "vendor/tessdata",
    }).catch((e) => {
      ocrWorkerPromise = null;   // allow retry
      throw e;
    });
  }
  return ocrWorkerPromise;
}

/** Plain page bitmap (no user annotations) for recognition. */
async function renderPageBitmapForOcr(page, scale) {
  const { w, h } = displayDims(page);
  const cv = document.createElement("canvas");
  cv.width = Math.round(w * scale);
  cv.height = Math.round(h * scale);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (page.src) {
    const proxy = state.sources[page.src.s].proxies[page.src.p];
    const vp = proxy.getViewport({ scale, rotation: totalRot(page) });
    await proxy.render({ canvasContext: ctx, viewport: vp }).promise;
  }
  return cv;
}

/** Flatten tesseract's blocks tree (v6+/v7 output shape) into words. */
function collectOcrWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const words = [];
  for (const block of data.blocks || []) {
    for (const par of block.paragraphs || []) {
      for (const line of par.lines || []) {
        for (const word of line.words || []) words.push(word);
      }
    }
  }
  return words;
}

async function ocrDocument() {
  const targets = state.pages
    .map((page, i) => ({ page, i }))
    .filter(({ page }) => page.src && !page.ocrWords);
  if (!targets.length) {
    toast(state.pages.some((p) => p.ocrWords)
      ? "All pages are already OCR'd — use Ctrl+F to search them"
      : "No imported pages to OCR (blank pages you created are already text)");
    return;
  }

  const progress = toast("Starting OCR engine…", { ms: 0 });
  const label = progress.querySelector("span");
  const btn = $("btnOcr");
  btn.disabled = true;
  try {
    const worker = await getOcrWorker();
    let totalWords = 0;
    for (let k = 0; k < targets.length; k++) {
      const { page, i } = targets[k];
      label.textContent = `OCR: recognizing page ${i + 1} (${k + 1} / ${targets.length})…`;
      const cv = await renderPageBitmapForOcr(page, OCR_SCALE);
      const { data } = await worker.recognize(cv, {}, { blocks: true, text: true });
      const words = [];
      for (const w of collectOcrWords(data)) {
        const text = (w.text || "").trim();
        if (!text || (w.confidence != null && w.confidence < OCR_MIN_CONFIDENCE)) continue;
        const b = w.bbox;
        if (!b) continue;
        words.push({
          t: text,
          x: b.x0 / OCR_SCALE,
          y: b.y0 / OCR_SCALE,
          w: Math.max(1, (b.x1 - b.x0) / OCR_SCALE),
          h: Math.max(1, (b.y1 - b.y0) / OCR_SCALE),
        });
      }
      page.ocrWords = words;
      totalWords += words.length;
    }
    state.dirty = true;
    scheduleAutosave();
    label.textContent = `OCR done: ${totalWords} word(s) recognized on ${targets.length} page(s). ` +
      "Ctrl+F now searches them; exports include an invisible text layer.";
    setTimeout(() => { progress.classList.add("out"); setTimeout(() => progress.remove(), 400); }, 7000);
  } catch (e) {
    console.error(e);
    label.textContent = "OCR failed: " + e.message;
    progress.classList.add("err");
    setTimeout(() => { progress.classList.add("out"); setTimeout(() => progress.remove(), 400); }, 8000);
  } finally {
    btn.disabled = false;
  }
}

/** Bake recognized words into the output page as invisible (but selectable
    and extractable) text. */
async function bakeOcrText(outDoc, outPage, page, fontCache, ovr) {
  const words = page.ocrWords;
  if (!words || !words.length) return;
  const mapPt = ovr ? ovr.mapPt : makePdfMapper(page);
  const R = ovr ? ovr.R : totalRot(page);
  const helvKey = "Helvetica|0|0";
  if (!fontCache.has(helvKey)) fontCache.set(helvKey, await outDoc.embedFont(StandardFonts.Helvetica));
  const font = fontCache.get(helvKey);
  for (const word of words) {
    const text = sanitizeWinAnsi(word.t);
    if (!text) continue;
    const size = clamp(word.h * 0.95, 4, 72);
    const [px, py] = mapPt(word.x, word.y + word.h * 0.8);
    outPage.drawText(text, { x: px, y: py, size, font, opacity: 0, rotate: degrees(R) });
  }
}
