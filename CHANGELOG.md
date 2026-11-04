# Changelog

Semantic versioning, staying 0.x until the planned feature set exists. Minor = new feature, patch = fix.

## 0.1.1 (unreleased)
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
