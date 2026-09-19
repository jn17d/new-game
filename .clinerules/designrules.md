# Design Rules

## UI Structure

- **Context popovers anchored to map/building objects** for interaction (claim building, open production menu, etc.) — no persistent sidebar dashboard.
- **Slim top HUD** for global info only: money, time, minimap toggle. Keep it minimal — don't let it grow into a second dashboard.
- Only render UI for objects currently in the viewport. This mirrors how map data and multiplayer sync are scoped (see Architecture Principle below) — one mental model throughout the stack.

## Visual Style

- **Flat panels**, single solid background color. No translucency, no glassmorphism.
- **Thin, hard border** on every panel — must read clearly against any map terrain/zoom level.
- **One subtle drop-shadow maximum**, just enough to lift a panel off the map. Never dual-shadow / neumorphic soft-shadow techniques — low contrast against a busy, colorful live map makes elements disappear, and it clashes with the hard-edged pixel art.
- **Chunky, high-contrast buttons** for anything clickable. Err toward "obviously a button" over subtle affordance.
- Hard edges throughout, to match the PixiJS pixel-art building sprites rather than fight them.

## Deferred / Future Work

- Full pixel-art skeuomorphic panel treatment (bitmap fonts, sprite-based borders) is a valid upgrade path once the core loop (claim → produce → ship) is validated. Swapping flat-panel CSS for sprite-based panels later is a small lift; redesigning information architecture later would not be.

## Rejected Options (with reasons)

- **Persistent sidebar dashboard** — scales well with feature growth but reads as "an app," not a game, and reduces map visibility.
- **Retro pixel-art skeuomorphic UI (as a starting point)** — good identity fit, but requires real art investment before the core loop is proven. Revisit later.
- **Neumorphism** — low contrast against a live/colorful map background, clashes with crisp pixel-art sprites, subtle shadow states hurt clickability, and doesn't scale cleanly once more than a few panels are on screen.

## Architecture Principle (for context)

Viewport-scoping is the unifying idea across the stack, not just the UI:
- **Map data**: vector tiles (PostGIS + Martin, or PMTiles) loaded per-viewport instead of a global static blob.
- **Multiplayer sync**: clients subscribe to updates only for buildings/regions in view; server pushes deltas (or clients poll) scoped the same way.
- **UI**: popovers/HUD only render for what's in view.

Keeping all three scoped to "what's on screen" is what makes a single shared global world tractable.
