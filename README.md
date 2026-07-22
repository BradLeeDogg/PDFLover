# PDFLover

An all-in-one **PDF Creator / Editor / Converter** that runs entirely in your browser.
No server, no uploads, no build step — your files never leave your machine.

## Running it

Open `index.html` directly, or serve the folder with any static server:

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

### ✏️ Edit imported PDFs
- Open any PDF and edit it page by page
- **Text** — click anywhere to type; Helvetica / Times / Courier, bold, italic, any size & color
- **Draw** — freehand pen with adjustable color and stroke width
- **Highlight** — translucent multiply-blended highlighter
- **Shapes** — rectangles, ellipses, lines, and arrows, with optional fills
- **Whiteout** — cover up existing content, then type over it
- **Images** — place PNG / JPG / WebP images (signatures, stamps, logos)
- Select, move, resize, restyle, and delete anything you've added
- Rotate pages — annotations stay pinned, even in the export
- Append pages from other PDFs (`Insert PDF`)
- Extract any single page as its own PDF
- Full undo / redo
- **Export PDF** bakes everything into a standard PDF you can share

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
| `I` | Insert image |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+S` | Export PDF |
| `Delete` | Delete selected object |
| Arrow keys (+`Shift`) | Nudge selected object (×10) |
| `PageUp` / `PageDown` | Previous / next page |

## Tech

Plain HTML/CSS/JS. Libraries (vendored in `vendor/`, so it works offline):

- [pdf.js](https://mozilla.github.io/pdf.js/) — page rendering & text extraction
- [pdf-lib](https://pdf-lib.js.org/) — PDF creation, editing, and export
- [JSZip](https://stuk.github.io/jszip/) — ZIP downloads for batch conversions
