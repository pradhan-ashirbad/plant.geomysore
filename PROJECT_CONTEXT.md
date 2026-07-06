# PROJECT CONTEXT — Jonnagiri Gold Project (Geomysore) Plant Dashboard

> Handoff file for continuing work in a new session. Read this fully before
> making changes. Last updated: 2026-07-06, branch `test` == `main` at commit
> `c353990`.

## What this project is

A Node.js/Express + vanilla-JS SPA plant-monitoring dashboard for a gold
processing plant (Jonnagiri Gold Project), converted from an old Google Apps
Script system. Deployed on **Vercel** (auto-deploys from `main`), database is
**Supabase Postgres** (`DATABASE_URL` env var).

- Backend: `server.js` → `src/routes.js` → `src/data.js` (all business logic)
  → `src/db.js` (storage routing) → Postgres via `src/pool.js`.
- Frontend: `public/index.html` + `public/app.js` (one big vanilla-JS file) +
  `public/style.css`. Chart.js 4.4.1 via CDN (+ chartjs-plugin-zoom, hammerjs).
- Auth: JWT stateless sessions (`src/auth.js`), roles: supervisor, management,
  process1/2/3, meeting. Passwords are sha256 hashes in a `users` table.

## Git workflow (IMPORTANT — user's standing rule)

- **Develop on `test` branch, push to `test`.**
- **Merge to `main` ONLY when the user explicitly says so** ("push to main" /
  "merge to the main branch"). Merges so far have been clean fast-forwards.
- Vercel production deploys from `main`. The user tests on the test-branch
  deployment first.

## Storage architecture (three tiers — this is the key design)

`src/db.js` presents a Google-Sheets-like interface (`getSheet`,
`getSheetByDate`, `getSheetHeaders`, `appendRow`, `updateRow`,
`deleteAllRows`) and routes each "sheet" to one of:

1. **Normalized long-format stores** (checked first):
   - `src/leachingStore.js` → tables `leaching_readings` (LT4–LT10; nacn, ph,
     dissolved_oxygen, au, overflow; UNIQUE(entry_date, time_slot, tank)) and
     `detox_readings` (DT1–DT4; role feed/outlet; UNIQUE same). 6 daily time
     slots: 03:00, 07:00, 11:00, 15:00, 19:00, 23:00.
   - `src/slurryStore.js` → table `slurry_readings` (12 tanks LT3–LT10 +
     DT1–DT4, one Au-in-Solids reading per tank per day,
     UNIQUE(entry_date, tank)).
   - Both **auto-create their tables on first use** (no manual Supabase SQL
     needed). Both pivot normalized rows back into the legacy wide-row shape
     (per `columnDefsFor(sheet)` in `src/sheetUtils.js`) so data.js/app.js
     never know the difference.
   - Both use **COALESCE upserts**: an incoming NULL never overwrites a stored
     value (critical — a DO-only partial write once wiped NaCN/pH/Au before
     this was fixed). Below-detection lab values ("<0.3") are stored as the
     numeric threshold + a `*_below_detection` boolean flag.
2. **Typed tables** (`src/typedTables.js`): only `crushing` so far — a 1:1
   column mirror of the wide row.
3. **Generic `sheet_rows` JSONB store**: everything else (Milling, Chemical,
   Filter Press, Cyclone, Screen, Thickener, GC, Elution, ILS, Gold,
   Stoppage Reason, Stock Inward, LIMITS, TARGETS, Chemical Inventory).

## Section config (`src/config.js`)

- Tanks: `LT_TANKS = LT4..LT10`, `DT_TANKS = DT1..DT4` (DT = **Detox** tanks,
  NOT "discharge"), `SLURRY_AU_TANKS = LT3 + LT_TANKS + DT_TANKS` (LT3 is real
  for slurry only).
- The chemistry param is called **NaCN** everywhere (user's explicit choice;
  source Excel sometimes says "CN" — import scripts alias it).
- Dashboard grouping: Milling card absorbs Cyclone+Thickener; Leaching card
  absorbs Slurry+Carbon+Screen as sub-tabs — BUT Slurry has been removed from
  the sub-tab bar (frontend filters it out) and is instead rendered as a chart
  block on the Leaching page itself.
