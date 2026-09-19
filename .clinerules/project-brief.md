# Project Brief: [Untitled] — Real-World Economy & Logistics Game

**Repo:** github.com/jn17d/new-game
**Current prototype:** `index.html` — a working single-town build (Chatteris, Cambridgeshire, UK)

## One-line pitch
A 2D, real-world-scale, browser-based economy sim where players build companies on real OpenStreetMap buildings and terrain — mining, farming, and manufacturing goods, then shipping them across the globe by sea and air.

## Inspirations
- **Capital Rift** (by Nik) — biggest inspiration. Persistent multiplayer economy sim on a real-world OSM map: food carts, property ownership, farming/ranching/mining, crafting chains, workers, player-run market, logistics network.
- **OpenFront.io** — liked the real-world-map approach and accessibility, but it's too simple for the depth of simulation this game wants (territory-only, no real economic depth).

## Core Concept
- Map is built from real-world OpenStreetMap data, rendered in 2D (not 3D like Capital Rift).
- Players can start their company **anywhere in the world** *(current prototype: one real town, not yet global — see Status)*.
- Real buildings exist on the map with real (approximate) footprints/sizes.

## Status
**Playable single-town prototype**, up from earlier brainstorm/concept and a since-abandoned 3D claiming demo. An early build via Cline produced unusable results (OSM buildings routinely failed to render, confusing overlay); the current `index.html` replaces that with a self-contained, working 2D build centered on Chatteris. UI design direction is settled (see `designrules.md`, referenced but not included in this file). Art style beyond the UI system and PixiJS sprite work is still undecided. Not yet started: global scope, sea/air/ground logistics, multiplayer, backend persistence, and the mining/farming production paths.

## Core Loop — what's actually implemented in the current prototype
1. **Start a company** — right-click any building to open a buy menu. The **first purchase must be a Headquarters**; every other building class is locked until HQ is owned.
2. **Acquire property**
   - Only buying existing buildings is implemented (no "build new" option yet).
   - Price = footprint area (m²) × **$10/m²** × a per-class cost multiplier. Starting cash: **$100,000**.
3. **Production** — factories don't auto-produce; players buy production "lines" per factory. Line capacity is capped by both floor area and the number of belt-module slots that physically fit the footprint. Each line outputs 1 unit per 10-second tick (the HQ bonus applies on top).
4. **Storage & logistics (local only, no world-scale shipping yet)**
   - No warehouses owned → a free "yard" holds up to 50 units.
   - Stock is tracked **per building**, not as one global pool — output/sales route to the nearest warehouse with room, then the yard, then overflow is auto-sold or scrapped.
   - Ships, aircraft, and ground transport (the global-shipping vision) are **not built** — everything currently sells to buyers local to the same map view.
5. **Selling — an NPC company market, not player-to-player yet**
   - Buyer "companies" are generated deterministically from each building's ID (a hash), so they exist anywhere without pre-authoring data — sector, UK-flavored name, a price that drifts each tick within a band, and demand that refills each tick.
   - Companies within ~2km of the camera appear on-map and in a toggleable Market panel; players sell manually (10 units / all demand / best price across the visible roster).
   - **Buyout mechanic:** a company's site can be bought outright (turns it into a player-owned office); the company then relocates to the nearest free site, keeping its name/sector/price, so it visibly "moves" rather than vanishing.
6. **Selling buildings back** — resells at 50% of purchase price. Selling a warehouse spills its stock into remaining storage/yard first; only true overflow is auto-sold to the nearest company (or scrapped if none nearby). Selling the HQ vacates the unique slot.
7. **Visual feedback** — zooming into an owned building past a threshold swaps to a PixiJS-rendered interior: factories show animated conveyor belts, warehouses show rack layouts with forklifts driving pick/drop routes. Animated crate sprites travel across the outdoor map between buildings to visualize production and sales shipments.
8. **Persistence** — entirely client-side via `localStorage` (ownership, wallet, per-building stock, HQ id). No backend or database yet. Includes non-destructive migration logic from at least one earlier save-file schema, so old saves aren't wiped by format changes.

## Key Differentiators from Inspirations
- Real-world scale and real building footprints (Capital Rift is 3D and stylized; this is 2D but geographically real like OpenFront).
- Deeper production/logistics chain than OpenFront (mining → manufacturing → global shipping) — *still aspirational; only the manufacturing/factory step exists today.*
- Global scale from the start — start anywhere, ship anywhere — rather than a single shared local map. *(Current prototype is scoped to one town.)*

## Scope Decisions / Simplifications (to manage difficulty)
- **2D instead of 3D** — top-down 2D rendering via MapLibre instead of a full 3D world (Three.js building-extrusion was used in an earlier prototype and dropped).
- Barebones v1 proves the core loop: acquire property → produce a resource → sell it. **Achieved for the manufacturing path**, on one town, single-player, local storage only.
- Depth still to add: more resource/production paths, a real market/trading system between players, competition/conflict, and the shipping layer.

