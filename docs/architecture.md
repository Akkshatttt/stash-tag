# Architecture

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
| Code.js | `doGet`, `invCall`, `setup` |
| AppPage.html | Two-tab phone page |

Rules: pure logic stays free of Apps Script APIs so Node tests can load it; names ending `_` are private; text cells are written as plain text.

Tests: `logic_test.js` (pure + API with fake fetch), `server_test.js` (setup/scan/confirm/search on fake sheets), `page_test.js` (page script on a fake DOM).
