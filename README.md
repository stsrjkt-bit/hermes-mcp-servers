# Hermes MCP Servers

Custom MCP (Model Context Protocol) servers for Hermes Agent worksheet/presentation workflows.

## Servers

### html-to-pdf
Convert HTML files to A4 PDF using Playwright. Supports multi-page merging via Ghostscript.

**Tools:**
- `html_to_pdf` — Convert HTML file(s) to merged A4 PDF
- `pdf_merge` — Merge multiple PDF files into one
- `pdf_info` — Get page count and metadata

### manim-png
Render Manim Python scenes to static PNG images for worksheet diagrams.

**Tools:**
- `manim_render` — Render a Manim scene class to PNG

## Setup

```bash
cd html-to-pdf && npm install
cd ../manim-png && npm install
```

Requires:
- Node.js 18+
- Playwright (for html-to-pdf)
- Manim Community Edition (for manim-png)
- Ghostscript + pdfinfo (for html-to-pdf)
