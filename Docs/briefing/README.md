# Briefing

A presentation and its supporting document, covering this fleet's architecture,
security model and guardrails.

| File | What it is |
|---|---|
| `bounding-the-boundary.pdf` | The briefing deck — 24 slides, 13.333in x 7.5in |
| `supporting-document.pdf` | The supporting technical document — 13 pages, US Letter |
| `*.html` | The sources those PDFs are rendered from |

## Regenerating

There is no build step and no toolchain to install. Both PDFs come out of
headless Chrome, and each HTML file is self-contained — inline CSS, system
fonts, no external assets.

```sh
gtimeout 90 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$PWD/bounding-the-boundary.pdf" \
  "file://$PWD/bounding-the-boundary.html"
```

Two things worth knowing before editing either file:

- **Chrome writes the PDF and then does not exit.** Bound it and treat the
  timeout as success; confirm from the `bytes written to file` line rather than
  from the exit code.
- **`pdfinfo` is the only reliable overflow check for the supporting document.**
  Its pages use `min-height`, so the box grows to fit and a DOM `scrollHeight`
  probe reports clean whether or not a section has spilled onto a second sheet.
  The deck is 24 pages and the supporting document 13; any other count means
  something overflowed. To find *which* page, measure each `.page`'s
  `offsetHeight` against 1056px rather than its `scrollHeight`.
