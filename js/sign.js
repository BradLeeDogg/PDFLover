/* ==========================================================================
   PDFLover digital signatures — standards-compliant PKCS#7 detached
   signatures embedded in a PDF signature field, produced entirely in the
   browser with node-forge. Signatures are self-signed (a personal identity
   stored locally), so validators show "signed, identity not trusted" but
   any modification after signing is detected. PDFLover verifies both the
   integrity (content digest) and authenticity (signature over attributes).
   ========================================================================== */
"use strict";

const SIG_RESERVED = 8192;   // bytes reserved for the PKCS#7 blob
const SIG_STORE = "pdflover.identity";

// ---- byte <-> binary-string helpers (browser has no Buffer) ----
function u8ToBinary(u8) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return s;
}
function binaryToU8(str) {
  const u8 = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) u8[i] = str.charCodeAt(i) & 0xff;
  return u8;
}

// ---- signing identity (self-signed cert + key), cached in localStorage ----
function loadIdentity(name) {
  try {
    const j = JSON.parse(localStorage.getItem(SIG_STORE));
    if (j && j.name === name && j.certPem && j.keyPem) {
      return { name, cert: forge.pki.certificateFromPem(j.certPem), key: forge.pki.privateKeyFromPem(j.keyPem) };
    }
  } catch (e) { /* regenerate */ }
  return null;
}

function makeIdentity(name) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
  const attrs = [{ name: "commonName", value: name }, { name: "organizationName", value: "PDFLover (self-signed)" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  try {
    localStorage.setItem(SIG_STORE, JSON.stringify({
      name, certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    }));
  } catch (e) { /* signing still works this session */ }
  return { name, cert, key: keys.privateKey };
}

function getSigningIdentity(name) {
  return loadIdentity(name) || makeIdentity(name);
}

// ---- add a signature field + placeholder to a pdf-lib document ----
function addSignaturePlaceholder(pdfDoc, name, reason) {
  const { PDFName, PDFNumber, PDFString, PDFHexString, PDFArray, PDFDict } = PDFLib;
  const ctx = pdfDoc.context;
  const page = pdfDoc.getPages()[0];

  const byteRange = PDFArray.withContext(ctx);
  byteRange.push(PDFNumber.of(0));
  byteRange.push(PDFName.of("**********"));
  byteRange.push(PDFName.of("**********"));
  byteRange.push(PDFName.of("**********"));

  const sigDict = PDFDict.withContext(ctx);
  sigDict.set(PDFName.of("Type"), PDFName.of("Sig"));
  sigDict.set(PDFName.of("Filter"), PDFName.of("Adobe.PPKLite"));
  sigDict.set(PDFName.of("SubFilter"), PDFName.of("adbe.pkcs7.detached"));
  sigDict.set(PDFName.of("ByteRange"), byteRange);
  sigDict.set(PDFName.of("Contents"), PDFHexString.of("0".repeat(SIG_RESERVED * 2)));
  sigDict.set(PDFName.of("Reason"), PDFString.of(reason || "Signed with PDFLover"));
  sigDict.set(PDFName.of("Name"), PDFString.of(name));
  sigDict.set(PDFName.of("M"), PDFString.of(pdfDate(new Date())));
  const sigRef = ctx.register(sigDict);

  const widget = PDFDict.withContext(ctx);
  widget.set(PDFName.of("Type"), PDFName.of("Annot"));
  widget.set(PDFName.of("Subtype"), PDFName.of("Widget"));
  widget.set(PDFName.of("FT"), PDFName.of("Sig"));
  widget.set(PDFName.of("Rect"), ctx.obj([0, 0, 0, 0]));
  widget.set(PDFName.of("V"), sigRef);
  widget.set(PDFName.of("T"), PDFString.of("Signature1"));
  widget.set(PDFName.of("F"), PDFNumber.of(132));
  widget.set(PDFName.of("P"), page.ref);
  const widgetRef = ctx.register(widget);

  const annots = page.node.lookup(PDFName.of("Annots"), PDFArray);
  if (annots) annots.push(widgetRef);
  else page.node.set(PDFName.of("Annots"), ctx.obj([widgetRef]));

  const acro = PDFDict.withContext(ctx);
  const fields = PDFArray.withContext(ctx);
  fields.push(widgetRef);
  acro.set(PDFName.of("Fields"), fields);
  acro.set(PDFName.of("SigFlags"), PDFNumber.of(3));
  pdfDoc.catalog.set(PDFName.of("AcroForm"), ctx.register(acro));
}

function pdfDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

// ---- compute the byte range, sign, and splice the PKCS#7 blob in ----
function signPdfBytes(pdfU8, identity) {
  let s = u8ToBinary(pdfU8);
  const biAnchor = s.indexOf("/ByteRange");
  if (biAnchor < 0) throw new Error("No signature placeholder found");
  const ci = s.indexOf("/Contents", biAnchor);
  const ltPos = s.indexOf("<", ci);
  const gtPos = s.indexOf(">", ltPos);
  const hexStart = ltPos + 1;
  const hexEnd = gtPos;
  const placeholderLen = hexEnd - hexStart;

  const br = [0, hexStart, hexEnd, s.length - hexEnd];
  const brOpen = s.indexOf("[", biAnchor);
  const brClose = s.indexOf("]", brOpen);
  const realBR = `[${br[0]} ${br[1]} ${br[2]} ${br[3]}]`;
  const fieldLen = brClose + 1 - brOpen;
  if (realBR.length > fieldLen) throw new Error("ByteRange field too small");
  s = s.slice(0, brOpen) + realBR + " ".repeat(fieldLen - realBR.length) + s.slice(brClose + 1);

  const toSign = s.slice(0, hexStart) + s.slice(hexEnd);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(toSign);
  p7.addCertificate(identity.cert);
  p7.addSigner({
    key: identity.key,
    certificate: identity.cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });
  let hex = forge.util.bytesToHex(forge.asn1.toDer(p7.toAsn1()).getBytes());
  if (hex.length > placeholderLen) throw new Error("Signature larger than reserved space");
  hex = hex.padEnd(placeholderLen, "0");

  s = s.slice(0, hexStart) + hex + s.slice(hexEnd);
  return binaryToU8(s);
}

/** Verify a signed PDF: integrity (content digest) + authenticity (RSA
    signature over the signed attributes). Returns a status object. */
function verifySignedPdf(pdfU8) {
  const s = u8ToBinary(pdfU8);
  const bi = s.indexOf("/ByteRange");
  if (bi < 0) return { signed: false };
  const brOpen = s.indexOf("[", bi);
  const brClose = s.indexOf("]", brOpen);
  const br = s.slice(brOpen + 1, brClose).trim().split(/\s+/).map(Number);
  if (br.length !== 4 || br.some(isNaN)) return { signed: false };
  const [a, b, c, d] = br;
  const content = s.slice(a, a + b) + s.slice(c, c + d);

  const hex = s.slice(a + b, c).replace(/(00)+$/, "");
  const derHex = hex.length % 2 ? hex.slice(0, -1) : hex;
  const result = { signed: true, signer: null, signedAt: null, integrity: false, authenticity: false, valid: false };
  try {
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.hexToBytes(derHex)));
    const cert = p7.certificates && p7.certificates[0];
    const rc = p7.rawCapture || {};
    if (cert) {
      const cn = cert.subject.getField("CN");
      result.signer = cn ? cn.value : "(unknown)";
    }
    let msgDigest = null;
    for (const attr of rc.authenticatedAttributes || []) {
      const oid = forge.asn1.derToOid(attr.value[0].value);
      if (oid === forge.pki.oids.messageDigest) msgDigest = attr.value[1].value[0].value;
      else if (oid === forge.pki.oids.signingTime) result.signedAt = attr.value[1].value[0].value;
    }
    const md = forge.md.sha256.create();
    md.update(content);
    result.integrity = msgDigest != null && md.digest().bytes() === msgDigest;

    if (cert && rc.signature && rc.authenticatedAttributes) {
      const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, rc.authenticatedAttributes);
      const amd = forge.md.sha256.create();
      amd.update(forge.asn1.toDer(set).getBytes());
      result.authenticity = cert.publicKey.verify(amd.digest().bytes(), rc.signature);
    }
  } catch (e) {
    return { signed: true, error: e.message, integrity: false, authenticity: false, valid: false };
  }
  result.valid = result.integrity && result.authenticity;
  return result;
}

