# Changelog

Semantic versioning, staying 0.x until the planned feature set exists. Minor = new feature, patch = fix.

## 0.2.0 (unreleased)
- **New:** Live scan button (camera overlay): reads frames, looks the part up, shows a popup with the detected part and asks before it opens the normal part card. Separate from the photo button.
- **Changed:** photo and live decoding now use zxing-wasm (CDN) and read every barcode in the picture at full resolution, so a whole-packet photo works; the old ZXing-js code stays as a fallback. The server takes all barcodes of a label (`texts`) and fills a missing part number from the 1D bars (Mouser prints one per field).
- **Fixed:** a full, un-zoomed DigiKey bag photo decodes (tested on real photos in `samples/`).

## 0.1.1
- Parser checked against real DigiKey and Mouser label strings (samples/NOTES.md, not committed). A Mouser 2D code has no part number: the customer part number in `P` is no longer searched and the app says so. `P` counts as a supplier PN only when it looks like one. A stray prefix before `[)>` (Mouser `>[)>06`) is ignored.
- Photo decode tries Data Matrix alone first, then the 1D formats, so a 1D bar on the label cannot win.
- The not-found card shows the decoded text, parsed fields and the number searched.

## 0.1.0 (2026-11-04)
Run `setup()` once in the editor, then add the Script properties listed in the README.
- **New:** one sheet per category (Resistors, Capacitors, Inductors, Power ICs, Transceivers, Misc) plus `Log` and a hidden `Cache`.
- **New:** web app with an Add stock tab (photo of the pack label, ZXing decode, or typed part number) and a Search tab.
- **New:** ISO 15434 label parser, DigiKey Product Information v4 and Mouser Search lookups with caching, 404 keyword fallback and 429 retry.
- **New:** every looked-up part is stored permanently (hidden `Cache` sheet, plus a 6 h CacheService layer) under all its part numbers, so DigiKey and Mouser are only called for parts never seen before.
- **New:** low-latency design: one-row sheet access, inventory loaded once and searched in the page, no whole-sheet reads on scan or add.
- **New:** passives with the same value and package share one row, whatever the part number or tolerance.
