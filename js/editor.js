/* ==========================================================================
   PDFLover editor engine
   --------------------------------------------------------------------------
   Object coordinates live in "display space": the page as currently shown
   (including rotation) at scale 1, origin top-left, y down, units = PDF
   points. On export each object is mapped back into PDF user space, so
   annotations land exactly where they appear on screen — including on
   rotated pages.
   ========================================================================== */
"use strict";

// ---------------------------------------------------------------- state ----

const state = {
  sources: [],      // { bytes: Uint8Array, pdfjs: PDFDocumentProxy, proxies: PDFPageProxy[], fields: [][] }
  pages: [],        // { id, src:{s,p}|null, blank:{w,h}|null, rot:0|90|180|270, objects:[] }
  current: 0,
  zoom: 1.25,
  tool: "select",
  selId: null,
  undoStack: [],
  redoStack: [],
  dirty: false,
  formValues: {},   // "sourceIndex:fieldName" -> string | boolean
};

// Defaults for newly created objects.
const props = {
  color: "#e33d3d",
  fill: "#ffe066",
  fillOn: false,
  width: 3,
  size: 16,
  font: "Helvetica",
  bold: false,
  italic: false,
  opacity: 1,
};

const HIGHLIGHT_OPACITY = 0.45;
const UNDO_LIMIT = 60;

const $ = (id) => document.getElementById(id);
const viewer = $("viewer");
const pageWrap = $("pageWrap");
const pageCanvas = $("pageCanvas");
const overlayCanvas = $("overlayCanvas");
const textEditor = $("textEditor");
const pageCtx = pageCanvas.getContext("2d");
const overlayCtx = overlayCanvas.getContext("2d");
const measureCtx = document.createElement("canvas").getContext("2d");

let renderSeq = 0;          // guards against stale async page renders
let renderTask = null;      // active pdf.js render task for the main canvas
let thumbSeq = 0;
let editingId = null;       // text object currently being edited
let whiteoutWarned = false; // one-time whiteout privacy note per session
let drag = null;            // active pointer interaction
let propSnap = null;        // pending undo snapshot for slider-style edits
const imageCache = new Map();      // dataUrl -> HTMLImageElement

// ------------------------------------------------------------- geometry ----

function curPage() { return state.pages[state.current]; }

/** Unrotated PDF-point dimensions of a page. */
function baseDims(page) {
  if (page.src) {
    const proxy = state.sources[page.src.s].proxies[page.src.p];
    const vp = proxy.getViewport({ scale: 1, rotation: 0 });
    return { w: vp.width, h: vp.height };
  }
  return { w: page.blank.w, h: page.blank.h };
}

/** Total display rotation (intrinsic + user) in degrees. */
function totalRot(page) {
  const intrinsic = page.src ? state.sources[page.src.s].proxies[page.src.p].rotate : 0;
  return ((intrinsic + page.rot) % 360 + 360) % 360;
}

/** Display-space dimensions (scale 1) of a page as currently rotated. */
function displayDims(page) {
  if (page.src) {
    const proxy = state.sources[page.src.s].proxies[page.src.p];
    const vp = proxy.getViewport({ scale: 1, rotation: totalRot(page) });
    return { w: vp.width, h: vp.height };
  }
  const { w, h } = baseDims(page);
  return totalRot(page) % 180 === 0 ? { w, h } : { w: h, h: w };
}

/** Map a display-space point to PDF user space for export. */
function makePdfMapper(page) {
  if (page.src) {
    const proxy = state.sources[page.src.s].proxies[page.src.p];
    const vp = proxy.getViewport({ scale: 1, rotation: totalRot(page) });
    return (dx, dy) => vp.convertToPdfPoint(dx, dy);
  }
  const { w: W, h: H } = baseDims(page);
  const R = totalRot(page);
  return (dx, dy) => {
    switch (R) {
      case 90: return [dy, dx];
      case 180: return [W - dx, dy];
      case 270: return [W - dy, H - dx];
      default: return [dx, H - dy];
    }
  };
}

// ------------------------------------------------------------ documents ----

async function addSource(bytes) {
  // pdf.js detaches the buffer it is given, so hand it a copy.
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const proxies = [];
  for (let i = 1; i <= doc.numPages; i++) proxies.push(await doc.getPage(i));
  const s = state.sources.length;

  // Detect fillable form fields (AcroForm widgets) on every page.
  const fields = [];
  for (const proxy of proxies) {
    const annots = await proxy.getAnnotations();
    fields.push(annots
      .filter((a) => a.subtype === "Widget" && a.fieldType && a.fieldName)
      .map((a) => ({
        name: a.fieldName,
        type: a.fieldType === "Tx" ? "text"
            : a.fieldType === "Ch" ? "choice"
            : a.checkBox ? "checkbox"
            : a.radioButton ? "radio"
            : "button",
        rect: a.rect,
        multiLine: !!a.multiLine,
        readOnly: !!a.readOnly,
        exportValue: a.exportValue != null ? a.exportValue : a.buttonValue,
        options: a.options || [],
        bg: a.backgroundColor ? [...a.backgroundColor] : null,
        border: a.borderColor ? [...a.borderColor] : null,
        fontSize: (a.defaultAppearanceData && a.defaultAppearanceData.fontSize) || 0,
        initial: a.fieldValue,
      })));
  }
  for (const list of fields) {
    for (const f of list) {
      const key = s + ":" + f.name;
      if (key in state.formValues) continue;
      if (f.type === "checkbox") state.formValues[key] = !!(f.initial && f.initial !== "Off");
      else if (f.type === "radio") state.formValues[key] = f.initial && f.initial !== "Off" ? String(f.initial) : "";
      else state.formValues[key] = f.initial != null ? String(f.initial) : "";
    }
  }

  // Probe whether pdf-lib can rebuild this document. Encrypted PDFs (common
  // for bank forms — they open without a password prompt) render fine in
  // pdf.js but pdf-lib cannot copy their pages; those sources are exported
  // as rendered page images instead.
  let unsupported = false;
  try {
    const probe = await PDFDocument.load(bytes, { ignoreEncryption: true });
    probe.getPages();
  } catch (e) {
    unsupported = true;
    console.warn("Source not editable by pdf-lib; will export as rendered pages:", e.message);
  }

  state.sources.push({ bytes, pdfjs: doc, proxies, fields, unsupported });

  if (doc.isPureXfa) {
    alert("This PDF is an XFA form (LiveCycle). XFA forms are not fully supported — pages may render incompletely.");
  } else if (unsupported) {
    toast("Protected PDF: exports will contain rendered page images. Fills and edits still work.", { ms: 7000 });
    setStatus("Protected PDF: exports will contain rendered page images (fills and edits still work)");
  }
  return s;
}

function pageFields(page) {
  if (!page || !page.src) return [];
  return (state.sources[page.src.s].fields[page.src.p] || []).filter((f) => f.type !== "button");
}

function fieldKey(page, f) { return page.src.s + ":" + f.name; }

function countFormFields() {
  let n = 0;
  for (const page of state.pages) n += pageFields(page).length;
  return n;
}

/** Display-space rect (scale 1, current rotation) of a form field widget. */
function fieldDisplayRect(page, f) {
  const proxy = state.sources[page.src.s].proxies[page.src.p];
  const vp = proxy.getViewport({ scale: 1, rotation: totalRot(page) });
  const [x1, y1, x2, y2] = vp.convertToViewportRectangle(f.rect);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

function blankPage(w, h) {
  return { id: uid(), src: null, blank: { w, h }, rot: 0, objects: [] };
}

function newDocument(sizeKey, orient) {
  let [w, h] = PAGE_SIZES[sizeKey] || PAGE_SIZES.letter;
  if (orient === "landscape") [w, h] = [h, w];
  state.sources = [];
  state.pages = [blankPage(w, h)];
  state.current = 0;
  state.selId = null;
  state.undoStack = [];
  state.redoStack = [];
  state.dirty = false;
  state.formValues = {};
  imageCache.clear();
  refreshAll();
}

async function openPdfBytes(bytes, name) {
  const s = await addSource(bytes);
  const src = state.sources[s];
  state.pages = src.proxies.map((_, p) => ({ id: uid(), src: { s, p }, blank: null, rot: 0, objects: [] }));
  state.current = 0;
  state.selId = null;
  state.undoStack = [];
  state.redoStack = [];
  state.dirty = false;
  if (name) $("docName").value = name.replace(/\.pdf$/i, "");
  refreshAll();
  const nFields = countFormFields();
  if (nFields) setStatus(`Fillable form detected: ${nFields} field(s) — click a field to fill it in`);
}

async function insertPdfBytes(bytes) {
  pushUndo();
  const s = await addSource(bytes);
  const src = state.sources[s];
  for (let p = 0; p < src.proxies.length; p++) {
    state.pages.push({ id: uid(), src: { s, p }, blank: null, rot: 0, objects: [] });
  }
  refreshAll();
  setStatus(`Appended ${src.proxies.length} page(s)`);
}

// ------------------------------------------------------------ undo/redo ----

function snapshot() {
  return JSON.stringify({ pages: state.pages, current: state.current, formValues: state.formValues });
}

function pushSnap(snap) {
  state.undoStack.push(snap);
  if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
  state.redoStack = [];
  state.dirty = true;
  updateUndoButtons();
  scheduleAutosave();
}

function pushUndo() { pushSnap(snapshot()); }

function restore(snap) {
  const data = JSON.parse(snap);
  state.pages = data.pages;
  if (data.formValues) state.formValues = data.formValues;
  state.current = clamp(data.current, 0, state.pages.length - 1);
  state.selId = null;
  closeTextEditor(false);
  refreshAll();
}

function undo() {
  if (!state.undoStack.length) return;
  state.redoStack.push(snapshot());
  restore(state.undoStack.pop());
  updateUndoButtons();
}

function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push(snapshot());
  restore(state.redoStack.pop());
  updateUndoButtons();
}

function updateUndoButtons() {
  $("btnUndo").disabled = !state.undoStack.length;
  $("btnRedo").disabled = !state.redoStack.length;
}

// ------------------------------------------------------------ rendering ----

function refreshAll() {
  clearSearchMatches();   // structural changes invalidate match positions
  renderPage();
  rebuildThumbs();
  updatePageLabel();
  updateUndoButtons();
  updatePropsPanel();
}