// Expose for editor.js (export hook) and headless tests.
window.pdfSign = { addSignaturePlaceholder, signPdfBytes, verifySignedPdf, getSigningIdentity, SIG_RESERVED };

// -------------------------------------------------------------- UI wiring ----
(function () {
  const $s = (id) => document.getElementById(id);

  function fmtDate(t) {
    if (!t) return "";
    // CMS signingTime is UTCTime "YYMMDDHHMMSSZ"; PDF /M is "D:YYYYMMDD...".
    let m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(t);
    if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC`;
    m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z?$/.exec(t);
    if (m) return `20${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC`;
    return t;
  }

  window.addEventListener("DOMContentLoaded", () => {
    // Sign-on-export toggle lives in the Document modal (wired there); here we
    // handle the Verify panel.
    const verifyBtn = $s("sigVerifyGo");
    if (verifyBtn) {
      verifyBtn.addEventListener("click", async () => {
        const f = $s("sigVerifyFile").files[0];
        const out = $s("sigVerifyResult");
        if (!f) { out.textContent = "Choose a PDF to verify."; out.className = "sig-verify-result"; return; }
        out.textContent = "Verifying…";
        out.className = "sig-verify-result";
        try {
          const u8 = new Uint8Array(await readFileAsArrayBuffer(f));
          const r = verifySignedPdf(u8);
          if (!r.signed) { out.textContent = "This PDF is not digitally signed."; out.className = "sig-verify-result warn"; return; }
          if (r.error) { out.textContent = "Could not parse the signature: " + r.error; out.className = "sig-verify-result bad"; return; }
          if (r.valid) {
            out.className = "sig-verify-result good";
            out.textContent = `✓ Valid signature — unmodified since signing. Signer: ${r.signer}` +
              (r.signedAt ? ` · ${fmtDate(r.signedAt)}` : "") + " (self-signed identity).";
          } else if (!r.integrity) {
            out.className = "sig-verify-result bad";
            out.textContent = `✗ Document has been MODIFIED after signing. Signer: ${r.signer || "unknown"}.`;
          } else {
            out.className = "sig-verify-result bad";
            out.textContent = `✗ Signature is not authentic (bad signature). Signer: ${r.signer || "unknown"}.`;
          }
        } catch (e) {
          out.textContent = "Verify failed: " + e.message;
          out.className = "sig-verify-result bad";
        }
      });
    }
  });
})();
