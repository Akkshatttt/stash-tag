# stash-tag

Stash Tag keeps an inventory of electronic components bought from DigiKey and Mouser in a Google Sheet. A phone web app adds stock by photographing the barcode on the pack, then looks the part up through the DigiKey and Mouser APIs.

## Setup
1. `npm install`, `npx clasp login`, then `npx clasp create-script --type sheets --title Inventory --rootDir .` (a script bound to a new sheet is the fastest; a standalone script needs the `SHEET_ID` property and is slower per call). Creating the project overwrites `appsscript.json`: restore the repo's copy before pushing.
2. `npx clasp push -f`.
3. In the Apps Script editor run `setup()` once. It creates the sheets and a `TOKEN` Script property.
4. Script properties `DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET` (a DigiKey app subscribed to Product Information v4) and `MOUSER_KEY`. In this workspace `npm run keys` copies a snippet that sets them from the altium project's `private/` folder; paste it into the editor, run `tmpSetKeys`, delete it.
5. Deploy > New deployment > Web app (execute as you; access anyone). Later releases reuse it: `npm run release -- "message"`.
6. Open `<exec url>?page=app&t=<TOKEN>` on your phone (slow to open; the fast way is below).

## Fast page on Cloudflare Pages (optional, free)
1. Cloudflare dashboard > Workers & Pages > Create > Pages > connect this GitHub repo. Build command `node tools/build_web.js`, build output directory `web`.
2. Storage & Databases > D1 > create a database (e.g. `stash-tag`). In the Pages project: Settings > Bindings > add D1 database, variable name `DB`. The table is created on first use.
3. Pages project > Settings > Variables and Secrets: secret `TOKEN` (same value as the Script property) and `EXEC_URL` (the web app /exec URL). Redeploy the Pages project after adding them.
4. Open `https://<project>.pages.dev/#t=<TOKEN>` once; the page remembers the token and removes it from the address bar.

## Sheets
| Sheet | Contents |
|---|---|
| Resistors, Capacitors, Inductors, Power ICs, Transceivers, Misc | One row per group: passives by value and package, other parts by part number |
| Log | One line per stock addition |
| Cache | Hidden; every looked-up part, permanently. DigiKey/Mouser are called only for parts not in here (the Cloudflare D1 cache sits in front of it when the page is served from Cloudflare) |

## Tests
`npm test` runs the label parser, normaliser, API layer, server path and page against fakes. No network needed.