## Current Prototype Implementation Notes
- **Rendering:** MapLibre GL JS (OpenFreeMap "liberty" vector tiles), locked to a flat 2D view (no pitch/rotate, pinch-rotate disabled). Turf.js for area/geometry math. PixiJS overlay for building-interior scenes (conveyor belts, forklifts, animated crate sprites), loaded from a companion sprite-sheet file.
- **Data:** the map's OSM building footprints for Chatteris were fetched once via Overpass and are shipped as a static companion file (`buildings-data.js`) rather than queried live at runtime. A second companion file (`machines-data.js`) holds base64-inlined pixel-art sprite sheets (conveyor, crate, forklift), generated by a build script (`build-machines-data.mjs`) from Piskel source art.
- **Delivery format:** the whole game is currently one self-contained `index.html` pulling MapLibre/Turf/PixiJS from CDN (unpkg) via `<script>` tags — there's no active TypeScript/Vite build behind this file, which is a departure from the originally confirmed tech-stack direction below. Worth resolving before the project grows further.
- **UI:** implements the settled `designrules.md` direction — flat dark hard-edge panels, one drop-shadow, chunky high-contrast buttons, a slim top HUD (cash, stock/capacity, sites owned by class, tick countdown, market toggle, reset), a right-click building context menu, and a toggleable market panel. Popovers are anchored to the map object they describe rather than living in a persistent sidebar.
- **Reset:** a two-step confirm button wipes ownership, wallet, stock, and market state back to defaults for testing.

## Open Questions / Future Depth (not yet built, noted for later)
- Expanding beyond the single Chatteris dataset toward regional/global coverage (originally scoped as UK & France for v1; region unlocking was meant to be data-driven, not hardcoded).
- Reconciling the current CDN/single-file delivery with the TypeScript + Vite build direction below (or deciding the CDN approach is fine going forward).
- Mining, farming, and other raw-resource-extraction paths — today only the "factory" processing step exists, with no upstream raw-material sourcing loop.
- Ships, aircraft, and possibly ground transport (trucks/rail) for actual world-scale shipping — the "sell to a nearby NPC company" market is a placeholder for this.
- A real player-to-player market/trading system (today's market is player-vs-NPC only).
- Backend/persistence (Postgres/PostGIS) and multiplayer sync — everything today is single-player, client-only `localStorage`.
- Any conflict/competition layer (economic competition vs. territorial).
- Art style — not yet decided beyond the functional UI system and pixel-art PixiJS sprites already in place.
- Drawing custom areas (mines, farms, custom buildings) via a `maplibre-gl-draw` layer — not yet implemented.

## Tech Stack — originally confirmed pre-prototype direction
*(Superseded in part by what's actually running in `index.html` above — kept here as the longer-term direction pending a decision.)*

- **MapLibre GL JS** — outdoor real-world navigable map, real building footprints, zoom/pan, pulling from a free hosted vector tile source (OpenFreeMap) rather than self-hosting a tile server. *(Matches current prototype.)*
- **Turf.js** (`@turf/area`, `@turf/intersect`, `@turf/union`, `@turf/boolean-point-in-polygon`, `@turf/centroid`, `@turf/buffer`) — geospatial math. *(Matches current prototype.)*
- **TypeScript + Vite** — build tooling, proven in an earlier prototype. *(Not present in the current single-file `index.html` build — see Open Questions.)*
- **PixiJS** — 2D sprite rendering for the "zoom into a building" interior view, once a claimed building is zoomed into past a threshold (same pattern as Capital Rift: walk inside, roof cuts away). Lighter than Three.js and purpose-built for 2D sprites. *(Matches current prototype — belts, forklifts, crates.)*
- **`maplibre-gl-draw`** — polygon-drawing layer for custom areas (mines, farms), combined with Turf for overlap/area validation. *(Not yet implemented.)*
- **Node.js + TypeScript backend** (not needed for the current prototype) — WebSocket support (Socket.io or `ws`) for future multiplayer sync; a simple server-side tick loop updating a database every X seconds. Go considered as a future upgrade path if Node's single-threaded model becomes a bottleneck.
- **PostgreSQL + PostGIS** (not needed until persisting game state beyond `localStorage`) — native geographic queries fit the game's real-world-coordinate core. Free-tier hosted options (Supabase, Neon) fine to start. Redis considered later for fast-changing state (live prices, active sessions).
- **Hosting** — no server needed for the current client-only prototype. Once persistence/backend is needed, the existing Proxmox/LXC home server setup is a natural fit (Postgres/PostGIS and Node backend each in their own LXC), moving to cloud only if bandwidth/uptime is outgrown.
- **Region scoping** — don't hardcode region limits into game logic; store unlocked regions as data so unlocking more of the world later is a data change, not a rewrite. *(Not yet needed — current prototype is one hardcoded town.)*

**Suggested research order going forward:**
1. Decide whether to keep the CDN/single-file approach or move to the TypeScript + Vite build.
2. Add the polygon-drawing tool (Turf + `maplibre-gl-draw`) for mines/farms/custom buildings, and a raw-resource production path to go with it.
3. Scope out what "expanding beyond Chatteris" requires — live Overpass queries vs. more pre-fetched regional datasets, and the data-driven region-unlock model.
4. Only then: Node.js + Postgres backend to persist ownership/state, followed by the resource-tick simulation moving server-side and multiplayer sync.
