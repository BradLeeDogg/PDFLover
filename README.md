# PDFLover

An all-in-one **PDF Creator / Editor / Converter** that runs entirely in your browser.
No server, no uploads, no build step — your files never leave your machine.

## Getting it

### 🖥️ Desktop app (Windows / macOS / Linux)

Installers are built by GitHub Actions:

1. Go to the repo's **Actions** tab → **Build desktop apps** → **Run workflow** (or push a tag like `v1.0.0` to also create a GitHub Release with the installers attached).
2. When the run finishes, download the artifact for your OS. The installed app registers as a handler for `.pdf` files ("Open with → PDFLover"), has a native menu, and remembers its window size:
   - **Windows** — `PDFLover-…-Setup.exe` (installer) or the `portable` `.exe` (no install needed)
   - **macOS** — `.dmg` (unsigned: right-click → Open the first time)
   - **Linux** — `.AppImage` (make executable, run) or `.deb`

Or build locally (needs Node.js 18+):

```bash
npm install
npm start          # run the desktop app
npm run dist       # build the installer for your current OS into dist/
```

### 🌐 Browser version

No install needed — open `index.html` directly, or serve the folder with any static server:

```bash
python3 -m http.server 8080
# then visit http://localhost:8080
```

## Features

### 🗎 Create
- Start a new PDF from scratch (Letter / A4 / Legal / A5, portrait or landscape)
- Add, duplicate, reorder, rotate, and delete pages
- Build pages with text, shapes, images, and freehand drawing
- Export the finished document as a real PDF

### 📋 Fill in forms
- Fillable PDFs (AcroForms) are detected automatically — a status hint shows how many fields were found
- Click a field to type into it; checkboxes, radio buttons, and dropdowns work with a click
- Pre-filled values are picked up and editable; form edits are part of undo/redo
- On export the form is **flattened**: your values become permanent page content that every viewer shows identically

### ✏️ Edit imported PDFs
- Open any PDF and edit it page by page
- **Text** — click anywhere to type; Helvetica / Times / Courier, bold, italic, any size & color
- **Draw** — freehand pen with adjustable color and stroke width
- **Highlight** — translucent multiply-blended highlighter
- **Shapes** — rectangles, ellipses, lines, and arrows, with optional fills
- **Whiteout** — cover up existing content, then type over it
- **Redact** — permanently remove content: on export the page is flattened to an image with the covered area destroyed (metadata is stripped too)
- **Images** — place PNG / JPG / WebP images (signatures, stamps, logos)
- Select, move, resize, restyle, and delete anything you've added
- Rotate pages — annotations stay pinned, even in the export
- Append pages from other PDFs (`Insert PDF`)
- Extract any single page as its own PDF
- Full undo / redo
- **Export PDF** bakes everything into a standard PDF you can share

### ✍️ Sign
- Draw, type, or upload your signature once — it's saved for reuse
- One click stamps it on the page; drag and resize into position

### 🅰 OCR scanned PDFs
- One click recognizes text in scanned pages — fully offline (Tesseract engine and English model are bundled)
- Recognized text becomes searchable with `Ctrl+F`
- Exports gain an invisible text layer: the scan looks identical but is selectable and text-extractable in any viewer

### 🧭 Navigate & produce
- **Select & copy text** from any page (`X` tool) — works on native text and OCR'd scans alike
- **Continuous scrolling** — all pages in one smooth scroll, rendered lazily as you go; the page indicator and thumbnails track your position
- **Find in document** (`Ctrl+F`) with match highlights and next/previous navigation
- **Print** (`Ctrl+P`) — pages print exactly as shown, including fills and annotations
- **Copy / paste / duplicate** objects (`Ctrl+C / V / D`)
- Fit-width and fit-page zoom; `?` shows a keyboard shortcut reference

### 🔒 Protect & organize
- **Redact** sensitive content so it's truly gone from the exported file (not just hidden like whiteout)
- **Password-protect exports** (AES encryption): click the lock next to Export, set a password, and the exported file requires it to open
- **Metadata**: edit title/author/subject/keywords, or strip all metadata before sharing (⚙ Document)
- **Watermark** every page (text, color, angle, opacity) with a live preview
- **Page numbers, headers & footers** with `{n}` / `{total}` placeholders and a start value
- **Bookmarks / outline**: view and jump to an imported PDF's outline, add your own, and they're written into the exported PDF

### 🛟 Quality of life
- **Drag & drop** PDFs or images anywhere onto the window to open/place them
- **Drag page thumbnails** to reorder pages
- **Autosave** — work is continuously saved in your browser; if the tab or app closes, you're offered a one-click restore on next launch
- `Ctrl+scroll` to zoom; toast notifications for important events
- A safety note when using whiteout on original content (the text underneath remains recoverable in exports from unprotected PDFs)

### ⇄ Compare
- Compare two PDFs and see the differences per page: a visual pixel diff (green = added, red = removed) and a word-level text diff
- Reports pages changed and total words added/removed; download a highlighted diff PDF
- Runs entirely locally — neither file is uploaded

### 🔁 Convert
| Conversion | Details |
|---|---|
| Images → PDF | Combine PNG / JPG / WebP into one PDF (or open the result in the editor) |
| PDF → Images | Render every page to PNG / JPEG at 72–216 dpi, downloaded as a ZIP |
| Text → PDF | Paginated, word-wrapped Letter pages from a `.txt` file or pasted text |
| PDF → Text | Extract all text into a `.txt` file |
| Merge PDFs | Join any number of PDFs in order |
| Split PDF | Break a PDF into page ranges (`1-3, 4, 5-8`) |

## Keyboard shortcuts

| Key | Action |
|---|---|
| `V` `T` `P` `H` `R` `E` `L` `A` `W` | Select / Text / Pen / Highlight / Rect / Ellipse / Line / Arrow / Whiteout |
| `X` | Select & copy text from the page |
| `Shift+R` | Redact (permanently remove on export) |
| `I` / `S` | Insert image / Place signature |
| `Ctrl+F` | Find in document |
| `Ctrl+P` | Print |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+S` | Export PDF |
| `Ctrl+C` / `Ctrl+V` / `Ctrl+D` | Copy / Paste / Duplicate selected object |
| `Delete` | Delete selected object |
| Arrow keys (+`Shift`) | Nudge selected object (×10) |
| `PageUp` / `PageDown` | Previous / next page |
| `Ctrl+Scroll` | Zoom |
| `?` | Keyboard shortcut reference |

## Tech

Plain HTML/CSS/JS. Libraries (vendored in `vendor/`, so it works offline):

- [pdf.js](https://mozilla.github.io/pdf.js/) — page rendering & text extraction
- [pdf-lib](https://pdf-lib.js.org/) — PDF creation, editing, and export
- [JSZip](https://stuk.github.io/jszip/) — ZIP downloads for batch conversions