async function renderPage() {
  const page = curPage();
  if (!page) return;
  const seq = ++renderSeq;
  const dpr = window.devicePixelRatio || 1;
  const { w, h } = displayDims(page);
  const zoom = state.zoom;

  pageCanvas.width = Math.round(w * zoom * dpr);
  pageCanvas.height = Math.round(h * zoom * dpr);
  pageCanvas.style.width = w * zoom + "px";
  pageCanvas.style.height = h * zoom + "px";
  overlayCanvas.width = pageCanvas.width;
  overlayCanvas.height = pageCanvas.height;
  overlayCanvas.style.width = pageCanvas.style.width;
  overlayCanvas.style.height = pageCanvas.style.height;
  pageWrap.style.width = pageCanvas.style.width;
  pageWrap.style.height = pageCanvas.style.height;

  pageCtx.setTransform(1, 0, 0, 1, 0, 0);
  pageCtx.fillStyle = "#ffffff";
  pageCtx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

  if (page.src) {
    const proxy = state.sources[page.src.s].proxies[page.src.p];
    const vp = proxy.getViewport({ scale: zoom * dpr, rotation: totalRot(page) });
    if (renderTask) renderTask.cancel();
    // ENABLE_FORMS excludes form widget appearances; we draw live values ourselves.
    renderTask = proxy.render({ canvasContext: pageCtx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS });
    try {
      await renderTask.promise;
    } catch (e) {
      if (e && e.name !== "RenderingCancelledException") console.error(e);
    }
    if (seq !== renderSeq) return;
    renderTask = null;
  }
  renderOverlay();
}

function renderOverlay() {
  const page = curPage();
  if (!page) return;
  const dpr = window.devicePixelRatio || 1;
  const s = state.zoom * dpr;
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  overlayCtx.setTransform(s, 0, 0, s, 0, 0);
  drawFormFields(overlayCtx, page);
  drawObjects(overlayCtx, page, editingId);
  drawSearchHighlights(overlayCtx);
  drawSelection(overlayCtx, page);
}

/** Full render of one page (background + form fields + objects) at a given
    scale — shared by thumbnails and printing. */
async function renderPageComposite(page, scale) {
  const { w, h } = displayDims(page);
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w * scale));
  cv.height = Math.max(1, Math.round(h * scale));
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (page.src) {
    const proxy = state.sources[page.src.s].proxies[page.src.p];
    const vp = proxy.getViewport({ scale, rotation: totalRot(page) });
    try {
      await proxy.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS }).promise;
    } catch (e) { /* cancelled */ }
  }
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawFormFields(ctx, page);
  drawObjects(ctx, page, null);
  return cv;
}

// ---------------------------------------------------------- form fields ----

