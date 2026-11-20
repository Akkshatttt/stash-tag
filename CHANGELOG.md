# Changelog

Semantic versioning, staying 0.x until the planned feature set exists. Minor = new feature, patch = fix.

## 0.9.4 (fixes after the fourth phone test)
- **New (Google Sheet mirror):** the Sheet is written from the app's data, one way (D1 to Sheet), **15 minutes after the last change**. Every change in the app sends a hint to Apps Script (`sync_hint`); a 5-minute trigger (`syncTick`) writes the Sheet when a hint is pending and 15 quiet minutes have passed. Tabs: one per top category (a row per part number: group, value, package, spec, total qty, boxes, part numbers, description, last change), `Packets` (a row per live packet) and `Log` (last 1000 changes). Each run rewrites its tabs completely; old-layout tabs with no new equivalent are cleared and marked. The export is a new Function action (`inv_export`) that the shared token may call even when a password is set (nothing else); no Cloudflare setting changed. One step for the owner: run `syncSetup` once in the Apps Script editor (permission + trigger); `syncNow` writes the Sheet at once.
- **Changed (Search):** opening a group closes the one that was open.
- **Changed (Scan page):** a card with two big icon tiles (Live scan, Take photo), a lookup row and a heading per mode; the page titles stay black (the accent colour is for buttons and highlights).

## 0.9.3 (fixes after the third phone test)
- **Changed:** one Scan page with an **Add stock | Update stock** switch (the Transact tab is gone; tabs are Scan and Search). Add stock reads a label and shows the add form; Update stock shows the take / add / set count / move panel for a packet already in stock. A known packet scanned in Add stock asks "Do you want to change something?" and Yes switches to Update stock; an unknown one in Update stock offers "Add it as new stock". Update stock has its own orange accent. The mode is remembered.
- **New:** every take, add, set count and move asks for confirmation first in a pop-up that says what will happen ("Take 5 from X? This packet goes from 50 to 45 pcs."); Cancel does nothing.
- **New:** package is a dropdown of standard sizes plus **Other (type it)** with a text box, for any chip part (inductors rarely have a standard package); the server accepts any typed package.
- **New:** sensor sub-categories: Motion (accel / gyro / IMU), Magnetic, Temperature & Humidity, Current, Pressure, Optical & Proximity, Other Sensors (migration 3 re-files existing sensors by their supplier category text).
- **Changed (Search):** compact cards: name and stock on one line (green when in stock, red at 0), one line of description, one line of small facts; the open card is marked with an accent bar and tint; the search words are highlighted; smaller title.

## 0.9.2 (fixes after the second phone test)
- **Changed:** important states are now big red or green blocks, not lines of text: PART ALREADY IN STOCK (Scan tab, add form and live scan), PACKET FOUND / USED UP / REMOVED and THIS PACKET IS NOT IN STOCK (Transact), PART NOT FOUND, NEW PART, WARNING; the result banner is larger with a coloured border.
- **New:** Search shows 25 groups at a time with "Load more (N left)"; a new search or filter starts from the first page; loading more makes no server call.
- **Changed:** the Count tab is hidden from the tab bar until it is reworked (page code, server action and its tests stay).
- **New (scan filters):** `enhance_` in `src/Decode.js`, linear and about 10 ms for a 1280 px frame on a desktop. 'clean' = best-contrast channel + percentile stretch + [1 2 1] smoothing (wipes speckle and dirt: on a real DigiKey label with 1% speckle the plain read fails and this reads); 'auto' = stretch only. Plain frames are used while they read; after two empty live frames the variants alternate with plain frames (clean, plain, auto, plain), so a good label never pays; a photo that fails is retried as clean, then auto. Debug info shows "filter clean/auto". Tried and dropped: a local (adaptive) threshold, which added cost and read nothing the decoder did not already read.

