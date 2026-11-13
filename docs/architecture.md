# Architecture

```
static page (web/index.html, Cloudflare Pages) --POST /api--> functions/api.js (Pages Function)
   scan with keys: D1 table parts (key -> record) hit -> answer, no Google call
   anything else / miss: POST EXEC_URL -> doPost (Code.js) -> invCall; a found part is written to D1
```
The same AppPage.html is also served by Apps Script (`doGet`, google.script.run); `tools/build_web.js` fills its template tags for the static build.

```
phone page (AppPage.html) --google.script.run--> invCall (Code.js)
   photo -> ZXing -> text                          |-- load:    inventory snapshot (CacheService) or one read per sheet
   search runs in the page (clientLib_)            |-- scan_:   parseLabel_ (Barcode.js)
                                                   |            lookupPart_ (Api.js) -> CacheService / Cache sheet / DigiKey / Mouser
                                                   |            classify_ (Normalize.js) -> category, Group Key
                                                   `-- confirm_: findRow_ (TextFinder) -> upsertRow_ (Inventory.js) -> that row + Log, snapshot patched
```

| File | Role |
|---|---|
| Util.js, Config.js | Pure helpers; categories, columns, settings |
| Barcode.js | ISO 15434 label parser (pure) |
| Normalize.js | API response to record, value/package/spec parsing, Group Key (pure) |
| Inventory.js | Merge into rows, search (pure) |
| Api.js | `UrlFetchApp` DigiKey and Mouser clients, supplier order, retries |
| Store.js | The only code that touches cells; lookup cache |
| Code.js | `doGet`, `doPost` (JSON API), `invCall`, `setup` |
| functions/api.js | Cloudflare Pages Function: token check, D1 part cache, forward to Apps Script |
| tools/build_web.js | Builds the static page into `web/` |
| AppPage.html | Two-tab phone page |

Rules: pure logic stays free of Apps Script APIs so Node tests can load it; names ending `_` are private; text cells are written as plain text.

Tests: `logic_test.js` (pure + API with fake fetch), `server_test.js` (setup/scan/confirm/search on fake sheets), `page_test.js` (page script on a fake DOM, both hosts), `cloud_test.js` (Pages Function with fake D1 and fetch).
