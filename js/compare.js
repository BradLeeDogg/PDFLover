/* ==========================================================================
   PDFLover compare — diff two PDFs entirely in the browser.
   Per page: a pixel-level visual diff (green = added, red = removed) and a
   word-level text diff. Self-contained; does not touch editor state.
   ========================================================================== */
"use strict";

(function () {
  const $c = (id) => document.getElementById(id);

  const CMP_SCALE = 1.5;
  const PIXEL_THRESHOLD = 60;    // per-channel luminance delta to count as changed
  const MAX_DIFF_WORDS = 6000;

  let lastResults = null;   // for export

  function status(msg, err) {
    const el = $c("cmpStatus");
    el.textContent = msg;
    el.style.color = err ? "#ff8598" : "";
  }

  async function loadDoc(file) {
    const buf = await readFileAsArrayBuffer(file);
    return pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  }

  async function renderToCanvas(page, w, h) {
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    const vp = page.getViewport({ scale: CMP_SCALE });
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return cv;
  }

  /** Overlay B (revised) with green where content was added and red where it
      was removed. Returns { canvas, changedRatio }. */
  function visualDiff(cvA, cvB, w, h) {
    const a = cvA.getContext("2d").getImageData(0, 0, w, h).data;
    const b = cvB.getContext("2d").getImageData(0, 0, w, h).data;
    const out = document.createElement("canvas");
    out.width = w; out.height = h;
    const octx = out.getContext("2d");
    const img = octx.createImageData(w, h);
    const o = img.data;
    let changed = 0;
    for (let i = 0; i < o.length; i += 4) {
      const lumA = (a[i] * 0.3 + a[i + 1] * 0.59 + a[i + 2] * 0.11);
      const lumB = (b[i] * 0.3 + b[i + 1] * 0.59 + b[i + 2] * 0.11);
      // Start from a faded version of the revised page.
      o[i] = 255 - (255 - b[i]) * 0.4;
      o[i + 1] = 255 - (255 - b[i + 1]) * 0.4;
      o[i + 2] = 255 - (255 - b[i + 2]) * 0.4;
      o[i + 3] = 255;
      if (Math.abs(lumA - lumB) > PIXEL_THRESHOLD) {
        changed++;
        if (lumB < lumA) { o[i] = 30; o[i + 1] = 170; o[i + 2] = 90; }        // added (B darker)
        else { o[i] = 220; o[i + 1] = 50; o[i + 2] = 70; }                    // removed (A darker)
      }
    }
    octx.putImageData(img, 0, 0);
    return { canvas: out, changedRatio: changed / (w * h) };
  }

  async function pageText(page) {
    const tc = await page.getTextContent();
    return tc.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
  }

  /** Word-level LCS diff -> array of { op: 'eq'|'add'|'del', word }. */
  function wordDiff(textA, textB) {
    const A = textA ? textA.split(" ") : [];
    const B = textB ? textB.split(" ") : [];
    if (A.length > MAX_DIFF_WORDS || B.length > MAX_DIFF_WORDS) {
      return { ops: null, added: 0, removed: 0, truncated: true };
    }
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0, added = 0, removed = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push({ op: "eq", word: A[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: "del", word: A[i] }); i++; removed++; }
      else { ops.push({ op: "add", word: B[j] }); j++; added++; }
    }
    while (i < n) { ops.push({ op: "del", word: A[i++] }); removed++; }
    while (j < m) { ops.push({ op: "add", word: B[j++] }); added++; }
    return { ops, added, removed, truncated: false };
  }

  function renderTextDiff(container, diff) {
    if (diff.truncated) {
      container.innerHTML = '<span class="none">Text too long to diff word-by-word.</span>';
      return;
    }
    if (!diff.ops.length) { container.innerHTML = '<span class="none">No text on this page.</span>'; return; }
    if (diff.added === 0 && diff.removed === 0) {
      container.innerHTML = '<span class="none">No text changes.</span>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const op of diff.ops) {
      if (op.op === "eq") { frag.appendChild(document.createTextNode(op.word + " ")); continue; }
      const span = document.createElement("span");
      span.className = op.op === "add" ? "cmp-add" : "cmp-del";
      span.textContent = op.word;
      frag.appendChild(span);
      frag.appendChild(document.createTextNode(" "));
    }
    container.innerHTML = "";
    container.appendChild(frag);
  }

  async function runCompare() {
    const fA = $c("cmpFileA").files[0];
    const fB = $c("cmpFileB").files[0];
    if (!fA || !fB) { status("Choose both an original and a revised PDF.", true); return; }
    $c("cmpGo").disabled = true;
    $c("cmpResults").innerHTML = "";
    $c("cmpSummary").classList.add("hidden");
    $c("cmpExportWrap").style.display = "none";
    lastResults = [];
    try {
      status("Loading…");
      const [docA, docB] = [await loadDoc(fA), await loadDoc(fB)];
      const maxPages = Math.max(docA.numPages, docB.numPages);
      let pagesChanged = 0, totalAdded = 0, totalRemoved = 0;

      for (let k = 0; k < maxPages; k++) {
        status(`Comparing page ${k + 1} / ${maxPages}…`);
        const hasA = k < docA.numPages, hasB = k < docB.numPages;
        const card = document.createElement("div");
        card.className = "cmp-page";
        const head = document.createElement("div");
        head.className = "cmp-page-head";
        card.appendChild(head);

        if (hasA && hasB) {
          const pA = await docA.getPage(k + 1);
          const pB = await docB.getPage(k + 1);
          const vpA = pA.getViewport({ scale: CMP_SCALE });
          const vpB = pB.getViewport({ scale: CMP_SCALE });
          const w = Math.round(Math.max(vpA.width, vpB.width));
          const h = Math.round(Math.max(vpA.height, vpB.height));
          const [cvA, cvB] = [await renderToCanvas(pA, w, h), await renderToCanvas(pB, w, h)];
          const { canvas, changedRatio } = visualDiff(cvA, cvB, w, h);
          const diff = wordDiff(await pageText(pA), await pageText(pB));
          const changed = changedRatio > 0.0003 || diff.added > 0 || diff.removed > 0;
          if (changed) pagesChanged++;
          totalAdded += diff.added; totalRemoved += diff.removed;

          head.innerHTML = `<span>Page ${k + 1}</span>` +
            (changed
              ? `<span class="cmp-changed">${(changedRatio * 100).toFixed(1)}% pixels changed · +${diff.added} / −${diff.removed} words</span>`
              : `<span class="cmp-same">Identical</span>`);
          const wrap = document.createElement("div");
          wrap.className = "cmp-canvas-wrap";
          canvas.style.width = Math.min(w, 900) + "px";
          wrap.appendChild(canvas);
          card.appendChild(wrap);
          const td = document.createElement("div");
          td.className = "cmp-textdiff";
          renderTextDiff(td, diff);
          card.appendChild(td);
          lastResults.push({ canvas, page: k + 1 });
        } else if (hasA) {
          head.innerHTML = `<span>Page ${k + 1}</span><span class="cmp-changed">Removed (only in original)</span>`;
          pagesChanged++;
          const pA = await docA.getPage(k + 1);
          const vp = pA.getViewport({ scale: CMP_SCALE });
          const cv = await renderToCanvas(pA, Math.round(vp.width), Math.round(vp.height));
          tintCanvas(cv, 220, 50, 70);
          const wrap = document.createElement("div");
          wrap.className = "cmp-canvas-wrap";
          cv.style.width = Math.min(cv.width, 900) + "px";
          wrap.appendChild(cv);
          card.appendChild(wrap);
          lastResults.push({ canvas: cv, page: k + 1 });
        } else {
          head.innerHTML = `<span>Page ${k + 1}</span><span class="cmp-changed">Added (only in revised)</span>`;
          pagesChanged++;
          const pB = await docB.getPage(k + 1);
          const vp = pB.getViewport({ scale: CMP_SCALE });
          const cv = await renderToCanvas(pB, Math.round(vp.width), Math.round(vp.height));
          tintCanvas(cv, 30, 170, 90);
          const wrap = document.createElement("div");
          wrap.className = "cmp-canvas-wrap";
          cv.style.width = Math.min(cv.width, 900) + "px";
          wrap.appendChild(cv);
          card.appendChild(wrap);
          lastResults.push({ canvas: cv, page: k + 1 });
        }
        $c("cmpResults").appendChild(card);
      }

      const sum = $c("cmpSummary");
      sum.innerHTML =
        `<span><b>${pagesChanged}</b> of <b>${maxPages}</b> page(s) changed</span>` +
        `<span class="cmp-chip"><span class="dot" style="background:#1eaa5a"></span> <b>+${totalAdded}</b> words added</span>` +
        `<span class="cmp-chip"><span class="dot" style="background:#dc3246"></span> <b>−${totalRemoved}</b> words removed</span>`;
      sum.classList.remove("hidden");
      status(pagesChanged ? "" : "The documents are identical.");
      if (lastResults.length) $c("cmpExportWrap").style.display = "";
      docA.destroy(); docB.destroy();
    } catch (e) {
      console.error(e);
      status("Compare failed: " + e.message, true);
    } finally {
      $c("cmpGo").disabled = false;
    }
  }

  function tintCanvas(cv, r, g, b) {
    const ctx = cv.getContext("2d");
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  async function exportDiff() {
    if (!lastResults || !lastResults.length) return;
    try {
      status("Building diff PDF…");
      const doc = await PDFDocument.create();
      doc.setProducer("PDFLover");
      for (const r of lastResults) {
        const img = await doc.embedJpg(dataUrlToBytes(r.canvas.toDataURL("image/jpeg", 0.9)));
        const p = doc.addPage([img.width, img.height]);
        p.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      }
      downloadBytes(await doc.save(), "comparison.pdf", "application/pdf");
      status("Downloaded comparison.pdf");
    } catch (e) {
      console.error(e);
      status("Export failed: " + e.message, true);
    }
  }

  // Exposed for headless testing.
  window.__compare = { wordDiff, visualDiff };

  window.addEventListener("DOMContentLoaded", () => {
    $c("btnCompare").addEventListener("click", () => {
      $c("compareModal").classList.remove("hidden");
    });
    $c("cmpGo").addEventListener("click", runCompare);
    $c("cmpExport").addEventListener("click", exportDiff);
  });
})();