## 0.9.1 (fixes and small additions after the first phone test of 0.9.0)
- **New:** Transact tab (Scan, Transact, Search, Count). A label already in stock is offered "Do you want to change something?"; in live scan the camera keeps running until you answer, Yes opens the packet in Transact, No resumes scanning. A label not in stock offers to add it in the Scan tab.
- **Changed (feedback):** every request locks all buttons and tabs until the server answers (a second tap cannot repeat an action), the tapped button says what it is doing, and a banner shows the result (green clears itself, red stays). Each change carries a request id; the server refuses the same id twice.
- **Changed (forms):** labelled fields; dropdowns have a chevron and a tinted background, text boxes are white and bordered; required fields are starred and red until filled, with a "Still needed: ..." line, and Add stays disabled. The box is required (server too); a box is never pre-filled. Category must be chosen (Unsorted is not offered), description must not be empty.
- **New (chip passives):** Mouser parts with no size in the text: package, value and tolerance are read from `ProductAttributes`, then the description, then the part number of known series (Vishay CRCW, Yageo RC/AC, Panasonic ERJ, KOA RK73, Samsung CL, Murata GRM, TDK C, KEMET C), then one DigiKey lookup by MPN (cached; counted in the usage panel), else the person fills the required field. Values read from the part number are marked "please check it". Missing optional values (voltage, dielectric, power, tolerance, current) are fields in the form; Add with blanks asks "N values are missing, add anyway?".
- **Changed (categories):** resistors: General Purpose, Precision, Current Sense, Zero-Ohm Jumpers, Arrays & Networks, Potentiometers & Trimmers, High Power / Wirewound, Other; capacitors: MLCC, Aluminum Electrolytic, Tantalum & Polymer, Film, Supercapacitors, Trimmer / Variable, Other (chip / through hole removed). Migration 2 re-files existing parts; the supplier-category mapping is no longer learned for resistors and capacitors.
- **New (edit):** in Search, "Edit packet" (take / add / set count / move) and "Edit part" (description, category, value, package, other parameters; the part moves to the matching group, an emptied group is removed). Descriptions of chip passives follow the DigiKey pattern (`RES 402K OHM 1% 1/10W 0603`).
- **Changed:** the Lot field is gone from the form; lot and date code are still read from the label and kept on the packet (and in the duplicate check).

## 0.9.0 (deployed 2026-11-20)
- **New (D1 is now the inventory):** tables for categories (own 2-level taxonomy, Unsorted instead of Misc), groups, parts, boxes, packets (own qty and box, fingerprint unique), and a transaction log with the name of who made each change. Schema versioned in `lib/schema.js`, created on first use. Old Sheet rows are not migrated (clean start); the supplier record cache (`parts`) is kept.
- **New:** packet fingerprint from the label (`fingerprint_` in Barcode.js): a label already in stock is recognised before any lookup and is never added twice; the page offers add / take / set / move instead. Emptied packets are archived, so their label stays blocked.
- **New:** take / add / set count / move box on any packet, never below zero; reason on take is a deployment setting (`REQUIRE_REASON=1`, off by default); Count tab (cycle count of a box, differences logged as corrections); live scan recognises a packet in stock and asks how many are added or taken inside the camera overlay; Mouser 2D codes with invoice and line are recognised without a part number.
- **New:** Search with category tiles that drill down, removable filter chips, an in-stock toggle, groups that open into part numbers and packets, per-part edit of description and category (saved, logged, and remembered for the next new part of that supplier category). Passive descriptions: DigiKey wording, or a template for Mouser parts.
- **Changed:** the page needs a name (sign-in card, shown on every change) and runs on Cloudflare only: the Apps Script /exec page is retired (it cannot reach D1). Apps Script stays for the Sheet mirror (sync not built yet).
- **Tests:** `tests/inv_test.js` runs the API on a real SQLite (node:sqlite) behind a D1-shaped wrapper (`tests/d1.js`); `cloud_test.js` now uses it too.

## 0.8.1 (unreleased)
- **New:** debug info shows API calls made today (UTC) per provider, DigiKey and Mouser, as N / 1000. The Cloudflare Function counts every product request it sends (retries included, token requests not) in a D1 table `usage` (day, provider, n), created on first use. Page action `usage` reads it; the Apps Script page says the counter lives on the Cloudflare page. Lookups made by Apps Script itself are not counted.

## 0.8.0 (released)
- **Changed (UI):** rebuilt after the iOS grouped-list style, light mode only. Large title, bottom tab bar, white rounded groups on a grey canvas with hairline separators, 44-50 pt rows, one filled primary button per screen. Search: one rounded search field with magnifier and clear button, scrolling category chips, sort menu, results as full rows (value, quantity at the right, category, spec, location, description, part numbers). Add: Live scan first, Take photo, type-a-part-number with Look up; the part card is a grouped list (sheet, quantity, location, lot) with Add to stock. The overlapping search controls of 0.7.1 are gone (checked in a rendered 500 px screenshot).
- **Removed:** the DigiKey | Mouser switch. The label says who printed it (`detectSupplier_`: Mouser 2D has 14K, DigiKey 30P or -ND; a bare NNN-xxx bar is Mouser). One reader for every label: 2D code first; only a 2D code with no part number goes on to read the 1D bars; live looks for the 2D code in a 1280 px copy and builds the 4K frame only when bars must be read.
- **Changed (API calls):** lookups are one at a time, best first, first hit stops: the supplier part number, then the MPN on the same supplier, then the MPN on the other supplier (never a guessed or leftover bar), leftover bars on the label supplier only. A clean "not found" is remembered in D1 for 6 hours so rescanning the same packet costs no request. Tests count the calls.