- Limits: per-tank limitIds `LT_NACN_<tank>`, `DT_NACN_<tank>`, `LT_AU_<tank>`,
  `DT_AU_<tank>`, `SLURRY_AU_<tank>`; shared `LEACH_PH`, `LEACH_DO`,
  `DETOX_PH`. Params can carry `limitLabel` for a friendly Limits-editor name.
- Stoppage Department options: Mechanical / Electrical / O&M / Operation /
  Others.
- `STOPPAGE_SECTION_ALIASES` in `src/data.js`: the stoppage log's free-text
  Section column uses GRINDING / BALL MILL (= milling), LEACHING & DETOX
  (= leaching), FILTER PRESS(-01/-02) (= filterpress), GRAVITY
  CONCENTRATOR-01 (= gc). Matching is by this alias map — do not revert to
  label substring matching (it made Milling/GC show zero stoppages).

## Frontend patterns (`public/app.js`)

- **Shared customizable multi-series chart** ("Production Trend" /
  "Leaching Trend"): `productionTrendBlockHtml(title, canvasId, gearOnclick)`,
  `buildProductionTrendChart(sectionKey, data, canvasId)`,
  `openTrendSeriesManager(sectionKeyOverride, canvasIdOverride, dataOverride)`.
  Series are persisted per section in localStorage (`trendSeries:<key>`),
  Y-axis min/max override in `trendYRange:<key>`. Series with different units
  auto-split onto separate Y-axes. The customizer modal (`#modal-chart-customize`)
  has collapsible "+ Add series" / "Axis range" panels, compact rows with an
  L/B/A/S type toggle, and (for tank sections) a parameter dropdown +
  multi-select tank chips.