function drawFormFields(ctx, page) {
  const fields = pageFields(page);
  for (const f of fields) {
    const r = fieldDisplayRect(page, f);
    const v = state.formValues[fieldKey(page, f)];
    ctx.save();
    // Field background: the widget's own color, or a soft tint so fillable
    // areas are visible.
    ctx.fillStyle = f.bg ? `rgb(${f.bg[0]},${f.bg[1]},${f.bg[2]})` : "rgba(79,140,255,0.08)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    if (f.border) {
      ctx.strokeStyle = `rgb(${f.border[0]},${f.border[1]},${f.border[2]})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }

    if (f.type === "checkbox" || f.type === "radio") {
      const checked = f.type === "checkbox" ? v === true : v === String(f.exportValue);
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const s = Math.min(r.w, r.h);
      ctx.strokeStyle = "#333";
      ctx.lineWidth = Math.max(1, s * 0.08);
      if (f.type === "radio") {
        ctx.beginPath(); ctx.arc(cx, cy, s * 0.38, 0, Math.PI * 2); ctx.stroke();
        if (checked) { ctx.fillStyle = "#111"; ctx.beginPath(); ctx.arc(cx, cy, s * 0.2, 0, Math.PI * 2); ctx.fill(); }
      } else if (checked) {
        ctx.strokeStyle = "#111";
        ctx.lineWidth = Math.max(1.5, s * 0.14);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(r.x + r.w * 0.22, cy);
        ctx.lineTo(cx - s * 0.05, r.y + r.h * 0.72);
        ctx.lineTo(r.x + r.w * 0.8, r.y + r.h * 0.28);
        ctx.stroke();
      }
    } else {
      const text = v != null ? String(v) : "";
      if (text) {
        const fs = f.fontSize || Math.min(Math.max(r.h * 0.55, 7), 13);
        ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
        ctx.fillStyle = "#111";
        ctx.font = `${fs}px Helvetica, Arial, sans-serif`;
        ctx.textBaseline = "alphabetic";
        const pad = 2.5;
        if (f.multiLine) {
          text.split("\n").forEach((line, i) => ctx.fillText(line, r.x + pad, r.y + pad + (i + 0.85) * fs * 1.2));
        } else {
          ctx.fillText(text.replace(/\n/g, " "), r.x + pad, r.y + r.h / 2 + fs * 0.36);
        }
      }
      if (f.type === "choice") {
        // small dropdown arrow
        ctx.fillStyle = "#667";
        const ax = r.x + r.w - 10, ay = r.y + r.h / 2 - 1.5;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + 7, ay); ctx.lineTo(ax + 3.5, ay + 4.5); ctx.fill();
      }
    }
    ctx.restore();
  }
}

function hitField(page, dx, dy) {
  const fields = pageFields(page);
  for (let i = fields.length - 1; i >= 0; i--) {
    const r = fieldDisplayRect(page, fields[i]);
    if (dx >= r.x && dx <= r.x + r.w && dy >= r.y && dy <= r.y + r.h) return fields[i];
  }
  return null;
}

function fontString(o, scale = 1) {
  return `${o.italic ? "italic " : ""}${o.bold ? "700 " : "400 "}${o.size * scale}px ${cssFontFamily(o.font)}`;
}

function getCachedImage(o) {
  let img = imageCache.get(o.dataUrl);
  if (!img) {
    img = new Image();
    img.onload = () => { renderOverlay(); scheduleThumb(); };
    img.src = o.dataUrl;
    imageCache.set(o.dataUrl, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

function drawObjects(ctx, page, skipId) {
  for (const o of page.objects) {
    if (o.id === skipId) continue;
    ctx.save();
    switch (o.type) {
      case "text": {
        ctx.globalAlpha = o.opacity;
        ctx.fillStyle = o.color;
        ctx.font = fontString(o);
        ctx.textBaseline = "alphabetic";
        const lh = o.size * 1.25;
        o.text.split("\n").forEach((line, i) => {
          ctx.fillText(line, o.x, o.y + i * lh + o.size * 0.8);
        });
        break;
      }
      case "image": {
        const img = getCachedImage(o);
        if (img) {
          ctx.globalAlpha = o.opacity;
          ctx.drawImage(img, o.x, o.y, o.w, o.h);
        }
        break;
      }
      case "rect": {
        ctx.globalAlpha = o.opacity;
        if (o.fill) { ctx.fillStyle = o.fill; ctx.fillRect(o.x, o.y, o.w, o.h); }
        ctx.strokeStyle = o.color;
        ctx.lineWidth = o.sw;
        ctx.strokeRect(o.x, o.y, o.w, o.h);
        break;
      }
      case "ellipse": {
        ctx.globalAlpha = o.opacity;
        ctx.beginPath();
        ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, Math.max(o.w / 2, 0.1), Math.max(o.h / 2, 0.1), 0, 0, Math.PI * 2);
        if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); }
        ctx.strokeStyle = o.color;
        ctx.lineWidth = o.sw;
        ctx.stroke();
        break;
      }
      case "highlight": {
        ctx.globalAlpha = o.opacity;
        ctx.globalCompositeOperation = "multiply";
        ctx.fillStyle = o.color;
        ctx.fillRect(o.x, o.y, o.w, o.h);
        break;
      }
      case "whiteout": {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(o.x, o.y, o.w, o.h);
        break;
      }
      case "line":
      case "arrow": {
        ctx.globalAlpha = o.opacity;
        ctx.strokeStyle = o.color;
        ctx.lineWidth = o.sw;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(o.x1, o.y1);
        ctx.lineTo(o.x2, o.y2);
        ctx.stroke();
        if (o.type === "arrow") {
          for (const [hx, hy] of arrowHead(o)) {
            ctx.beginPath();
            ctx.moveTo(o.x2, o.y2);
            ctx.lineTo(hx, hy);
            ctx.stroke();
          }
        }
        break;
      }
      case "draw": {
        if (o.points.length < 2) break;
        ctx.globalAlpha = o.opacity;
        ctx.strokeStyle = o.color;
        ctx.lineWidth = o.sw;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(o.points[0].x, o.points[0].y);
        for (let i = 1; i < o.points.length; i++) ctx.lineTo(o.points[i].x, o.points[i].y);
        ctx.stroke();
        break;
      }
    }
    ctx.restore();
  }
}

function arrowHead(o) {
  const ang = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
  const len = Math.max(10, o.sw * 3.5);
  const spread = Math.PI * (150 / 180);
  return [
    [o.x2 + len * Math.cos(ang - spread), o.y2 + len * Math.sin(ang - spread)],
    [o.x2 + len * Math.cos(ang + spread), o.y2 + len * Math.sin(ang + spread)],
  ];
}

// ------------------------------------------------------------ selection ----

function objBounds(o) {
  if (o.type === "line" || o.type === "arrow") {
    const pad = o.sw / 2 + 2;
    return {
      x: Math.min(o.x1, o.x2) - pad, y: Math.min(o.y1, o.y2) - pad,
      w: Math.abs(o.x2 - o.x1) + pad * 2, h: Math.abs(o.y2 - o.y1) + pad * 2,
    };
  }
  if (o.type === "draw") {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of o.points) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const pad = o.sw / 2 + 2;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

function selectedObj() {
  const page = curPage();
  return page ? page.objects.find((o) => o.id === state.selId) || null : null;
}

/** Handle positions in display space for the selected object. */
function handlePositions(o) {
  if (o.type === "line" || o.type === "arrow") {
    return [{ k: "p1", x: o.x1, y: o.y1 }, { k: "p2", x: o.x2, y: o.y2 }];
  }
  const b = objBounds(o);
  const corners = [
    { k: "nw", x: b.x, y: b.y }, { k: "ne", x: b.x + b.w, y: b.y },
    { k: "se", x: b.x + b.w, y: b.y + b.h }, { k: "sw", x: b.x, y: b.y + b.h },
  ];
  if (o.type === "text" || o.type === "draw") return corners;   // corner-scale only
  return corners.concat([
    { k: "n", x: b.x + b.w / 2, y: b.y }, { k: "s", x: b.x + b.w / 2, y: b.y + b.h },
    { k: "w", x: b.x, y: b.y + b.h / 2 }, { k: "e", x: b.x + b.w, y: b.y + b.h / 2 },
  ]);
}

function drawSelection(ctx, page) {
  const o = page.objects.find((x) => x.id === state.selId);
  if (!o || o.id === editingId) return;
  const b = objBounds(o);
  const z = state.zoom;
  ctx.save();
  ctx.strokeStyle = "#4f8cff";
  ctx.lineWidth = 1.5 / z;
  ctx.setLineDash([4 / z, 3 / z]);
  ctx.strokeRect(b.x, b.y, b.w, b.h);
  ctx.setLineDash([]);
  const hs = 8 / z;
  for (const hp of handlePositions(o)) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(hp.x - hs / 2, hp.y - hs / 2, hs, hs);
    ctx.strokeRect(hp.x - hs / 2, hp.y - hs / 2, hs, hs);
  }
  ctx.restore();
}

function hitHandle(o, dx, dy) {
  const tol = 7 / state.zoom;
  for (const hp of handlePositions(o)) {
    if (Math.abs(dx - hp.x) <= tol && Math.abs(dy - hp.y) <= tol) return hp.k;
  }
  return null;
}

function hitObject(page, dx, dy) {
  for (let i = page.objects.length - 1; i >= 0; i--) {
    const b = objBounds(page.objects[i]);
    if (dx >= b.x && dx <= b.x + b.w && dy >= b.y && dy <= b.y + b.h) return page.objects[i];
  }
  return null;
}

// --------------------------------------------------------- interactions ----

function eventPoint(e) {
  const rect = overlayCanvas.getBoundingClientRect();
  return { x: (e.clientX - rect.left) / state.zoom, y: (e.clientY - rect.top) / state.zoom };
}

overlayCanvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const page = curPage();
  if (!page) return;
  if (editingId) { closeTextEditor(true); return; }
  const { x, y } = eventPoint(e);
  overlayCanvas.setPointerCapture(e.pointerId);
  const snap = snapshot();

  if (state.tool === "select") {
    const sel = selectedObj();
    if (sel) {
      const hk = hitHandle(sel, x, y);
      if (hk) {
        drag = { mode: "resize", handle: hk, obj: sel, startX: x, startY: y, orig: JSON.parse(JSON.stringify(sel)), snap };
        return;
      }
    }
    const hit = hitObject(page, x, y);
    if (hit) {
      state.selId = hit.id;
      drag = { mode: "move", obj: hit, startX: x, startY: y, orig: JSON.parse(JSON.stringify(hit)), snap };
    } else {
      state.selId = null;
      drag = null;
      const f = hitField(page, x, y);
      if (f && !f.readOnly) {
        const key = fieldKey(page, f);
        if (f.type === "checkbox") {
          pushSnap(snap);
          state.formValues[key] = !state.formValues[key];
        } else if (f.type === "radio") {
          pushSnap(snap);
          state.formValues[key] = String(f.exportValue);
        } else if (f.type === "choice" && f.options.length) {
          openChoiceEditor(page, f);
        } else {
          e.preventDefault();
          openFieldEditor(page, f);
        }
        renderOverlay();
        scheduleThumb();
        updatePropsPanel();
        return;
      }
    }
    updatePropsPanel();
    renderOverlay();
    return;
  }

  if (state.tool === "text") {
    // Stop the default mousedown focus change from instantly blurring the editor.
    e.preventDefault();
    const o = {
      id: uid(), type: "text", x, y: y - props.size * 0.6, text: "",
      size: props.size, font: props.font, bold: props.bold, italic: props.italic,
      color: props.color, opacity: props.opacity, w: 10, h: props.size * 1.25,
    };
    page.objects.push(o);
    state.selId = o.id;
    drag = null;
    openTextEditor(o, snap);
    return;
  }

  if (state.tool === "draw") {
    const o = { id: uid(), type: "draw", points: [{ x, y }], color: props.color, sw: props.width, opacity: props.opacity };
    page.objects.push(o);
    drag = { mode: "drawing", obj: o, snap };
    return;
  }

  // Drag-to-create shapes.
  let o = null;
  if (state.tool === "rect") {
    o = { id: uid(), type: "rect", x, y, w: 0, h: 0, color: props.color, fill: props.fillOn ? props.fill : null, sw: props.width, opacity: props.opacity };
  } else if (state.tool === "ellipse") {
    o = { id: uid(), type: "ellipse", x, y, w: 0, h: 0, color: props.color, fill: props.fillOn ? props.fill : null, sw: props.width, opacity: props.opacity };
  } else if (state.tool === "highlight") {
    o = { id: uid(), type: "highlight", x, y, w: 0, h: 0, color: "#ffe066", opacity: HIGHLIGHT_OPACITY };
  } else if (state.tool === "whiteout") {
    o = { id: uid(), type: "whiteout", x, y, w: 0, h: 0 };
  } else if (state.tool === "line" || state.tool === "arrow") {
    o = { id: uid(), type: state.tool, x1: x, y1: y, x2: x, y2: y, color: props.color, sw: props.width, opacity: props.opacity };
  }
  if (o) {
    page.objects.push(o);
    drag = { mode: "create", obj: o, startX: x, startY: y, snap };
  }
});

overlayCanvas.addEventListener("pointermove", (e) => {
  if (!drag) {
    // Hover feedback for fillable form fields in select mode.
    if (state.tool === "select") {
      const page = curPage();
      const { x, y } = eventPoint(e);
      const f = page && !hitObject(page, x, y) ? hitField(page, x, y) : null;
      overlayCanvas.style.cursor = f && !f.readOnly
        ? (f.type === "text" ? "text" : "pointer")
        : "";
    }
    return;
  }
  const { x, y } = eventPoint(e);
  const o = drag.obj;

  if (drag.mode === "drawing") {
    const last = o.points[o.points.length - 1];
    if (Math.hypot(x - last.x, y - last.y) > 1 / state.zoom) o.points.push({ x, y });
  } else if (drag.mode === "create") {
    if (o.type === "line" || o.type === "arrow") {
      o.x2 = x; o.y2 = y;
    } else {
      o.x = Math.min(drag.startX, x);
      o.y = Math.min(drag.startY, y);
      o.w = Math.abs(x - drag.startX);
      o.h = Math.abs(y - drag.startY);
    }
  } else if (drag.mode === "move") {
    moveObject(o, drag.orig, x - drag.startX, y - drag.startY);
  } else if (drag.mode === "resize") {
    resizeObject(o, drag.orig, drag.handle, x - drag.startX, y - drag.startY);
  }
  renderOverlay();
});

overlayCanvas.addEventListener("pointerup", () => {
  if (!drag) return;
  const page = curPage();
  const o = drag.obj;

  if (drag.mode === "create") {
    const tooSmall = (o.type === "line" || o.type === "arrow")
      ? Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 3
      : o.w < 3 && o.h < 3;
    if (tooSmall) {
      page.objects.pop();
    } else {
      pushSnap(drag.snap);
      state.selId = o.id;
      setTool("select");
      if (o.type === "whiteout" && page.src && !state.sources[page.src.s].unsupported && !whiteoutWarned) {
        whiteoutWarned = true;
        toast("Heads-up: whiteout hides content visually, but the text underneath stays recoverable in the exported PDF. Don't rely on it for sensitive data.", { ms: 9000 });
      }
    }
  } else if (drag.mode === "drawing") {
    if (o.points.length < 2) page.objects.pop();
    else pushSnap(drag.snap);
  } else if (drag.mode === "move" || drag.mode === "resize") {
    if (JSON.stringify(o) !== JSON.stringify(drag.orig)) pushSnap(drag.snap);
  }
  drag = null;
  renderOverlay();
  scheduleThumb();
  updatePropsPanel();
});

overlayCanvas.addEventListener("dblclick", (e) => {
  const page = curPage();
  if (!page) return;
  const { x, y } = eventPoint(e);
  const hit = hitObject(page, x, y);
  if (hit && hit.type === "text") {
    state.selId = hit.id;
    openTextEditor(hit, snapshot());
  }
});

function moveObject(o, orig, ddx, ddy) {
  if (o.type === "line" || o.type === "arrow") {
    o.x1 = orig.x1 + ddx; o.y1 = orig.y1 + ddy;
    o.x2 = orig.x2 + ddx; o.y2 = orig.y2 + ddy;
  } else if (o.type === "draw") {
    o.points = orig.points.map((p) => ({ x: p.x + ddx, y: p.y + ddy }));
  } else {
    o.x = orig.x + ddx;
    o.y = orig.y + ddy;
  }
}

function resizeObject(o, orig, handle, ddx, ddy) {
  if (o.type === "line" || o.type === "arrow") {
    if (handle === "p1") { o.x1 = orig.x1 + ddx; o.y1 = orig.y1 + ddy; }
    else { o.x2 = orig.x2 + ddx; o.y2 = orig.y2 + ddy; }
    return;
  }

  const b0 = objBounds(orig);
  let x = b0.x, y = b0.y, w = b0.w, h = b0.h;
  if (handle.includes("w")) { x += ddx; w -= ddx; }
  if (handle.includes("e")) { w += ddx; }
  if (handle.includes("n")) { y += ddy; h -= ddy; }
  if (handle.includes("s")) { h += ddy; }
  if (w < 4) { w = 4; x = Math.min(x, b0.x + b0.w - 4); }
  if (h < 4) { h = 4; y = Math.min(y, b0.y + b0.h - 4); }

  if (o.type === "draw") {
    const sx = w / b0.w, sy = h / b0.h;
    o.points = orig.points.map((p) => ({ x: x + (p.x - b0.x) * sx, y: y + (p.y - b0.y) * sy }));
    o.sw = Math.max(1, orig.sw * (sx + sy) / 2);
    return;
  }
  if (o.type === "text") {
    // Corner-scale text by adjusting the font size.
    const scale = Math.max(0.1, ((w / b0.w) + (h / b0.h)) / 2);
    o.size = clamp(orig.size * scale, 6, 200);
    o.x = x; o.y = y;
    measureTextObject(o);
    return;
  }
  o.x = x; o.y = y; o.w = w; o.h = h;
}

function deleteSelected() {
  const page = curPage();
  const o = selectedObj();
  if (!page || !o) return;
  pushUndo();
  page.objects = page.objects.filter((x) => x.id !== o.id);
  state.selId = null;
  renderOverlay();
  scheduleThumb();
  updatePropsPanel();
}

// ---------------------------------------------------------- text editor ----

function measureTextObject(o) {
  measureCtx.font = fontString(o);
  const lines = o.text.split("\n");
  let w = 10;
  for (const line of lines) w = Math.max(w, measureCtx.measureText(line).width);
  o.w = w;
  o.h = lines.length * o.size * 1.25;
}

function openTextEditor(o, snap) {
  editingId = o.id;
  textEditor._snap = snap;
  textEditor.value = o.text;
  textEditor.style.left = o.x * state.zoom + "px";
  textEditor.style.top = o.y * state.zoom + "px";
  textEditor.style.font = fontString(o, state.zoom);
  textEditor.style.lineHeight = "1.25";   // the font shorthand resets it
  textEditor.style.color = o.color;
  textEditor.classList.remove("hidden");
  sizeTextEditor(o);
  setTimeout(() => textEditor.focus(), 0);
  renderOverlay();
}

function sizeTextEditor(o) {
  measureCtx.font = fontString(o, state.zoom);
  const lines = textEditor.value.split("\n");
  let w = 60;
  for (const line of lines) w = Math.max(w, measureCtx.measureText(line).width + 12);
  textEditor.style.width = w + "px";
  textEditor.style.height = Math.max(1, lines.length) * o.size * 1.25 * state.zoom + 6 + "px";
}

// -- form field editing (reuses the floating textarea) --

let fieldEdit = null;   // { key, snap, multiLine }

function openFieldEditor(page, f) {
  closeTextEditor(true);
  const r = fieldDisplayRect(page, f);
  fieldEdit = { key: fieldKey(page, f), snap: snapshot(), multiLine: f.multiLine };
  const fs = f.fontSize || Math.min(Math.max(r.h * 0.55, 7), 13);
  textEditor.value = String(state.formValues[fieldEdit.key] ?? "");
  textEditor.style.left = r.x * state.zoom + "px";
  textEditor.style.top = r.y * state.zoom + "px";
  textEditor.style.width = r.w * state.zoom + "px";
  textEditor.style.height = r.h * state.zoom + "px";
  textEditor.style.font = `${fs * state.zoom}px Helvetica, Arial, sans-serif`;
  textEditor.style.lineHeight = "1.2";
  textEditor.style.color = "#111";
  textEditor.classList.remove("hidden");
  setTimeout(() => textEditor.focus(), 0);
}

function openChoiceEditor(page, f) {
  closeTextEditor(true);
  const r = fieldDisplayRect(page, f);
  const key = fieldKey(page, f);
  const snap = snapshot();
  const sel = document.createElement("select");
  sel.className = "field-select";
  const blank = document.createElement("option");
  blank.value = ""; blank.textContent = "—";
  sel.appendChild(blank);
  for (const opt of f.options) {
    const el = document.createElement("option");
    el.value = opt.exportValue != null ? String(opt.exportValue) : String(opt.displayValue);
    el.textContent = String(opt.displayValue ?? opt.exportValue);
    sel.appendChild(el);
  }
  sel.value = String(state.formValues[key] ?? "");
  sel.style.left = r.x * state.zoom + "px";
  sel.style.top = r.y * state.zoom + "px";
  sel.style.width = Math.max(60, r.w * state.zoom) + "px";
  sel.style.height = Math.max(20, r.h * state.zoom) + "px";
  pageWrap.appendChild(sel);
  sel.addEventListener("change", () => {
    pushSnap(snap);
    state.formValues[key] = sel.value;
    sel.remove();
    renderOverlay();
    scheduleThumb();
  });
  sel.addEventListener("blur", () => sel.remove());
  setTimeout(() => sel.focus(), 0);
}

function closeTextEditor(commit) {
  if (fieldEdit) {
    const { key, snap } = fieldEdit;
    fieldEdit = null;
    textEditor.classList.add("hidden");
    const val = textEditor.value.replace(/\r/g, "");
    if (commit && val !== String(state.formValues[key] ?? "")) {
      pushSnap(snap);
      state.formValues[key] = val;
    }
    renderOverlay();
    scheduleThumb();
    return;
  }
  if (!editingId) return;
  const page = curPage();
  const o = page && page.objects.find((x) => x.id === editingId);
  const snap = textEditor._snap;
  editingId = null;
  textEditor.classList.add("hidden");
  if (!o) return;
  if (commit) o.text = textEditor.value.replace(/\r/g, "");
  if (!o.text.trim()) {
    page.objects = page.objects.filter((x) => x.id !== o.id);
    if (state.selId === o.id) state.selId = null;
  } else {
    measureTextObject(o);
    if (snap) pushSnap(snap);
  }
  renderOverlay();
  scheduleThumb();
  updatePropsPanel();
}

textEditor.addEventListener("input", () => {
  const page = curPage();
  const o = page && page.objects.find((x) => x.id === editingId);
  if (o) sizeTextEditor(o);
});
textEditor.addEventListener("blur", () => closeTextEditor(true));
textEditor.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") { e.preventDefault(); closeTextEditor(true); }
  else if (e.key === "Enter" && fieldEdit && !fieldEdit.multiLine) { e.preventDefault(); closeTextEditor(true); }
});

// ------------------------------------------------------------ page ops ----

function rotateCurrentPage(dir) {
  const page = curPage();
  if (!page) return;
  pushUndo();
  const { w: Wd, h: Hd } = displayDims(page);
  page.rot = ((page.rot + (dir > 0 ? 90 : 270)) % 360 + 360) % 360;

  const mapPt = dir > 0
    ? (x, y) => ({ x: Hd - y, y: x })      // view rotates 90° cw
    : (x, y) => ({ x: y, y: Wd - x });     // view rotates 90° ccw

  for (const o of page.objects) {
    if (o.type === "line" || o.type === "arrow") {
      const p1 = mapPt(o.x1, o.y1), p2 = mapPt(o.x2, o.y2);
      o.x1 = p1.x; o.y1 = p1.y; o.x2 = p2.x; o.y2 = p2.y;
    } else if (o.type === "draw") {
      o.points = o.points.map((p) => mapPt(p.x, p.y));
    } else if (o.type === "text" || o.type === "image") {
      // Keep upright; re-anchor at the transformed center.
      const c = mapPt(o.x + o.w / 2, o.y + o.h / 2);
      o.x = c.x - o.w / 2; o.y = c.y - o.h / 2;
    } else {
      const p1 = mapPt(o.x, o.y), p2 = mapPt(o.x + o.w, o.y + o.h);
      o.x = Math.min(p1.x, p2.x); o.y = Math.min(p1.y, p2.y);
      o.w = Math.abs(p2.x - p1.x); o.h = Math.abs(p2.y - p1.y);
    }
  }
  refreshAll();
}

function addBlankPageAfterCurrent() {
  const page = curPage();
  pushUndo();
  const { w, h } = page ? baseDims(page) : { w: 612, h: 792 };
  const dims = page && totalRot(page) % 180 !== 0 ? { w: h, h: w } : { w, h };
  state.pages.splice(state.current + 1, 0, blankPage(dims.w, dims.h));
  state.current++;
  state.selId = null;
  refreshAll();
}

function duplicateCurrentPage() {
  const page = curPage();
  if (!page) return;
  pushUndo();
  const copy = JSON.parse(JSON.stringify(page));
  copy.id = uid();
  copy.objects.forEach((o) => (o.id = uid()));
  state.pages.splice(state.current + 1, 0, copy);
  state.current++;
  state.selId = null;
  refreshAll();
}

function deleteCurrentPage() {
  if (state.pages.length <= 1) { setStatus("A document needs at least one page"); return; }
  pushUndo();
  state.pages.splice(state.current, 1);
  state.current = clamp(state.current, 0, state.pages.length - 1);
  state.selId = null;
  refreshAll();
}

function moveCurrentPage(delta) {
  movePageTo(state.current, state.current + delta);
}

function movePageTo(from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.pages.length || to >= state.pages.length) return;
  pushUndo();
  const [pg] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, pg);
  state.current = to;
  refreshAll();
}

function gotoPage(i) {
  if (i < 0 || i >= state.pages.length || i === state.current) return;
  closeTextEditor(true);
  state.current = i;
  state.selId = null;
  renderPage();
  updatePageLabel();
  updateThumbActive();
  updatePropsPanel();
}

function updatePageLabel() {
  $("pageLabel").textContent = `Page ${state.current + 1} / ${state.pages.length}`;
}

// ----------------------------------------------------------- thumbnails ----

const THUMB_W = 120;

async function rebuildThumbs() {
  const seq = ++thumbSeq;
  const holder = $("thumbs");
  holder.innerHTML = "";
  const items = state.pages.map((page, i) => {
    const div = document.createElement("div");
    div.className = "thumb" + (i === state.current ? " active" : "");
    div.dataset.index = i;
    const cv = document.createElement("canvas");
    const num = document.createElement("span");
    num.className = "thumb-num";
    num.textContent = String(i + 1);
    div.appendChild(cv);
    div.appendChild(num);
    div.addEventListener("click", () => gotoPage(parseInt(div.dataset.index, 10)));

    // Drag to reorder pages.
    div.draggable = true;
    div.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/pdflover-page", String(i));
      e.dataTransfer.effectAllowed = "move";
      div.classList.add("dragging");
    });
    div.addEventListener("dragend", () => div.classList.remove("dragging"));
    div.addEventListener("dragover", (e) => {
      if ([...e.dataTransfer.types].includes("text/pdflover-page")) {
        e.preventDefault();
        div.classList.add("drag-over");
      }
    });
    div.addEventListener("dragleave", () => div.classList.remove("drag-over"));
    div.addEventListener("drop", (e) => {
      const from = e.dataTransfer.getData("text/pdflover-page");
      if (from === "") return;
      e.preventDefault();
      e.stopPropagation();
      div.classList.remove("drag-over");
      movePageTo(parseInt(from, 10), parseInt(div.dataset.index, 10));
    });

    holder.appendChild(div);
    return { page, cv };
  });
  for (const { page, cv } of items) {
    if (seq !== thumbSeq) return;
    await renderThumbCanvas(page, cv);
  }
}

async function renderThumbCanvas(page, cv) {
  const { w } = displayDims(page);
  const composite = await renderPageComposite(page, THUMB_W / w);
  cv.width = composite.width;
  cv.height = composite.height;
  cv.getContext("2d").drawImage(composite, 0, 0);
}

let thumbTimer = null;
function scheduleThumb() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    const div = $("thumbs").children[state.current];
    const page = curPage();
    if (div && page) renderThumbCanvas(page, div.querySelector("canvas"));
  }, 250);
}

function updateThumbActive() {
  [...$("thumbs").children].forEach((el, i) => el.classList.toggle("active", i === state.current));
}

// --------------------------------------------------------------- export ----

/** Bake one page's objects into a pdf-lib page. `ovr` overrides the
    coordinate mapper and effective rotation (used for rasterized pages,
    where the rotation is already baked into the bitmap). */
async function bakeObjects(outDoc, outPage, page, fontCache, ovr) {
  const mapPt = ovr ? ovr.mapPt : makePdfMapper(page);
  const R = ovr ? ovr.R : totalRot(page);

  const mapBox = (x, y, w, h) => {
    const [ax, ay] = mapPt(x, y);
    const [bx, by] = mapPt(x + w, y + h);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  };

  const getFont = async (o) => {
    const key = `${o.font}|${o.bold ? 1 : 0}|${o.italic ? 1 : 0}`;
    if (!fontCache.has(key)) fontCache.set(key, await outDoc.embedFont(standardFontFor(o.font, o.bold, o.italic)));
    return fontCache.get(key);
  };

  const drawSeg = (p1, p2, o) => {
    const [x1, y1] = mapPt(p1.x, p1.y);
    const [x2, y2] = mapPt(p2.x, p2.y);
    outPage.drawLine({
      start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
      thickness: o.sw, color: hexToRgb(o.color), opacity: o.opacity,
      lineCap: LineCapStyle.Round,
    });
  };

  for (const o of page.objects) {
    switch (o.type) {
      case "text": {
        const font = await getFont(o);
        const lh = o.size * 1.25;
        const lines = o.text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const [bx, by] = mapPt(o.x, o.y + i * lh + o.size * 0.8);
          const text = sanitizeWinAnsi(lines[i]);
          if (!text) continue;
          outPage.drawText(text, {
            x: bx, y: by, size: o.size, font,
            color: hexToRgb(o.color), opacity: o.opacity, rotate: degrees(R),
          });
        }
        break;
      }
      case "image": {
        const box = mapBox(o.x, o.y, o.w, o.h);
        const { bytes, fmt } = await imageBytesForRotation(o, R);
        const img = fmt === "jpeg" ? await outDoc.embedJpg(bytes) : await outDoc.embedPng(bytes);
        outPage.drawImage(img, { x: box.x, y: box.y, width: box.w, height: box.h, opacity: o.opacity });
        break;
      }
      case "rect": {
        const box = mapBox(o.x, o.y, o.w, o.h);
        outPage.drawRectangle({
          x: box.x, y: box.y, width: box.w, height: box.h,
          borderColor: hexToRgb(o.color), borderWidth: o.sw,
          color: o.fill ? hexToRgb(o.fill) : undefined,
          opacity: o.fill ? o.opacity : 0, borderOpacity: o.opacity,
        });
        break;
      }
      case "ellipse": {
        const box = mapBox(o.x, o.y, o.w, o.h);
        outPage.drawEllipse({
          x: box.x + box.w / 2, y: box.y + box.h / 2,
          xScale: Math.max(box.w / 2 - o.sw / 2, 0.1), yScale: Math.max(box.h / 2 - o.sw / 2, 0.1),
          borderColor: hexToRgb(o.color), borderWidth: o.sw,
          color: o.fill ? hexToRgb(o.fill) : undefined,
          opacity: o.fill ? o.opacity : 0, borderOpacity: o.opacity,
        });
        break;
      }
      case "highlight": {
        const box = mapBox(o.x, o.y, o.w, o.h);
        outPage.drawRectangle({
          x: box.x, y: box.y, width: box.w, height: box.h,
          color: hexToRgb(o.color), opacity: o.opacity, blendMode: BlendMode.Multiply,
        });
        break;
      }
      case "whiteout": {
        const box = mapBox(o.x, o.y, o.w, o.h);
        outPage.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, color: rgb(1, 1, 1) });
        break;
      }
      case "line":
      case "arrow": {
        drawSeg({ x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 }, o);
        if (o.type === "arrow") {
          for (const [hx, hy] of arrowHead(o)) drawSeg({ x: o.x2, y: o.y2 }, { x: hx, y: hy }, o);
        }
        break;
      }
      case "draw": {
        for (let i = 1; i < o.points.length; i++) drawSeg(o.points[i - 1], o.points[i], o);
        break;
      }
    }
  }
}

/**
 * Images are stored upright in display space; if the page is displayed
 * rotated, pre-rotate the pixels the opposite way so the export matches
 * what is on screen.
 */
async function imageBytesForRotation(o, R) {
  if (R === 0) return { bytes: dataUrlToBytes(o.dataUrl), fmt: o.fmt };
  const img = await loadImageFromDataURL(o.dataUrl);
  const cv = document.createElement("canvas");
  const swap = R % 180 !== 0;
  cv.width = swap ? img.naturalHeight : img.naturalWidth;
  cv.height = swap ? img.naturalWidth : img.naturalHeight;
  const ctx = cv.getContext("2d");
  ctx.translate(cv.width / 2, cv.height / 2);
  ctx.rotate(-R * Math.PI / 180);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  return { bytes: dataUrlToBytes(cv.toDataURL("image/png")), fmt: "png" };
}

/**
 * Bake a page's form fields (backgrounds, borders, and the user's values)
 * directly into the output page — a manual "flatten". This mirrors the
 * on-screen overlay drawing exactly and uses only pdf.js widget data, so it
 * works even on documents whose AcroForm pdf-lib cannot parse. The original
 * widget annotations are stripped separately.
 */
async function bakeFormFields(outDoc, outPage, page, fontCache, ovr) {
  const fields = pageFields(page);
  if (!fields.length) return;
  const mapPt = ovr ? ovr.mapPt : makePdfMapper(page);
  const R = ovr ? ovr.R : totalRot(page);

  const helvKey = "Helvetica|0|0";
  if (!fontCache.has(helvKey)) fontCache.set(helvKey, await outDoc.embedFont(StandardFonts.Helvetica));
  const font = fontCache.get(helvKey);

  const mapBox = (x, y, w, h) => {
    const [ax, ay] = mapPt(x, y);
    const [bx, by] = mapPt(x + w, y + h);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
  };
  const seg = (p1, p2, thickness, color) => {
    const [x1, y1] = mapPt(p1.x, p1.y);
    const [x2, y2] = mapPt(p2.x, p2.y);
    outPage.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color, lineCap: LineCapStyle.Round });
  };
  const ink = rgb(0.07, 0.07, 0.07);

  for (const f of fields) {
    const r = fieldDisplayRect(page, f);
    const v = state.formValues[fieldKey(page, f)];
    const box = mapBox(r.x, r.y, r.w, r.h);

    if (f.bg) {
      outPage.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, color: rgb(f.bg[0] / 255, f.bg[1] / 255, f.bg[2] / 255) });
    }
    if (f.border) {
      outPage.drawRectangle({
        x: box.x, y: box.y, width: box.w, height: box.h,
        borderColor: rgb(f.border[0] / 255, f.border[1] / 255, f.border[2] / 255),
        borderWidth: 1, opacity: 0, borderOpacity: 1,
      });
    }

    if (f.type === "checkbox" || f.type === "radio") {
      const checked = f.type === "checkbox" ? v === true : v === String(f.exportValue);
      const s = Math.min(r.w, r.h);
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      if (f.type === "radio") {
        const [px, py] = mapPt(cx, cy);
        outPage.drawEllipse({
          x: px, y: py, xScale: s * 0.38, yScale: s * 0.38,
          borderColor: rgb(0.2, 0.2, 0.2), borderWidth: Math.max(1, s * 0.08),
          opacity: 0, borderOpacity: 1,
        });
        if (checked) outPage.drawEllipse({ x: px, y: py, xScale: s * 0.2, yScale: s * 0.2, color: ink });
      } else if (checked) {
        const t = Math.max(1.5, s * 0.14);
        seg({ x: r.x + r.w * 0.22, y: cy }, { x: cx - s * 0.05, y: r.y + r.h * 0.72 }, t, ink);
        seg({ x: cx - s * 0.05, y: r.y + r.h * 0.72 }, { x: r.x + r.w * 0.8, y: r.y + r.h * 0.28 }, t, ink);
      }
    } else {
      const text = v != null ? String(v) : "";
      if (!text) continue;
      const fs = f.fontSize || Math.min(Math.max(r.h * 0.55, 7), 13);
      const pad = 2.5;
      const lines = f.multiLine ? text.split("\n") : [text.replace(/\n/g, " ")];
      for (let i = 0; i < lines.length; i++) {
        const line = sanitizeWinAnsi(lines[i]);
        if (!line) continue;
        const by = f.multiLine ? r.y + pad + (i + 0.85) * fs * 1.2 : r.y + r.h / 2 + fs * 0.36;
        const [px, py] = mapPt(r.x + pad, by);
        outPage.drawText(line, { x: px, y: py, size: fs, font, color: ink, rotate: degrees(R) });
      }
    }
  }
}

/** Remove widget annotations from a copied page so stale field appearances
    cannot shadow the baked values. Other annotations (e.g. links) stay. */
function stripWidgetAnnotations(outDoc, outPage) {
  try {
    const annots = outPage.node.Annots();
    if (!annots) return;
    const widget = PDFLib.PDFName.of("Widget");
    const keep = [];
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      let subtype = null;
      try {
        const dict = outDoc.context.lookup(ref);
        subtype = dict && dict.get && dict.get(PDFLib.PDFName.of("Subtype"));
      } catch (e) { /* keep unknown annotations */ }
      if (subtype && subtype === widget) continue;
      if (subtype && subtype.toString && subtype.toString() === "/Widget") continue;
      keep.push(ref);
    }
    outPage.node.set(PDFLib.PDFName.of("Annots"), outDoc.context.obj(keep));
  } catch (e) {
    console.warn("Could not strip widget annotations:", e.message);
  }
}

/** Render a source page to a bitmap via pdf.js (which handles encrypted
    documents) and place it as the full page background. */
async function rasterizePageToPdf(outDoc, page) {
  const proxy = state.sources[page.src.s].proxies[page.src.p];
  const { w, h } = displayDims(page);
  const scale = 2;   // 144 dpi
  const vp = proxy.getViewport({ scale, rotation: totalRot(page) });
  const cv = document.createElement("canvas");
  cv.width = Math.round(vp.width);
  cv.height = Math.round(vp.height);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  await proxy.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS }).promise;
  const img = await outDoc.embedJpg(dataUrlToBytes(cv.toDataURL("image/jpeg", 0.92)));
  const outPage = outDoc.addPage([w, h]);
  outPage.drawImage(img, { x: 0, y: 0, width: w, height: h });
  // The bitmap already carries the rotation; treat the page as unrotated.
  return { outPage, ovr: { mapPt: (dx, dy) => [dx, h - dy], R: 0 } };
}

async function buildPdf(pageList) {
  const outDoc = await PDFDocument.create();
  outDoc.setProducer("PDFLover");
  outDoc.setCreator("PDFLover");
  const fontCache = new Map();
  const libDocs = new Map();   // source index -> pdf-lib doc

  for (const page of pageList) {
    let outPage;
    let ovr = null;
    if (page.src && state.sources[page.src.s].unsupported) {
      // pdf-lib cannot copy this document (usually encryption): rasterize.
      ({ outPage, ovr } = await rasterizePageToPdf(outDoc, page));
    } else if (page.src) {
      if (!libDocs.has(page.src.s)) {
        libDocs.set(page.src.s, await PDFDocument.load(state.sources[page.src.s].bytes, { ignoreEncryption: true }));
      }
      const [copied] = await outDoc.copyPages(libDocs.get(page.src.s), [page.src.p]);
      outPage = outDoc.addPage(copied);
      outPage.setRotation(degrees(totalRot(page)));
      stripWidgetAnnotations(outDoc, outPage);
    } else {
      outPage = outDoc.addPage([page.blank.w, page.blank.h]);
      if (page.rot) outPage.setRotation(degrees(page.rot));
    }
    await bakeFormFields(outDoc, outPage, page, fontCache, ovr);
    await bakeObjects(outDoc, outPage, page, fontCache, ovr);
  }
  return outDoc.save();
}

async function exportPdf() {
  closeTextEditor(true);
  try {
    setStatus("Exporting…");
    const bytes = await buildPdf(state.pages);
    const name = ($("docName").value.trim() || "document") + ".pdf";
    downloadBytes(bytes, name, "application/pdf");
    state.dirty = false;
    scheduleAutosave();
    setStatus(`Exported ${name} (${state.pages.length} page(s))`);
    toast(`Exported ${name}`);
  } catch (e) {
    console.error(e);
    setStatus("Export failed: " + e.message, true);
    toast("Export failed: " + e.message, { error: true });
  }
}

async function extractCurrentPage() {
  const page = curPage();
  if (!page) return;
  try {
    setStatus("Extracting page…");
    const bytes = await buildPdf([page]);
    const name = `${$("docName").value.trim() || "document"}-page${state.current + 1}.pdf`;
    downloadBytes(bytes, name, "application/pdf");
    setStatus(`Exported ${name}`);
  } catch (e) {
    console.error(e);
    setStatus("Extract failed: " + e.message, true);
  }
}

// ------------------------------------------------------------ props UI ----

const PROP_VISIBILITY = {
  text: ["propColorWrap", "propSizeWrap", "propFontWrap", "propStyleWrap", "propOpacityWrap"],
  draw: ["propColorWrap", "propWidthWrap", "propOpacityWrap"],
  line: ["propColorWrap", "propWidthWrap", "propOpacityWrap"],
  arrow: ["propColorWrap", "propWidthWrap", "propOpacityWrap"],
  rect: ["propColorWrap", "propFillWrap", "propWidthWrap", "propOpacityWrap"],
  ellipse: ["propColorWrap", "propFillWrap", "propWidthWrap", "propOpacityWrap"],
  highlight: ["propColorWrap", "propOpacityWrap"],
  whiteout: [],
  image: ["propOpacityWrap"],
  select: [],
};

function updatePropsPanel() {
  const sel = selectedObj();
  const kind = sel ? sel.type : state.tool;
  const visible = new Set(PROP_VISIBILITY[kind] || []);
  for (const id of ["propColorWrap", "propFillWrap", "propWidthWrap", "propSizeWrap", "propFontWrap", "propStyleWrap", "propOpacityWrap"]) {
    $(id).classList.toggle("hidden", !visible.has(id));
  }
  $("btnDeleteObj").classList.toggle("hidden", !sel);

  if (visible.has("propColorWrap")) $("propColor").value = sel ? sel.color : props.color;
  if (visible.has("propFillWrap")) {
    $("propFill").value = (sel ? sel.fill : props.fill) || "#ffe066";
    $("propFillOn").checked = sel ? !!sel.fill : props.fillOn;
  }
  if (visible.has("propWidthWrap")) {
    const w = sel ? sel.sw : props.width;
    $("propWidth").value = w;
    $("propWidthVal").textContent = w;
  }
  if (visible.has("propSizeWrap")) $("propSize").value = Math.round(sel ? sel.size : props.size);
  if (visible.has("propFontWrap")) $("propFont").value = sel ? sel.font : props.font;
  if (visible.has("propStyleWrap")) {
    $("propBold").classList.toggle("active", sel ? !!sel.bold : props.bold);
    $("propItalic").classList.toggle("active", sel ? !!sel.italic : props.italic);
  }
  if (visible.has("propOpacityWrap")) {
    const op = Math.round((sel ? sel.opacity : props.opacity) * 100);
    $("propOpacity").value = op;
    $("propOpacityVal").textContent = op + "%";
  }
}

function applyProp(mutate) {
  const sel = selectedObj();
  if (sel) {
    if (!propSnap) propSnap = snapshot();
    mutate(sel, true);
    if (sel.type === "text") measureTextObject(sel);
    renderOverlay();
    scheduleThumb();
  } else {
    mutate(props, false);
  }
}

function commitPropSnap() {
  if (propSnap) { pushSnap(propSnap); propSnap = null; }
}

function wireProps() {
  $("propColor").addEventListener("input", () => applyProp((t, isObj) => { t.color = $("propColor").value; }));
  $("propColor").addEventListener("change", commitPropSnap);

  const applyFill = () => applyProp((t, isObj) => {
    if (isObj) t.fill = $("propFillOn").checked ? $("propFill").value : null;
    else { t.fill = $("propFill").value; t.fillOn = $("propFillOn").checked; }
  });
  $("propFill").addEventListener("input", () => { $("propFillOn").checked = true; applyFill(); });
  $("propFill").addEventListener("change", commitPropSnap);
  $("propFillOn").addEventListener("change", () => { applyFill(); commitPropSnap(); });

  $("propWidth").addEventListener("input", () => {
    const v = parseInt($("propWidth").value, 10);
    $("propWidthVal").textContent = v;
    applyProp((t, isObj) => { if (isObj) t.sw = v; else t.width = v; });
  });
  $("propWidth").addEventListener("change", commitPropSnap);

  $("propSize").addEventListener("input", () => {
    const v = clamp(parseInt($("propSize").value, 10) || 16, 6, 144);
    applyProp((t) => { t.size = v; });
  });
  $("propSize").addEventListener("change", commitPropSnap);

  $("propFont").addEventListener("change", () => {
    applyProp((t) => { t.font = $("propFont").value; });
    commitPropSnap();
  });

  $("propBold").addEventListener("click", () => {
    applyProp((t) => { t.bold = !t.bold; });
    commitPropSnap();
    updatePropsPanel();
  });
  $("propItalic").addEventListener("click", () => {
    applyProp((t) => { t.italic = !t.italic; });
    commitPropSnap();
    updatePropsPanel();
  });

  $("propOpacity").addEventListener("input", () => {
    const v = parseInt($("propOpacity").value, 10) / 100;
    $("propOpacityVal").textContent = Math.round(v * 100) + "%";
    applyProp((t) => { t.opacity = v; });
  });
  $("propOpacity").addEventListener("change", commitPropSnap);

  $("btnDeleteObj").addEventListener("click", deleteSelected);
}

// ---------------------------------------------------------------- tools ----

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  pageWrap.dataset.tool = tool;
  updatePropsPanel();
}

async function placeImageDataUrl(dataUrl, fmt, maxFrac = 0.5) {
  const page = curPage();
  if (!page) return;
  const img = await loadImageFromDataURL(dataUrl);
  const { w: pw, h: ph } = displayDims(page);
  const scale = Math.min(1, (pw * maxFrac) / img.naturalWidth, (ph * maxFrac) / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  pushUndo();
  const o = {
    id: uid(), type: "image", x: (pw - w) / 2, y: (ph - h) / 2, w, h,
    dataUrl, fmt, opacity: 1,
  };
  page.objects.push(o);
  state.selId = o.id;
  setTool("select");
  renderOverlay();
  scheduleThumb();
}

async function placeImageFile(file) {
  if (!file) return;
  let dataUrl = await readFileAsDataURL(file);
  let fmt = file.type === "image/jpeg" ? "jpeg" : "png";
  if (file.type !== "image/png" && file.type !== "image/jpeg") {
    // Normalize other formats (e.g. WebP) to PNG for pdf-lib.
    const img = await loadImageFromDataURL(dataUrl);
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.getContext("2d").drawImage(img, 0, 0);
    dataUrl = cv.toDataURL("image/png");
    fmt = "png";
  }
  await placeImageDataUrl(dataUrl, fmt);
}

// ----------------------------------------------------------------- zoom ----

function setZoom(z) {
  state.zoom = clamp(z, 0.25, 4);
  $("zoomLabel").textContent = Math.round(state.zoom * 100) + "%";
  closeTextEditor(true);
  renderPage();
}

function zoomFit() {
  const page = curPage();
  if (!page) return;
  const { w } = displayDims(page);
  setZoom((viewer.clientWidth - 56) / w);
}

function zoomFitPage() {
  const page = curPage();
  if (!page) return;
  const { w, h } = displayDims(page);
  setZoom(Math.min((viewer.clientWidth - 56) / w, (viewer.clientHeight - 48) / h));
}

// --------------------------------------------------------------- status ----

let statusTimer = null;
function setStatus(msg, isError) {
  const el = $("status");
  el.textContent = msg;
  el.style.color = isError ? "#ff8598" : "";
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ""; }, 6000);
}

/** Prominent, self-dismissing notification. Returns the element so callers
    can append action buttons; pass ms: 0 to keep it until dismissed. */
function toast(msg, opts = {}) {
  const t = document.createElement("div");
  t.className = "toast" + (opts.error ? " err" : "");
  const span = document.createElement("span");
  span.textContent = msg;
  t.appendChild(span);
  $("toasts").appendChild(t);
  if (opts.ms !== 0) {
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 400); }, opts.ms || 4500);
  }
  return t;
}

// --------------------------------------------------------------- search ----

const search = { query: "", matches: [], cur: -1 };   // matches: {pageIndex, rects}

async function getPageTextItems(page) {
  if (!page.src) return null;
  const src = state.sources[page.src.s];
  if (!src.textCache) src.textCache = new Map();
  if (!src.textCache.has(page.src.p)) {
    const tc = await src.proxies[page.src.p].getTextContent();
    src.textCache.set(page.src.p, tc.items);
  }
  return src.textCache.get(page.src.p);
}

function itemDisplayRect(vp, item) {
  const t = item.transform;
  const h = Math.hypot(t[1], t[3]) || item.height || 10;
  const w = item.width || 1;
  const p1 = vp.convertToViewportPoint(t[4], t[5]);
  const p2 = vp.convertToViewportPoint(t[4] + w, t[5] + h);
  return {
    x: Math.min(p1[0], p2[0]), y: Math.min(p1[1], p2[1]),
    w: Math.abs(p2[0] - p1[0]) || 2, h: Math.abs(p2[1] - p1[1]) || 2,
  };
}

async function runSearch(query) {
  search.query = query;
  search.matches = [];
  search.cur = -1;
  const q = query.trim().toLowerCase();
  if (!q) { updateSearchUI(); renderOverlay(); return; }

  for (let pi = 0; pi < state.pages.length; pi++) {
    const page = state.pages[pi];
    const items = await getPageTextItems(page);
    if (!items || !items.length) continue;
    const proxy = state.sources[page.src.s].proxies[page.src.p];
    const vp = proxy.getViewport({ scale: 1, rotation: totalRot(page) });

    let full = "";
    const spans = [];
    for (const it of items) {
      if (!it.str) continue;
      spans.push({ start: full.length, end: full.length + it.str.length, item: it });
      full += it.str;
      if (it.hasEOL) full += "\n";
    }
    const hay = full.toLowerCase();
    let idx = 0;
    while ((idx = hay.indexOf(q, idx)) !== -1) {
      const end = idx + q.length;
      const rects = [];
      for (const sp of spans) {
        if (sp.end <= idx || sp.start >= end) continue;
        const r = itemDisplayRect(vp, sp.item);
        if (r.w > r.h) {
          // Slice horizontally by character proportion for partial coverage.
          const len = sp.item.str.length || 1;
          const sFrac = Math.max(0, idx - sp.start) / len;
          const eFrac = Math.min(1, (end - sp.start) / len);
          rects.push({ x: r.x + r.w * sFrac, y: r.y, w: Math.max(2, r.w * (eFrac - sFrac)), h: r.h });
        } else {
          rects.push(r);
        }
      }
      if (rects.length) search.matches.push({ pageIndex: pi, rects });
      idx = end;
    }
  }
  updateSearchUI();
  if (search.matches.length) gotoMatch(0);
  else renderOverlay();
}

function gotoMatch(i) {
  const n = search.matches.length;
  if (!n) return;
  search.cur = ((i % n) + n) % n;
  const m = search.matches[search.cur];
  if (m.pageIndex !== state.current) gotoPage(m.pageIndex);
  else renderOverlay();
  const r = m.rects[0];
  viewer.scrollTo({ top: Math.max(0, r.y * state.zoom - viewer.clientHeight / 3), behavior: "smooth" });
  updateSearchUI();
}

function drawSearchHighlights(ctx) {
  if (!search.matches.length) return;
  ctx.save();
  search.matches.forEach((m, i) => {
    if (m.pageIndex !== state.current) return;
    ctx.fillStyle = i === search.cur ? "rgba(242,118,28,0.5)" : "rgba(255,222,0,0.35)";
    for (const r of m.rects) ctx.fillRect(r.x, r.y - 1, r.w, r.h + 2);
  });
  ctx.restore();
}

function updateSearchUI() {
  $("searchCount").textContent = search.matches.length
    ? `${search.cur + 1} / ${search.matches.length}`
    : "0 / 0";
}

function openSearch() {
  $("searchBar").classList.remove("hidden");
  $("searchInput").focus();
  $("searchInput").select();
}

function closeSearch() {
  $("searchBar").classList.add("hidden");
  search.query = "";
  search.matches = [];
  search.cur = -1;
  renderOverlay();
}

function clearSearchMatches() {
  if (!search.matches.length && !search.query) return;
  search.matches = [];
  search.cur = -1;
  updateSearchUI();
}

let searchDebounce = null;
function wireSearch() {
  $("btnSearch").addEventListener("click", openSearch);
  $("searchInput").addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch($("searchInput").value), 250);
  });
  $("searchInput").addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); gotoMatch(search.cur + (e.shiftKey ? -1 : 1)); }
    else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
  });
  $("searchNext").addEventListener("click", () => gotoMatch(search.cur + 1));
  $("searchPrev").addEventListener("click", () => gotoMatch(search.cur - 1));
  $("searchClose").addEventListener("click", closeSearch);
}

// ---------------------------------------------------------------- print ----

async function printDocument() {
  toast("Preparing print…");
  try {
    const imgs = [];
    for (const page of state.pages) {
      imgs.push((await renderPageComposite(page, 2)).toDataURL("image/jpeg", 0.92));
    }
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(frame);
    const fdoc = frame.contentDocument;
    fdoc.open();
    fdoc.write(
      "<!DOCTYPE html><html><head><title>PDFLover</title><style>" +
      "body{margin:0}img{display:block;width:100%;page-break-after:always}img:last-child{page-break-after:auto}" +
      "</style></head><body>" + imgs.map((s) => `<img src="${s}">`).join("") + "</body></html>"
    );
    fdoc.close();
    await Promise.all([...fdoc.images].map((im) => im.decode().catch(() => {})));
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60000);
  } catch (e) {
    console.error(e);
    toast("Print failed: " + e.message, { error: true });
  }
}

// ------------------------------------------------------ object clipboard ----

let objClipboard = null;

function copySelected() {
  const o = selectedObj();
  if (!o) return false;
  objClipboard = JSON.parse(JSON.stringify(o));
  setStatus("Copied");
  return true;
}

function pasteClipboard() {
  if (!objClipboard) return false;
  const page = curPage();
  if (!page) return false;
  pushUndo();
  const o = JSON.parse(JSON.stringify(objClipboard));
  o.id = uid();
  moveObject(o, JSON.parse(JSON.stringify(o)), 14, 14);
  page.objects.push(o);
  state.selId = o.id;
  renderOverlay();
  scheduleThumb();
  updatePropsPanel();
  return true;
}

function duplicateSelected() {
  if (copySelected()) pasteClipboard();
}

// ------------------------------------------------------------- autosave ----

let autosaveTimer = null;

function idbOp(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("pdflover", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("session");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("session", mode);
      const r = fn(tx.objectStore("session"));
      tx.oncomplete = () => { db.close(); resolve(r && r.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveSession, 1500);
}

async function saveSession() {
  try {
    await idbOp("readwrite", (s) => s.put({
      when: Date.now(),
      dirty: state.dirty,
      docName: $("docName").value,
      current: state.current,
      pages: JSON.parse(JSON.stringify(state.pages)),
      formValues: { ...state.formValues },
      sources: state.sources.map((src) => src.bytes),
    }, "current"));
  } catch (e) {
    console.warn("Autosave failed:", e.message);
  }
}

async function tryOfferRestore() {
  let data = null;
  try { data = await idbOp("readonly", (s) => s.get("current")); } catch (e) { return; }
  if (!data || !data.dirty || !data.pages || !data.pages.length) return;
  const t = toast(`Found unsaved work ("${data.docName}", ${new Date(data.when).toLocaleString()}).`, { ms: 0 });
  const restore = document.createElement("button");
  restore.textContent = "Restore";
  const discard = document.createElement("button");
  discard.textContent = "Discard";
  discard.className = "ghost";
  t.appendChild(restore);
  t.appendChild(discard);
  const close = () => { t.classList.add("out"); setTimeout(() => t.remove(), 400); };
  restore.addEventListener("click", async () => { close(); await restoreSession(data); });
  discard.addEventListener("click", async () => {
    close();
    try { await idbOp("readwrite", (s) => s.delete("current")); } catch (e) { /* ignore */ }
  });
}

async function restoreSession(data) {
  try {
    state.sources = [];
    state.formValues = {};
    imageCache.clear();
    for (const bytes of data.sources) await addSource(new Uint8Array(bytes));
    state.pages = data.pages;
    if (data.formValues) state.formValues = data.formValues;
    state.current = clamp(data.current || 0, 0, state.pages.length - 1);
    state.undoStack = [];
    state.redoStack = [];
    state.selId = null;
    state.dirty = true;
    $("docName").value = data.docName || "restored";
    refreshAll();
    toast("Session restored");
    scheduleAutosave();
  } catch (e) {
    console.error(e);
    toast("Could not restore session: " + e.message, { error: true });
  }
}

// ------------------------------------------------------------ drag&drop ----

function isFreshDoc() {
  return state.sources.length === 0 && state.pages.length === 1 &&
         state.pages[0].objects.length === 0 && !state.dirty;
}

function wireDragDrop() {
  let depth = 0;
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragenter", (e) => {
    if ([...(e.dataTransfer ? e.dataTransfer.types : [])].includes("Files")) {
      depth++;
      document.body.classList.add("dropping");
    }
  });
  window.addEventListener("dragleave", () => {
    if (--depth <= 0) { depth = 0; document.body.classList.remove("dropping"); }
  });
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove("dropping");
    const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
    if (!files.length) return;   // internal drags (page thumbnails)
    const pdfs = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    const imgs = files.filter((f) => /^image\//.test(f.type));
    try {
      let rest = pdfs;
      if (pdfs.length && isFreshDoc()) {
        const bytes = new Uint8Array(await readFileAsArrayBuffer(pdfs[0]));
        await openPdfBytes(bytes, pdfs[0].name);
        toast(`Opened ${pdfs[0].name}`);
        rest = pdfs.slice(1);
      }
      for (const f of rest) {
        await insertPdfBytes(new Uint8Array(await readFileAsArrayBuffer(f)));
        toast(`Appended pages from ${f.name}`);
      }
      for (const f of imgs) await placeImageFile(f);
      if (imgs.length) toast(`Placed ${imgs.length} image(s) — drag to position`);
    } catch (err) {
      console.error(err);
      toast("Could not open dropped file: " + err.message, { error: true });
    }
  });
}

// ----------------------------------------------------------- signatures ----

const SIG_STORE_KEY = "pdflover.signatures";

function loadSignatures() {
  try { return JSON.parse(localStorage.getItem(SIG_STORE_KEY)) || []; } catch (e) { return []; }
}

function storeSignature(dataUrl) {
  try {
    const sigs = loadSignatures().filter((s) => s !== dataUrl);
    sigs.unshift(dataUrl);
    localStorage.setItem(SIG_STORE_KEY, JSON.stringify(sigs.slice(0, 5)));
  } catch (e) { /* storage full — placing still works */ }
}

/** Crop a canvas to its inked bounding box; null if empty. */
function trimCanvasToDataUrl(cv) {
  const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
  let minX = cv.width, minY = cv.height, maxX = -1, maxY = -1;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      if (d[(y * cv.width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 6;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(cv.width - 1, maxX + pad); maxY = Math.min(cv.height - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d").drawImage(cv, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

function renderSavedSigs() {
  const sigs = loadSignatures();
  $("sigSavedWrap").classList.toggle("hidden", !sigs.length);
  const holder = $("sigSaved");
  holder.innerHTML = "";
  sigs.forEach((s, i) => {
    const item = document.createElement("div");
    item.className = "sig-item";
    const img = document.createElement("img");
    img.src = s;
    item.appendChild(img);
    const del = document.createElement("button");
    del.className = "sig-del";
    del.textContent = "✕";
    del.title = "Delete saved signature";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const arr = loadSignatures();
      arr.splice(i, 1);
      try { localStorage.setItem(SIG_STORE_KEY, JSON.stringify(arr)); } catch (err) { /* ignore */ }
      renderSavedSigs();
    });
    item.appendChild(del);
    item.addEventListener("click", async () => {
      $("sigModal").classList.add("hidden");
      await placeImageDataUrl(s, "png", 0.3);
    });
    holder.appendChild(item);
  });
}

function wireSignatures() {
  const cv = $("sigCanvas");
  const ctx = cv.getContext("2d");
  ctx.lineWidth = 2.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#101a5a";
  let drawing = false, last = null;
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };
  };
  cv.addEventListener("pointerdown", (e) => { drawing = true; last = pos(e); cv.setPointerCapture(e.pointerId); });
  cv.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p;
  });
  cv.addEventListener("pointerup", () => { drawing = false; });
  $("sigClear").addEventListener("click", () => ctx.clearRect(0, 0, cv.width, cv.height));

  document.querySelectorAll(".sig-tab").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".sig-tab").forEach((x) => x.classList.toggle("active", x === b));
    for (const id of ["sigDraw", "sigType", "sigUpload"]) $(id).classList.toggle("hidden", id !== b.dataset.sigtab);
  }));

  const pv = $("sigTypePreview");
  const pctx = pv.getContext("2d");
  const renderTyped = () => {
    pctx.clearRect(0, 0, pv.width, pv.height);
    pctx.fillStyle = "#101a5a";
    pctx.font = 'italic 54px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive';
    pctx.textBaseline = "middle";
    pctx.fillText($("sigText").value, 16, pv.height / 2);
  };
  $("sigText").addEventListener("input", renderTyped);

  $("btnSign").addEventListener("click", () => {
    renderSavedSigs();
    $("sigModal").classList.remove("hidden");
  });

  $("sigPlace").addEventListener("click", async () => {
    const active = document.querySelector(".sig-tab.active").dataset.sigtab;
    let dataUrl = null;
    if (active === "sigDraw") {
      dataUrl = trimCanvasToDataUrl(cv);
    } else if (active === "sigType") {
      renderTyped();
      dataUrl = trimCanvasToDataUrl(pv);
    } else {
      const f = $("sigFile").files[0];
      if (f) {
        const raw = await readFileAsDataURL(f);
        const img = await loadImageFromDataURL(raw);
        const tmp = document.createElement("canvas");
        tmp.width = img.naturalWidth; tmp.height = img.naturalHeight;
        tmp.getContext("2d").drawImage(img, 0, 0);
        dataUrl = tmp.toDataURL("image/png");
      }
    }
    if (!dataUrl) {
      toast("Draw, type, or choose a signature first", { error: true });
      return;
    }
    storeSignature(dataUrl);
    $("sigModal").classList.add("hidden");
    await placeImageDataUrl(dataUrl, "png", 0.3);
    toast("Signature placed — drag it into position");
  });
}

// --------------------------------------------------------------- wiring ----

function confirmDiscard() {
  return !state.dirty || confirm("You have unsaved changes. Discard them?");
}

function wireTopbar() {
  $("btnNew").addEventListener("click", () => {
    if (!confirmDiscard()) return;
    $("newModal").classList.remove("hidden");
  });
  $("newCreate").addEventListener("click", () => {
    newDocument($("newSize").value, $("newOrient").value);
    $("docName").value = "untitled";
    $("newModal").classList.add("hidden");
  });

  $("btnOpen").addEventListener("click", () => {
    if (!confirmDiscard()) return;
    $("fileOpenPdf").value = "";
    $("fileOpenPdf").click();
  });
  $("fileOpenPdf").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      setStatus("Opening " + file.name + "…");
      const bytes = new Uint8Array(await readFileAsArrayBuffer(file));
      await openPdfBytes(bytes, file.name);
      setStatus(`Opened ${file.name} (${state.pages.length} page(s))`);
    } catch (err) {
      console.error(err);
      alert("Could not open PDF: " + err.message);
      setStatus("Open failed", true);
    }
  });

  $("btnInsert").addEventListener("click", () => {
    $("fileInsertPdf").value = "";
    $("fileInsertPdf").click();
  });
  $("fileInsertPdf").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const bytes = new Uint8Array(await readFileAsArrayBuffer(file));
      await insertPdfBytes(bytes);
    } catch (err) {
      console.error(err);
      alert("Could not insert PDF: " + err.message);
    }
  });

  $("btnAddImage").addEventListener("click", () => {
    $("fileAddImage").value = "";
    $("fileAddImage").click();
  });
  $("fileAddImage").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await placeImageFile(file);
    } catch (err) {
      console.error(err);
      alert("Could not load image: " + err.message);
    }
  });

  $("btnUndo").addEventListener("click", undo);
  $("btnRedo").addEventListener("click", redo);
  $("btnZoomIn").addEventListener("click", () => setZoom(state.zoom * 1.2));
  $("btnZoomOut").addEventListener("click", () => setZoom(state.zoom / 1.2));
  $("btnZoomFit").addEventListener("click", zoomFit);
  $("btnZoomFitPage").addEventListener("click", zoomFitPage);
  $("btnPrint").addEventListener("click", printDocument);
  $("btnHelp").addEventListener("click", () => $("helpModal").classList.remove("hidden"));
  $("btnExport").addEventListener("click", exportPdf);
  $("btnConvert").addEventListener("click", () => $("convModal").classList.remove("hidden"));

  document.querySelectorAll(".modal-close").forEach((b) => {
    b.addEventListener("click", () => $(b.dataset.close).classList.add("hidden"));
  });
  document.querySelectorAll(".modal-backdrop").forEach((m) => {
    m.addEventListener("pointerdown", (e) => { if (e.target === m) m.classList.add("hidden"); });
  });
}

function wireSidebar() {
  $("pgAdd").addEventListener("click", addBlankPageAfterCurrent);
  $("pgDup").addEventListener("click", duplicateCurrentPage);
  $("pgDelete").addEventListener("click", deleteCurrentPage);
  $("pgRotL").addEventListener("click", () => rotateCurrentPage(-1));
  $("pgRotR").addEventListener("click", () => rotateCurrentPage(1));
  $("pgUp").addEventListener("click", () => moveCurrentPage(-1));
  $("pgDown").addEventListener("click", () => moveCurrentPage(1));
  $("pgExtract").addEventListener("click", extractCurrentPage);
  $("navPrev").addEventListener("click", () => gotoPage(state.current - 1));
  $("navNext").addEventListener("click", () => gotoPage(state.current + 1));
}

function wireTools() {
  document.querySelectorAll(".tool").forEach((b) => {
    b.addEventListener("click", () => setTool(b.dataset.tool));
  });
}

const TOOL_KEYS = {
  v: "select", t: "text", p: "draw", h: "highlight", r: "rect",
  e: "ellipse", l: "line", a: "arrow", w: "whiteout",
};

function wireKeyboard() {
  document.addEventListener("keydown", (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "z" && !inField) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (k === "y" && !inField) { e.preventDefault(); redo(); }
      else if (k === "s") { e.preventDefault(); exportPdf(); }
      else if (k === "f") { e.preventDefault(); openSearch(); }
      else if (k === "p") { e.preventDefault(); printDocument(); }
      else if (k === "c" && !inField && selectedObj()) { e.preventDefault(); copySelected(); }
      else if (k === "v" && !inField && objClipboard) { e.preventDefault(); pasteClipboard(); }
      else if (k === "d" && !inField && selectedObj()) { e.preventDefault(); duplicateSelected(); }
      return;
    }
    if (inField) return;

    const k = e.key.toLowerCase();
    if (e.key === "?") { $("helpModal").classList.toggle("hidden"); return; }
    if (TOOL_KEYS[k]) { setTool(TOOL_KEYS[k]); return; }
    if (k === "i") { $("btnAddImage").click(); return; }
    if (k === "s") { $("btnSign").click(); return; }

    if (e.key === "Delete" || e.key === "Backspace") {
      if (state.selId) { e.preventDefault(); deleteSelected(); }
      return;
    }
    if (e.key === "PageDown") { e.preventDefault(); gotoPage(state.current + 1); return; }
    if (e.key === "PageUp") { e.preventDefault(); gotoPage(state.current - 1); return; }

    const sel = selectedObj();
    if (sel && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      pushUndo();
      moveObject(sel, JSON.parse(JSON.stringify(sel)), dx, dy);
      renderOverlay();
      scheduleThumb();
    }
  });
}

// ----------------------------------------------------------------- init ----

window.addEventListener("DOMContentLoaded", () => {
  wireTopbar();
  wireSidebar();
  wireTools();
  wireProps();
  wireKeyboard();
  wireDragDrop();
  wireSignatures();
  wireSearch();

  // Ctrl+scroll zooms toward the page.
  viewer.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  setTool("select");
  newDocument("letter", "portrait");
  $("docName").value = "untitled";
  tryOfferRestore();
});