## 0.7.1 (folded into 0.8.0)
- **Changed (UI only, no new code paths):** phone-first look after Apple HIG basics. System colours that follow light/dark automatically, 17px body text, 44-50px touch targets, tab bar fixed at the bottom (thumb reach, clear of the home indicator) with two icons, DigiKey | Mouser as a segmented control, one filled blue primary button per card with tinted secondary buttons, grouped rounded cards, safe-area padding, press feedback. CSS and one markup line; page size and load path unchanged.

## 0.7.0 (released)
- **Changed (speed):** a button press now runs only what it needs. Confirm: the row number is remembered in CacheService and verified by reading that one row (no scan of the sheet); the lock covers only the row write, the log line and a small cache patch; the inventory cache is one set of chunks per category (a confirm rewrites one category, not the whole inventory); no spreadsheet call for the time zone; the spreadsheet is opened only when a sheet is needed; Script properties are read once per execution; a new Cache-sheet row is found with one key-column read; one retry (not two) on a supplier 429/5xx.
- **New (speed):** a scan is answered by the Cloudflare Function without Apps Script: it parses the label, asks D1, and on a miss calls DigiKey and Mouser itself (first two candidates side by side), then stores the part in D1. Needs the Pages secrets `DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET`, `MOUSER_KEY`; without them a scan is forwarded to Apps Script as before. The D1 table is created on first use, not on every cold isolate.
- **New (Mouser scan):** the Mouser P/N bar is read the way invscan does it: 2D code, then every Code128 over the whole frame at the camera's native size, nearest to the 2D code, strict `NNN-...` pattern; the strips stay as the fallback. Live asks the camera for 4K with continuous focus and no longer downscales Mouser frames; photos keep up to 4096 px and are turned upright by EXIF. Tested on the user's photos turned 90/180/270 degrees and tilted 4 degrees, normal and live (fast) mode.
- **New:** a bar that only looks like an MPN (no `NNN-` pattern) is flagged "Unverified" on the card; live needs two frames to agree on a bar before it looks anything up.
- **New:** "Show debug info" under the Add stock card (and in the live view): decoder state, frame size, 2D found, stage (2d / full / strips), Code128 count, strips tried, part number, milliseconds. The wasm decoder is warmed up at page load so a load failure shows at once.

## 0.6.0 (released)
- **New:** DigiKey | Mouser scan mode on the Add stock card and in the live camera, remembered on the phone and sent with each scan.
- **Changed:** DigiKey mode reads only the Data Matrix (faster; live asks as soon as the label shows a part number, no one-second wait).
- **New:** Mouser mode reads the 2D code; when it has no manufacturer PN (orders with a customer P/N replace 1P by P), it reads the 1D bars as thin strips anchored on the 2D code, deskewed by its angle and scaled in one pass (`mouserRead_`, `labelStrip_` in Decode.js). The user's three real Mouser photos now give the Mouser P/N in 0.04-0.21 s each; before, 2 of 3 failed.
- **Fixed:** Mouser's vertical label code (e.g. 467DPD) was taken as the manufacturer PN; in Mouser mode it is ignored.
- **New:** the page checks for a part number before calling the server; without one it shows "Which barcode is the part number?" with the bars read (live after about 6 s); a tapped bar is looked up with the label's quantity kept.

## 0.5.0 (unreleased)
- **New:** shared admin password for the Cloudflare page. With the Pages secret `PASSWORD` set, the page shows a sign-in card and `/api` accepts only that password (compared in constant time); the Function swaps it for the Apps Script token, which never reaches the phone. A wrong or changed password signs the browser out and clears its stored inventory. Without `PASSWORD` the `#t=` token works as before.

## 0.4.0
- **New:** the page can be served as a static site on Cloudflare Pages (`node tools/build_web.js` builds `web/index.html`), so it opens in well under a second instead of 3-6 s. It talks to `/api`, a Pages Function (`functions/api.js`) that forwards to the Apps Script `doPost`. The Apps Script page keeps working.
- **New:** central part cache in Cloudflare D1 (SQLite): a scan of a part already seen is answered by the Pages Function without calling Google or the suppliers. New parts are stored there under every part number they have.
- **New:** the page keeps the last inventory in localStorage, so Search works at once on open.
- **Changed:** `partKeys_` (Barcode.js) holds the lookup order and cache keys; the page computes the keys and sends them with each scan.

## 0.3.0 (unreleased)
- **New:** Search tab sorting like the distributor sites: sort by category, value (by size, so 100nF < 1uF < 4.7uF), package, quantity, location, part number or updated, ascending or descending, plus a category filter and a result count. Runs in the page; no server call.

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