- Leaching page = heatmap (tanks as columns, time rows, Average row; NaCN/pH/
  Au/DO selector; month view collapses to the 6 canonical slots showing
  slot-averages) + one "Leaching Trend" chart (with a "🔗 Sync with heatmap"
  toggle — when on, chart follows the heatmap's parameter for all LT tanks)
  + the Slurry "Au in Solids" block (`loadSlurryBlock`) + stoppages.
- Slurry block: day view = fixed bar chart (tanks on x-axis, fixed per-tank
  colors in `SLURRY_TANK_COLORS`); month/range = customizable multi-line.
- Stoppages block (every section): summary "N stoppages · X hrs" +
  (month/range only) a doughnut by Department; table below lists reasons.
- Target tracking: `kpiTargetTileHtml` renders a full-row KPI tile (cumulative
  | semicircle gauge with % and 0→target range labels | Current Rate &
  Required Rate icon rows). Backend `_computeTargetProgress` in data.js;
  status: ≥100% ON_TARGET green, 80–99% WARNING yellow, <80% BEHIND red.
- Client cache: stale-while-revalidate (`cacheGet`/`cacheIsStale`; render
  cached instantly, background-refresh if >45s old, keep 10 min). Applied to
  dashboard, section detail, alerts. Writes call `cacheClear()`.
- `buildChart` sets a Chart.js v4 base `type` from the first dataset
  (default 'line') — removing this makes line charts render blank.

## Historical data import (Admin → "Leaching History Backfill" panel)

One supervisor-only route `POST /api/admin/import-leaching-history` accepts up
to 4 files (fields: `leaching`, `detox`, `slurry`, `stoppage`) and runs the
matching `db/migrate-*-history.js` parser. All parsers accept a Buffer or
path (`loadWorkbook` in `db/_leachExcelUtils.js`) and go through the normal
`db.appendRow` path.

- Leaching workbook: one sheet per day (names like `01.04`); headers vary by
  sheet (tank sets differ, Au sometimes missing, a Sept layout has
  Shift/Operator and NO in-cell date — year is inferred from sibling sheets,
  `--year=YYYY` / year field as fallback). 22 April sheets carry a second
  "D O (ppm)" mini-table lower down with its own Time column — parsed
  explicitly (was silently dropped once; 120 rows recovered).
- Detox workbook: consistent headers "Detox T1 Feed / T4 Outlet ..." — only
  DT1/DT4 have history; DT2/DT3 start from live entries (role currently null).
- Slurry workbook: single sheet, "Tank→" header with "LT 3"-style spaced
  names, one row per date.
- Stoppage workbook: DATE/SECTION forward-filled, DURATION is an Excel
  time-of-day (converted to decimal hours; one bare `24` = 24h).
  **No unique key → re-uploading duplicates rows** (UI warns; tank sheets are
  idempotent upserts and safe to re-run).
- All parsers were verified against the real files (row counts + spot values,
  plus an independent re-parse for Leaching/Detox): 435 leaching rows,
  160 detox, 30 slurry, 198 stoppage (Crushing 97, Milling 10, Leaching 4,
  Filter Press 86, GC 1).

## Testing conventions used here (no test framework in repo)

- Backend store logic: standalone Node scripts that monkey-patch
  `require.cache` for `src/pool.js` with a mock `query`, then assert on the
  captured SQL/params. (Previously kept in the session scratchpad — not in
  the repo.)
- Frontend: headless harness stubbing `document`/`localStorage`/`Chart` to
  capture chart configs, then `eval(app.js)` and call functions directly.
- End-to-end: spin up the real Express app on an ephemeral port with a mocked
  pool + `auth.validateSession`, POST real multipart uploads of the real
  Excel files.
- `node --check <file>` after every edit.

## Known quirks / gotchas

- Vercel + Supabase needs the **pooler connection string** (port 6543); the
  direct 5432 endpoint once caused "Could not reach database" login failures.
- The app returns HTTP 200 with `{error}` in the body for auth/validation
  failures on most `handle()`-wrapped routes — check the JSON, not the status.
- The generic Admin → "Import Data" panel only reads the FIRST sheet of a
  workbook with a single uniform header row — it cannot ingest the plant's
  multi-sheet logs; that's what the Backfill panel is for.
- `_computeAutoCalc` recomputes TPH etc; Gold's Cumulative needs history.
- The user's data years look odd but are correct: April 2026 files coexist
  with Sept 2025 sheets in the same workbook.
- Crushing section is **frozen** — user said do not change it anymore.

## Progress checklist

Done: Crushing (typed table, KPIs, target gauge tile, Production Trend chart,
stoppages) · Milling basics (generic store; absorbs Cyclone/Thickener tabs) ·
Leaching (normalized tables, heatmap, customizable trend, sync toggle,
per-tank limits, backfill) · Detox (in leaching tables, DT1–DT4) · Slurry
(normalized table, block on Leaching page, backfill) · Stoppage Reason
(summary + dept doughnut on every section, alias fix, backfill) · Targets
(monthly targets, progress gauges month+day) · Limits editor (per-tank) ·
Alerts page · Monthly report + Pareto · Excel export · Import tools · Users ·
stale-while-revalidate caching.

## Likely next work (user's stated direction)

1. **Milling section proper build-out** — was explicitly deferred ("we will
   work on the leaching section first"). Earlier proposed plan: migrate
   Milling to a typed table like Crushing, verify shared features, then ask
   what Milling-specific features are wanted. The user's `milling.xlsx`
   uploads carried a Sheet1 with Date / Running Hours / Production — likely
   the Milling daily log format.
2. Remaining sections in similar style: Carbon in Tank, Filter Press, GC,
   Elution, ILS, Gold — the user tends to go section by section, sharing the
   real Excel log for each and asking for: correct schema matching the real
   sheet, charts (day = bar by entity, month = lines over time), limits, and
   a backfill importer.
3. DT2/DT3 detox `role` values still unassigned (feed/outlet unknown).
4. User must still upload historical files on production after each deploy
   (tank sheets safe to re-run; stoppage only once).

## Working style the user expects

- Plan first when asked ("tell me your plan, then I say build") — do NOT
  build before confirmation in those cases.
- Push to `test`, describe changes in plain lists ("list out what you did").
- The user sends screenshots to point out UI problems; expect iterative
  visual feedback and blunt corrections. Keep UI consistent with the existing
  maroon/gold theme (CSS vars in `:root` of style.css).
- Verify with the real Excel files before claiming an importer works; state
  row counts.
