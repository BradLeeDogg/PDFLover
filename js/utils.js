/* ========== PDFLover shared utilities ========== */
"use strict";

const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle, BlendMode } = PDFLib;

pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

let _uid = 0;
function uid() { return "o" + (++_uid) + "_" + Date.now().toString(36); }

/** Parse "#rrggbb" into a pdf-lib rgb() color. */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Trigger a browser download for raw bytes. */
function downloadBytes(bytes, filename, mime) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function readFileAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsArrayBuffer(file);
  });
}

function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsText(file);
  });
}

function loadImageFromDataURL(dataUrl) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Could not load image"));
    img.src = dataUrl;
  });
}

function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** pdf-lib's standard fonts only support WinAnsi; replace anything outside Latin-1. */
function sanitizeWinAnsi(text) {
  return text.replace(/\t/g, "    ").replace(/[^\x20-\x7E\xA0-\xFF\n\r]/g, "•");
}

/** Map a pdf-lib standard font from family + style flags. */
function standardFontFor(family, bold, italic) {
  const F = StandardFonts;
  switch (family) {
    case "Times":
      return bold && italic ? F.TimesRomanBoldItalic
           : bold ? F.TimesRomanBold
           : italic ? F.TimesRomanItalic
           : F.TimesRoman;
    case "Courier":
      return bold && italic ? F.CourierBoldOblique
           : bold ? F.CourierBold
           : italic ? F.CourierOblique
           : F.Courier;
    default:
      return bold && italic ? F.HelveticaBoldOblique
           : bold ? F.HelveticaBold
           : italic ? F.HelveticaOblique
           : F.Helvetica;
  }
}

/** CSS font stack matching the standard PDF font families. */
function cssFontFamily(family) {
  switch (family) {
    case "Times": return 'Times, "Times New Roman", serif';
    case "Courier": return '"Courier New", Courier, monospace';
    default: return "Helvetica, Arial, sans-serif";
  }
}

/** Page sizes in PDF points. */
const PAGE_SIZES = {
  letter: [612, 792],
  legal: [612, 1008],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
};

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
