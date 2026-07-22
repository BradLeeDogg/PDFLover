/* ==========================================================================
   PDFLover converter suite — all conversions run locally in the browser.
   ========================================================================== */
"use strict";

// ------------------------------------------------------------ conversions ----

/** Combine images into a PDF; each image becomes one page at its pixel size. */
async function convertImagesToPdf(files) {
  const doc = await PDFDocument.create();
  doc.setProducer("PDFLover");
  for (const file of files) {
    let dataUrl = await readFileAsDataURL(file);
    let embedded;
    if (file.type === "image/jpeg") {
      embedded = await doc.embedJpg(dataUrlToBytes(dataUrl));
    } else if (file.type === "image/png") {
      embedded = await doc.embedPng(dataUrlToBytes(dataUrl));
    } else {
      // Normalize other formats (e.g. WebP) through a canvas.
      const img = await loadImageFromDataURL(dataUrl);
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      cv.getContext("2d").drawImage(img, 0, 0);
      embedded = await doc.embedPng(dataUrlToBytes(cv.toDataURL("image/png")));
    }
    const page = doc.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  }
  return doc.save();
}

/** Render every page of a PDF to images, returned as a ZIP blob. */
async function convertPdfToImages(bytes, fmt, scale, baseName, onProgress) {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const zip = new JSZip();
  const mime = fmt === "jpeg" ? "image/jpeg" : "image/png";
  const ext = fmt === "jpeg" ? "jpg" : "png";
  const pad = String(doc.numPages).length;
  for (let i = 1; i <= doc.numPages; i++) {
    if (onProgress) onProgress(`Rendering page ${i} / ${doc.numPages}…`);
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale });
    const cv = document.createElement("canvas");
    cv.width = Math.round(vp.width);
    cv.height = Math.round(vp.height);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await new Promise((res) => cv.toBlob(res, mime, 0.92));
    zip.file(`${baseName}-page-${String(i).padStart(pad, "0")}.${ext}`, blob);
  }
  doc.destroy();
  return zip.generateAsync({ type: "blob" });
}

/** Extract text from every page of a PDF. */
async function convertPdfToText(bytes) {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const parts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    let lastY = null;
    for (const item of content.items) {
      if (lastY !== null && Math.abs(item.transform[5] - lastY) > 2) text += "\n";
      else if (text && !text.endsWith("\n") && !text.endsWith(" ") && item.str && !item.str.startsWith(" ")) text += " ";
      text += item.str;
      lastY = item.transform[5];
    }
    parts.push(text.trim());
    doc.numPages > 1 && parts.push("");   // blank line between pages
  }
  doc.destroy();
  return parts.join("\n").trim() + "\n";
}

/** Turn plain text into a paginated Letter PDF with word wrap. */
async function convertTextToPdf(text) {
  const doc = await PDFDocument.create();
  doc.setProducer("PDFLover");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 11;
  const lineH = size * 1.4;
  const [W, H] = PAGE_SIZES.letter;
  const margin = 56;
  const maxWidth = W - margin * 2;

  const wrapLine = (line) => {
    if (font.widthOfTextAtSize(line, size) <= maxWidth) return [line];
    const words = line.split(" ");
    const out = [];
    let cur = "";
    for (let word of words) {
      // Hard-break single words wider than the page.
      while (font.widthOfTextAtSize(word, size) > maxWidth) {
        let cut = word.length;
        while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > maxWidth) cut--;
        if (cur) { out.push(cur); cur = ""; }
        out.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const trial = cur ? cur + " " + word : word;
      if (font.widthOfTextAtSize(trial, size) <= maxWidth) cur = trial;
      else { out.push(cur); cur = word; }
    }
    if (cur) out.push(cur);
    return out.length ? out : [""];
  };

  const lines = sanitizeWinAnsi(text.replace(/\r\n?/g, "\n")).split("\n").flatMap(wrapLine);
  let page = null;
  let y = 0;
  for (const line of lines) {
    if (!page || y < margin) {
      page = doc.addPage([W, H]);
      y = H - margin;
    }
    if (line) page.drawText(line, { x: margin, y: y - size, size, font, color: rgb(0.1, 0.1, 0.1) });
    y -= lineH;
  }
  if (!doc.getPageCount()) doc.addPage([W, H]);
  return doc.save();
}

/** Merge several PDFs into one. */
async function convertMergePdfs(fileBuffers) {
  const out = await PDFDocument.create();
  out.setProducer("PDFLover");
  for (const bytes of fileBuffers) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach((p) => out.addPage(p));
  }
  return out.save();
}

/** Parse "1-3, 5, 7-9" into an array of zero-based index arrays. */
function parsePageRanges(text, pageCount) {
  const trimmed = text.trim();
  if (!trimmed) return Array.from({ length: pageCount }, (_, i) => [i]);
  const ranges = [];
  for (const part of trimmed.split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`Invalid range: "${part.trim()}"`);
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (a < 1 || b > pageCount || a > b) throw new Error(`Range "${part.trim()}" is outside 1-${pageCount}`);
    ranges.push(Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i));
  }
  return ranges;
}

/** Split a PDF into separate documents by page ranges. */
async function convertSplitPdf(bytes, rangesText) {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const ranges = parsePageRanges(rangesText, src.getPageCount());
  const results = [];
  for (const indices of ranges) {
    const out = await PDFDocument.create();
    out.setProducer("PDFLover");
    const copied = await out.copyPages(src, indices);
    copied.forEach((p) => out.addPage(p));
    const label = indices.length === 1
      ? `p${indices[0] + 1}`
      : `p${indices[0] + 1}-${indices[indices.length - 1] + 1}`;
    results.push({ label, bytes: await out.save() });
  }
  return results;
}

// ---------------------------------------------------------------- modal UI ----

(function wireConverter() {
  const $c = (id) => document.getElementById(id);
  const statusEl = $c("convStatus");

  function convStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.classList.toggle("err", !!isError);
  }

  // Card <-> pane switching.
  document.querySelectorAll(".conv-card").forEach((card) => {
    card.addEventListener("click", () => {
      const active = card.classList.contains("active");
      document.querySelectorAll(".conv-card").forEach((c) => c.classList.remove("active"));
      document.querySelectorAll(".conv-pane").forEach((p) => p.classList.add("hidden"));
      convStatus("");
      if (!active) {
        card.classList.add("active");
        $c(card.dataset.pane).classList.remove("hidden");
      }
    });
  });

  function baseName(file) {
    return file.name.replace(/\.[^.]+$/, "");
  }

  async function guarded(btn, fn) {
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      console.error(e);
      convStatus(e.message || String(e), true);
    } finally {
      btn.disabled = false;
    }
  }

  function closeModalIntoEditor() {
    $c("convModal").classList.add("hidden");
  }

  // ---- Images -> PDF ----
  const imgFiles = () => {
    const files = [...$c("convImgFiles").files];
    if (!files.length) throw new Error("Choose one or more images first");
    return files;
  };
  $c("convImg2PdfGo").addEventListener("click", (e) => guarded(e.target, async () => {
    convStatus("Converting…");
    const bytes = await convertImagesToPdf(imgFiles());
    downloadBytes(bytes, "images.pdf", "application/pdf");
    convStatus("Done — images.pdf downloaded");
  }));
  $c("convImg2PdfOpen").addEventListener("click", (e) => guarded(e.target, async () => {
    convStatus("Converting…");
    const bytes = await convertImagesToPdf(imgFiles());
    await openPdfBytes(new Uint8Array(bytes), "images.pdf");
    closeModalIntoEditor();
  }));

  // ---- PDF -> Images ----
  $c("convP2IGo").addEventListener("click", (e) => guarded(e.target, async () => {
    const file = $c("convP2IFile").files[0];
    if (!file) throw new Error("Choose a PDF first");
    const bytes = new Uint8Array(await readFileAsArrayBuffer(file));
    const fmt = $c("convP2IFmt").value;
    const scale = parseInt($c("convP2IScale").value, 10);
    const blob = await convertPdfToImages(bytes, fmt, scale, baseName(file), convStatus);
    downloadBytes(blob, baseName(file) + "-images.zip", "application/zip");
    convStatus("Done — ZIP downloaded");
  }));

  // ---- Text -> PDF ----
  const textInput = async () => {
    const file = $c("convT2PFile").files[0];
    if (file) return { text: await readFileAsText(file), name: baseName(file) + ".pdf" };
    const typed = $c("convT2PText").value;
    if (!typed.trim()) throw new Error("Choose a .txt file or type some text first");
    return { text: typed, name: "text.pdf" };
  };
  $c("convT2PGo").addEventListener("click", (e) => guarded(e.target, async () => {
    convStatus("Converting…");
    const { text, name } = await textInput();
    const bytes = await convertTextToPdf(text);
    downloadBytes(bytes, name, "application/pdf");
    convStatus(`Done — ${name} downloaded`);
  }));
  $c("convT2POpen").addEventListener("click", (e) => guarded(e.target, async () => {
    convStatus("Converting…");
    const { text, name } = await textInput();
    const bytes = await convertTextToPdf(text);
    await openPdfBytes(new Uint8Array(bytes), name);
    closeModalIntoEditor();
  }));

  // ---- PDF -> Text ----
  $c("convP2TGo").addEventListener("click", (e) => guarded(e.target, async () => {
    const file = $c("convP2TFile").files[0];
    if (!file) throw new Error("Choose a PDF first");
    convStatus("Extracting…");
    const bytes = new Uint8Array(await readFileAsArrayBuffer(file));
    const text = await convertPdfToText(bytes);
    downloadBytes(new Blob([text], { type: "text/plain" }), baseName(file) + ".txt", "text/plain");
    convStatus("Done — text downloaded");
  }));

  // ---- Merge ----
  const mergeBuffers = async () => {
    const files = [...$c("convMergeFiles").files];
    if (files.length < 2) throw new Error("Choose two or more PDFs first");
    const buffers = [];
    for (const f of files) buffers.push(new Uint8Array(await readFileAsArrayBuffer(f)));
    return buffers;
  };
  $c("convMergeGo").addEventListener("click", (e) => guarded(e.target, async () => {
    convStatus("Merging…");
    const bytes = await convertMergePdfs(await mergeBuffers());
    downloadBytes(bytes, "merged.pdf", "application/pdf");
    convStatus("Done — merged.pdf downloaded");
  }));
  $c("convMergeOpen").addEventListener("click", (e) => guarded(e.target, async () => {
    convStatus("Merging…");
    const bytes = await convertMergePdfs(await mergeBuffers());
    await openPdfBytes(new Uint8Array(bytes), "merged.pdf");
    closeModalIntoEditor();
  }));

  // ---- Split ----
  $c("convSplitGo").addEventListener("click", (e) => guarded(e.target, async () => {
    const file = $c("convSplitFile").files[0];
    if (!file) throw new Error("Choose a PDF first");
    convStatus("Splitting…");
    const bytes = new Uint8Array(await readFileAsArrayBuffer(file));
    const results = await convertSplitPdf(bytes, $c("convSplitRanges").value);
    if (results.length === 1) {
      downloadBytes(results[0].bytes, `${baseName(file)}-${results[0].label}.pdf`, "application/pdf");
    } else {
      const zip = new JSZip();
      for (const r of results) zip.file(`${baseName(file)}-${r.label}.pdf`, r.bytes);
      downloadBytes(await zip.generateAsync({ type: "blob" }), baseName(file) + "-split.zip", "application/zip");
    }
    convStatus(`Done — ${results.length} PDF(s) downloaded`);
  }));
})();
