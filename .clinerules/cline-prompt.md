# Task: Procedural Building Interiors — Factory Floor, Warehouse, Office

## What this is

A single-file browser game (`index.html`) built on MapLibre GL JS + PixiJS v8.
The map shows real OSM building footprints for Chatteris, Cambridgeshire.
Players claim buildings (factory / warehouse / office / HQ) and run a simple
production loop. Claimed buildings currently render as a flat solid-colour
polygon fill on the map. The task is to replace that with procedurally-generated
pixel-art interiors that appear when zoomed in.

No new files. Everything goes into `index.html`. Do not restructure or move
existing code — insert into the marked locations.

---

## Existing architecture you must understand before writing code

### Rendering pipeline (two canvases, stacked)

1. **MapLibre GL** (WebGL) renders the basemap + building footprints as GeoJSON
   fill/line layers. Footprint colour comes from `feature-state` (`cls`, `co`)
   evaluated on the GPU. Source id: `'osm-buildings'`. Fill layer id:
   `'osm-buildings-fill'`.

2. **PixiJS v8** (`pixiApp`) renders over a transparent `<div id="pixi-overlay">`.
   `pointer-events: none` so clicks fall through to MapLibre.
   `antialias: false` — pixel art must never blur.

3. **HTML panels** (HUD, popovers) sit above both.

### PixiJS scene graph

```
pixiApp.stage
  └── beltRoot          (PIXI.Container) — conveyor belts, factory only, zoom ≥ 18
  └── boxRoot           (PIXI.Container) — animated delivery boxes
```

You will add `interiorRoot` **before** `beltRoot` so interiors render underneath belts.

### Key constants (already defined, do not redefine)

```js
const BELT_MIN_ZOOM = 18;    // belts appear at this zoom
const MODULE_M = 4;          // world metres per 32px belt module
const M_PER_DEG_LAT = 111320;
const CHATTERIS = [0.05030011035594765, 52.45514770133596];
```

### Key utilities (already defined, do not redefine)

```js
// FNV-1a 32-bit hash — deterministic per building id
hash32(str) → number

// Approximate ring centroid [lng, lat]
centroidOf(geometry) → [lng, lat]

// Footprint geometry by owned-building id
geometryFor(id) → GeoJSON geometry | null

// Turf area in m²
areaOf(id, geometry) → number

// Turf bounding box and longest-edge angle (used by belt layout)
bboxOfGeometry(id, geometry) → [minX, minY, maxX, maxY]
longestEdgeAngle(geometry, cy) → radians   // angle of longest wall

// Belt slot layout — returns { cx, cy, angle, slots: [{sx, sy}] }
// sx/sy are in "module-pixel space" (32px = MODULE_M metres)
// centred at 0,0, rotated to the building's longest wall.
// REUSE THIS — interiors use the same local coordinate frame.
layoutFor(id, geometry) → layout

// MapLibre project
map.project([lng, lat]) → {x, y}   // screen pixels

// MapLibre zoom
map.getZoom() → number
```

### Building class registry (already defined)

```js
const BUILDING_CLASSES = {
  factory:   { color: '#f5a623', uiColor: '#f5a623', ... },
  warehouse: { color: '#5c7aa8', uiColor: '#7c9ccb', ... },
  office:    { color: '#8e6cc9', uiColor: '#a98ce0', ... },
  hq:        { color: '#e6b422', uiColor: '#e6b422', ... }
};
```

### Owned building map

```js
const owned = new Map();   // id → { cls: string, ts: number, lines: number }
```

### Existing fill-opacity interpolation (in the MapLibre 'osm-buildings-fill' layer)

```js
'fill-opacity': [
  'interpolate', ['linear'], ['zoom'],
  13, 0.35,
  15, 0.75,
  17, 0.9
]
```

**You must change this** as part of the task (see Step 1 below).

### Where the PixiJS init block is

Search for this exact comment to find the async init block:

```js
// ---- PixiJS conveyor belts inside factory buildings ----
```

The init IIFE at the bottom of that section looks like:

```js
(async () => {
  try {
    pixiApp = new PIXI.Application();
    await pixiApp.init({ ... });
    ...
    beltRoot = new PIXI.Container();
    pixiApp.stage.addChild(beltRoot);
    boxRoot = new PIXI.Container();
    pixiApp.stage.addChild(boxRoot);
    ...
    pixiApp.ticker.add(() => renderBelts());
    pixiApp.ticker.add(() => renderBoxes());
  } catch (err) { ... }
})();
```

---

## What to build

### Visual spec

All drawing is in **local building coordinates**: metres, centred at (0, 0),
aligned to the building's longest wall (U axis = along the wall, V axis =
perpendicular). This is the same frame `layoutFor()` uses. PixiJS `cont.rotation`
and `cont.scale` handle the world-to-screen transform every frame — you draw once,
reproject cheaply.

**Light source: top-left. Shadow pixel: bottom-right, 1px, darker colour.**
**No anti-aliasing anywhere. Integer pixel coordinates in local space.**
**Outlines on everything: 1px darker border on every object.**

#### Smoothstep helper (add once near the top of your new code)

```js
const smoothstep = (edge0, edge1, x) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
```

#### Seeded RNG (add once, used by all three buildInterior branches)

```js
// LCG seeded from a building id hash — deterministic, not cryptographic
const seededRand = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xFFFFFFFF;
  };
};
```

---

### Factory floor

**Zoom trigger**: `INTERIOR_MIN_ZOOM = 16` (defined below)

**Colours**
| element | hex |
|---|---|
| concrete base | `#8c8880` |
| floor grid lines | `#7a7770` |
| loading zone fill | `#2a2a22` |
| loading zone stripe (yellow) | `#f0c000` |
| loading zone border | `#e6b400` |
| box brown (3 variants) | `#8B6344` `#5C3D1E` `#A0785A` |
| box shadow pixel | `#3a2a14` |
| box outline | `#3a2a14` |

**Drawing steps** (order matters — bottom to top):

1. **Concrete base**: draw a filled rectangle covering the inset polygon's
   bounding box in local space. Use `#8c8880`. Clip to the footprint using a
   PixiJS Graphics mask (see clipping section below).

2. **Floor grid**: draw horizontal lines (parallel to V axis) every `2` metres
   across the full extent, colour `#7a7770`, lineWidth 1. These are in local
   space so they follow the building orientation automatically.

3. **Loading zone** (centre band):
   - Zone spans the middle **40%** of the V extent (`vMin + 0.3*vRange` to
     `vMin + 0.7*vRange`), full U extent.
   - Fill the zone `#2a2a22`.
   - Draw 45° diagonal yellow stripes: lines from top-left to bottom-right of
     the zone, `#f0c000`, lineWidth 2, spaced every `6px` in local pixels
     (i.e. every `6 / (32 / MODULE_M)` metres — recalculate to metres for the
     Graphics call). Use a stencil approach: draw stripes across a larger area
     and clip to the zone rectangle using a nested mask, OR simply iterate
     across the zone and draw clipped line segments.
   - Draw a solid border around the zone: `#e6b400`, lineWidth 2.

4. **Scattered boxes** (outside the loading zone):
   - Count: `Math.max(3, Math.min(12, Math.floor(areaM2 / 40)))` boxes.
   - Use seededRand seeded from `hash32(id + ':floor')`.
   - Place each box at a random point in the inset polygon's V extent, avoiding
     the loading zone (reject points in zone range and retry up to 10 times).
   - Box size: `2m × 2m` to `3m × 3m` (randomly chosen from the seeded rand).
   - Rotation: pick from `[0, 15, -12, 90]` degrees, converted to radians.
   - Box fill: one of the 3 colour variants, chosen by `rand() * 3 | 0`.
   - Draw: filled rect for body, 1px outline in `#3a2a14`, single 1px shadow
     pixel rectangle offset by (1, 1) in `#3a2a14` (drawn before the body).

---

### Warehouse floor

**Colours**
| element | hex |
|---|---|
| concrete | `#7e8080` |
| aisle floor | `#8a8c8c` |
| rack upright | `#3a3a3a` |
| rack shelf | `#555555` |
| aisle safety line | `#c8a000` (dashed) |
| aisle shadow | `#6a6c6c` |

**Drawing steps**:

1. **Concrete base**: filled rect, `#7e8080`, clipped to footprint.

2. **Rack aisles**:
   - Aisles run **perpendicular to the longest wall** (i.e. along the V axis,
     dividing the building in the U direction). This means each aisle is a
     vertical strip when looking at the building aligned to its longest wall.
   - Aisle count: `N = Math.max(2, Math.floor(uExtent_m / 5))` where
     `uExtent_m` is the building's extent along the U axis in metres.
   - Alternate strips: even-indexed = rack bay (1.8m wide), odd-indexed = walkway
     (the remainder, roughly `uExtent_m / N - 1.8`m).
   - For each **rack bay**:
     - Draw a slightly lighter rect for the rack structure background: `#555555`.
     - Draw 2 upright lines (the rack end uprights): `#3a3a3a`, lineWidth 2, at
       the left and right edge of the bay.
     - Draw horizontal shelf lines across the bay at every `0.8m` of V extent:
       `#555555`, lineWidth 1.
   - For each **walkway**:
     - Draw a slightly lighter concrete rect: `#8a8c8c`.
     - Draw a dashed centre line: `#c8a000`, lineWidth 1, dashes every 2m
       (alternate 1.5m drawn, 0.5m gap). PixiJS Graphics has no native dash;
       implement as alternating rect segments.

3. **Aisle shadow**: draw a 2px rect on the right edge of each rack bay: `#6a6c6c`.

---

### Office floor

**Colours**
| element | hex |
|---|---|
| carpet | `#7a6e8a` |
| carpet dither (alt pixel) | `#6e6280` |
| partition wall | `#c0b4d4` |
| desk surface | `#c8bc98` |
| desk shadow | `#a89c7c` |
| chair | `#3c3448` |
| corridor | `#8a7e9c` |
| meeting room border | `#d4c8e8` |

**Drawing steps**:

1. **Carpet base**: filled rect `#7a6e8a` clipped to footprint. Then overlay a
   dithered pattern: draw 1px rects in `#6e6280` at every even (u_px, v_px)
   coordinate where `(u_px + v_px) % 2 === 0`. Step in 2px increments across
   the extent in local pixel space (1 local pixel = `32 / MODULE_M` metres — use
   2px steps for the dither, which is `2 * MODULE_M / 32` metres per step).
   **Keep the dither step loop bounded**: cap iterations at 2000 total to avoid
   stalling on large buildings. If the building is large enough to exceed this,
   skip the dither (plain carpet is fine).

2. **Central corridor**: a single strip `1.5m` wide running along the full U
   extent at the V midpoint. Fill `#8a7e9c`. This divides cubicles into two
   banks.

3. **Cubicles** (above and below the corridor):
   - Cubicle cell size: `4m × 3m` (U × V).
   - Fill the space between the wall and the corridor edge with a grid of cells.
   - Rows above and below the corridor (so 2 banks).
   - For each cell:
     - Partition walls: 1px lines on the right and bottom edges (or top for the
       lower bank), colour `#c0b4d4`.
     - Desk: a `2m × 1m` rect in one corner (top-left), fill `#c8bc98`, 1px
       shadow rect offset (1,1) in `#a89c7c`.
     - Chair: a `0.7m × 0.7m` filled circle (approximated as rect for pixel
       art) in `#3c3448`, positioned `0.5m` in front of the desk.

4. **Meeting room**: at one end (high-U side), a `6m × (vExtent - 2)m` enclosed
   space. Draw a `#d4c8e8` border (2px). Inside: a `3m × 1.5m` table rect in
   `#c8bc98`, centred.

---

### Clipping to the footprint polygon

PixiJS Graphics supports masks. For each building, create a mask Graphics that
draws the footprint polygon in local coordinates, then assign it to the container.

Convert the footprint geometry from `[lng, lat]` to local building coordinates
using the same transform that `layoutFor()` uses:

```js
// cx, cy, angle from layoutFor(id, geometry)
// mLon = M_PER_DEG_LAT * Math.cos(cy * Math.PI / 180)
// For each [lon, lat] ring vertex:
//   ex = (lon - cx) * mLon
//   ny = -(lat - cy) * M_PER_DEG_LAT
//   local_u = (ex * cosA + ny * sinA) / MODULE_M * 32   // → local px
//   local_v = (-ex * sinA + ny * cosA) / MODULE_M * 32
```

Draw the ring as a `Graphics.poly(points).fill(0xffffff)`, then set
`container.mask = maskGraphics`. Add the maskGraphics as a child of the container
so it transforms with it.

**Important**: the mask only needs to be built once per building (it's in local
space and doesn't change when the map pans/zooms). Cache it alongside the rest of
the interior container. Only the container's `position`, `rotation`, and `scale`
change each frame.

---

## Implementation plan — exact steps

### Step 1: Adjust MapLibre fill-opacity

Find the `'osm-buildings-fill'` layer paint block. Change `fill-opacity` so owned
buildings fade out at high zoom (making way for the PixiJS interior):

```js
'fill-opacity': [
  'case',
  // Owned buildings: fade out as interior becomes visible
  ['has', ['feature-state', 'cls'], ['literal', ['factory','warehouse','office','hq']]],
  // NOTE: MapLibre expression for "feature-state cls is not empty":
  // Use ['!=', ['feature-state', 'cls'], null] instead
  ['interpolate', ['linear'], ['zoom'], 13, 0.3, 15, 0.7, 17, 0.5, 18, 0.0],
  // Unowned and NPC buildings: normal opacity
  ['interpolate', ['linear'], ['zoom'], 13, 0.35, 15, 0.75, 17, 0.9]
]
```

Actually, MapLibre feature-state expressions don't support `has` on state like
that. Use a simpler approach — two separate fill layers:

- Keep `'osm-buildings-fill'` for unowned/NPC buildings (filter:
  `['==', ['feature-state', 'cls'], null]` is not valid either).

The cleanest solution: add a **second fill layer** `'owned-buildings-fill'`
sourced from the same `'osm-buildings'` source, with a **feature-state filter**
for owned buildings. Then set each layer's opacity independently:

```js
// Layer 1: 'osm-buildings-fill' (all buildings) — keep current opacity
// Layer 2: 'owned-buildings-fill' (added after layer 1) —
//   same colour paint as existing, but opacity fades to 0 by zoom 18

map.addLayer({
  id: 'owned-buildings-fill',
  type: 'fill',
  source: 'osm-buildings',
  paint: {
    'fill-color': [ /* same match expression as osm-buildings-fill */ ],
    'fill-opacity': [
      'interpolate', ['linear'], ['zoom'],
      15, 0.0,   // not visible until z15
      16, 0.8,   // briefly more opaque (before interior kicks in)
      17, 0.4,
      18, 0.0    // invisible at belt zoom — PixiJS has taken over
    ],
    'fill-outline-color': [ /* same as existing */ ]
  },
  filter: ['!=', ['feature-state', 'cls'], '']  // only owned buildings have cls set
});
```

Add this layer immediately after `map.addLayer` for `'building-highlight-layer'`.
Update `setFeatureState` calls (the existing ones that set `cls`) — they don't need
to change. The filter `['!=', ['feature-state', 'cls'], '']` will match any building
that has had its `cls` feature-state set to a non-empty string.

**Test**: at zoom 18+ above a claimed factory, the solid fill should be invisible
and the PixiJS interior (and belts) take over completely.

---

### Step 2: Add the smoothstep helper and seededRand

Find the comment `// ---- PixiJS conveyor belts inside factory buildings ----`
and insert before it:

```js
// ---- Interior rendering utilities ----
const smoothstep = (edge0, edge1, x) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

const seededRand = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xFFFFFFFF;
  };
};

const INTERIOR_MIN_ZOOM = 16;   // interior appears
const INTERIOR_FULL_ZOOM = 17;  // fully opaque (belts overlay at 18)
```

---

### Step 3: Add the `buildInterior(id, cls, geometry)` function

Insert after the `seededRand` block and before the existing belt constants.
This function builds a `PIXI.Container` in local building coordinates and returns
it. It is called **once per building** when the building first becomes visible at
`INTERIOR_MIN_ZOOM`; after that only position/rotation/scale change.

```js
const buildInterior = (id, cls, geometry) => {
  const layout = layoutFor(id, geometry);
  const { cx, cy, angle } = layout;
  const mLon = M_PER_DEG_LAT * Math.cos(cy * Math.PI / 180);
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const PX = 32 / MODULE_M;   // pixels per metre in local space

  // Convert a [lng, lat] ring to local [px, px] points
  const toLocal = ([lon, lat]) => [
    ((lon - cx) * mLon * cosA + (-(lat - cy) * M_PER_DEG_LAT) * sinA) * PX,
    ((-(lon - cx) * mLon) * sinA + (-(lat - cy) * M_PER_DEG_LAT) * cosA) * PX
  ];

  // Footprint ring in local px (for mask + extent calculation)
  const ring = geometry.type === 'Polygon'
    ? geometry.coordinates[0]
    : geometry.coordinates[0][0];
  const localRing = ring.map(toLocal);

  // Extent in local px
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const [u, v] of localRing) {
    if (u < uMin) uMin = u; if (u > uMax) uMax = u;
    if (v < vMin) vMin = v; if (v > vMax) vMax = v;
  }
  const uRange = uMax - uMin, vRange = vMax - vMin;
  const uMid = (uMin + uMax) / 2, vMid = (vMin + vMax) / 2;

  // Inset by 2m (wall clearance) in px
  const INSET_PX = 2 * PX;
  const iuMin = uMin + INSET_PX, iuMax = uMax - INSET_PX;
  const ivMin = vMin + INSET_PX, ivMax = vMax - INSET_PX;

  const cont = new PIXI.Container();

  // ---- Footprint mask ----
  const mask = new PIXI.Graphics();
  mask.poly(localRing.flat()).fill({ color: 0xffffff });
  cont.addChild(mask);
  cont.mask = mask;

  // ---- Floor graphics ----
  const g = new PIXI.Graphics();
  cont.addChild(g);

  const rand = seededRand(hash32(id + ':floor'));

  if (cls === 'factory') {
    // 1. Concrete base
    g.rect(uMin, vMin, uRange, vRange).fill({ color: 0x8c8880 });

    // 2. Floor grid (horizontal lines every 2m = 2*PX px)
    const gridStep = 2 * PX;
    for (let v = vMin; v <= vMax; v += gridStep) {
      g.moveTo(uMin, v).lineTo(uMax, v);
    }
    g.stroke({ color: 0x7a7770, width: 1 });

    // 3. Loading zone (centre 40% of V extent)
    const zoneVMin = vMin + 0.3 * vRange;
    const zoneVMax = vMin + 0.7 * vRange;
    const zoneH = zoneVMax - zoneVMin;
    g.rect(uMin, zoneVMin, uRange, zoneH).fill({ color: 0x2a2a22 });

    // Diagonal yellow stripes across the zone
    // Stripes at 45°: draw lines where u - v = constant, spaced 8px apart
    const stripeSpacing = 8;
    const diagMin = uMin - zoneH;
    const diagMax = uMax + zoneH;
    for (let d = diagMin; d <= diagMax; d += stripeSpacing * 2) {
      // Line from (d, zoneVMin) to (d + zoneH, zoneVMax) — 45° diagonal
      const x1 = d, y1 = zoneVMin;
      const x2 = d + zoneH, y2 = zoneVMax;
      // Clip to zone rect manually
      const cx1 = Math.max(uMin, Math.min(uMax, x1));
      const cy1 = y1 + (cx1 - x1);
      const cx2 = Math.max(uMin, Math.min(uMax, x2));
      const cy2 = y2 - (x2 - cx2);
      if (cx1 <= uMax && cx2 >= uMin) {
        g.moveTo(cx1, cy1).lineTo(cx2, cy2);
      }
    }
    g.stroke({ color: 0xf0c000, width: 2 });

    // Zone border
    g.rect(uMin, zoneVMin, uRange, zoneH).stroke({ color: 0xe6b400, width: 2 });

    // 4. Scattered boxes (outside loading zone)
    const areaM2 = areaOf(id, geometry);
    const boxCount = Math.max(3, Math.min(12, Math.floor(areaM2 / 40)));
    const boxColours = [0x8B6344, 0x5C3D1E, 0xA0785A];
    const boxRotations = [0, 15 * Math.PI / 180, -12 * Math.PI / 180, Math.PI / 2];

    for (let i = 0; i < boxCount; i++) {
      let bu, bv, attempts = 0;
      do {
        bu = iuMin + rand() * (iuMax - iuMin);
        bv = ivMin + rand() * (ivMax - ivMin);
        attempts++;
      } while (bv > zoneVMin - INSET_PX && bv < zoneVMax + INSET_PX && attempts < 10);

      const bSize = (2 + rand()) * PX;  // 2–3m
      const bRot = boxRotations[Math.floor(rand() * boxRotations.length)];
      const bCol = boxColours[Math.floor(rand() * 3)];

      // Use a child container for per-box rotation
      const boxCont = new PIXI.Container();
      boxCont.position.set(bu, bv);
      boxCont.rotation = bRot;
      const bg = new PIXI.Graphics();
      // Shadow pixel (bottom-right offset)
      bg.rect(1, 1, bSize, bSize).fill({ color: 0x3a2a14 });
      // Box body
      bg.rect(0, 0, bSize, bSize).fill({ color: bCol });
      bg.rect(0, 0, bSize, bSize).stroke({ color: 0x3a2a14, width: 1 });
      boxCont.addChild(bg);
      cont.addChild(boxCont);
    }
  }

  else if (cls === 'warehouse') {
    // 1. Concrete base
    g.rect(uMin, vMin, uRange, vRange).fill({ color: 0x7e8080 });

    // 2. Rack aisles (strips running along V, dividing U)
    const aisleCount = Math.max(2, Math.floor(uRange / (5 * PX)));
    const stripW = uRange / aisleCount;
    const rackW = Math.min(stripW * 0.5, 1.8 * PX);

    for (let i = 0; i < aisleCount; i++) {
      const uStart = uMin + i * stripW;
      const isRack = i % 2 === 0;

      if (isRack) {
        // Rack background
        g.rect(uStart, vMin, stripW, vRange).fill({ color: 0x555555 });
        // End uprights
        g.rect(uStart, vMin, 2, vRange).fill({ color: 0x3a3a3a });
        g.rect(uStart + stripW - 2, vMin, 2, vRange).fill({ color: 0x3a3a3a });
        // Shelf lines every 0.8m
        const shelfStep = 0.8 * PX;
        for (let sv = vMin; sv <= vMax; sv += shelfStep) {
          g.moveTo(uStart, sv).lineTo(uStart + stripW, sv);
        }
        g.stroke({ color: 0x3a3a3a, width: 1 });
        // Aisle shadow on right edge
        g.rect(uStart + stripW - 2, vMin, 2, vRange).fill({ color: 0x6a6c6c });
      } else {
        // Walkway
        g.rect(uStart, vMin, stripW, vRange).fill({ color: 0x8a8c8c });
        // Dashed safety line down centre
        const lineU = uStart + stripW / 2;
        const dashLen = 1.5 * PX, gapLen = 0.5 * PX;
        let sv = vMin;
        while (sv < vMax) {
          g.moveTo(lineU, sv).lineTo(lineU, Math.min(sv + dashLen, vMax));
          sv += dashLen + gapLen;
        }
        g.stroke({ color: 0xc8a000, width: 1 });
      }
    }
  }

  else if (cls === 'office' || cls === 'hq') {
    // 1. Carpet base
    g.rect(uMin, vMin, uRange, vRange).fill({ color: 0x7a6e8a });

    // Dithered carpet pattern (bounded)
    const ditherStep = 2;
    let ditherCount = 0;
    const maxDither = 2000;
    for (let du = Math.ceil(uMin / ditherStep) * ditherStep;
         du <= uMax && ditherCount < maxDither; du += ditherStep) {
      for (let dv = Math.ceil(vMin / ditherStep) * ditherStep;
           dv <= vMax && ditherCount < maxDither; dv += ditherStep) {
        if ((Math.round(du / ditherStep) + Math.round(dv / ditherStep)) % 2 === 0) {
          g.rect(du, dv, 1, 1).fill({ color: 0x6e6280 });
          ditherCount++;
        }
      }
    }

    // 2. Central corridor
    const corrW = 1.5 * PX;
    g.rect(uMin, vMid - corrW / 2, uRange, corrW).fill({ color: 0x8a7e9c });

    // 3. Cubicles (two banks: above and below corridor)
    const cellU = 4 * PX, cellV = 3 * PX;
    const colCount = Math.max(1, Math.floor(uRange / cellU));

    for (let col = 0; col < colCount; col++) {
      const cu = uMin + col * cellU;

      // Upper bank (above corridor midpoint, growing upward from corridor)
      for (let bank = 0; bank < 2; bank++) {
        const bankVStart = bank === 0
          ? vMid - corrW / 2 - cellV   // just above corridor
          : vMid + corrW / 2;          // just below corridor
        const bankVDir = bank === 0 ? -1 : 1;
        const bankRows = Math.max(1, Math.floor(
          (bank === 0 ? (vMid - corrW / 2 - vMin) : (vMax - vMid - corrW / 2)) / cellV
        ));

        for (let row = 0; row < bankRows; row++) {
          const cv = bankVStart + bankVDir * row * cellV;
          const cvActual = bank === 0 ? cv - (bankDir === 1 ? 0 : 0) : cv; // no-op, but keep var for clarity

          // Partition walls
          g.moveTo(cu + cellU, cv).lineTo(cu + cellU, cv + bankVDir * cellV);
          g.moveTo(cu, cv + bankVDir * cellV).lineTo(cu + cellU, cv + bankVDir * cellV);
          g.stroke({ color: 0xc0b4d4, width: 1 });

          // Desk (top-left of cell, or top-right for lower bank)
          const deskU = cu + PX * 0.3;
          const deskV = bank === 0 ? cv - cellV + PX * 0.3 : cv + PX * 0.3;
          const deskW = 2 * PX, deskH = PX;
          // Shadow
          g.rect(deskU + 1, deskV + 1, deskW, deskH).fill({ color: 0xa89c7c });
          // Desk surface
          g.rect(deskU, deskV, deskW, deskH).fill({ color: 0xc8bc98 });

          // Chair
          const chairU = deskU + deskW / 2 - PX * 0.35;
          const chairV = bank === 0 ? deskV - PX * 0.8 : deskV + deskH + PX * 0.1;
          g.rect(chairU, chairV, 0.7 * PX, 0.7 * PX).fill({ color: 0x3c3448 });
        }
      }
    }

    // 4. Meeting room at high-U end
    const mRoomW = Math.min(6 * PX, uRange * 0.25);
    const mRoomU = uMax - mRoomW;
    g.rect(mRoomU, vMin + INSET_PX, mRoomW, vRange - INSET_PX * 2)
     .stroke({ color: 0xd4c8e8, width: 2 });
    // Table
    const tW = 3 * PX, tH = 1.5 * PX;
    g.rect(mRoomU + (mRoomW - tW) / 2, vMid - tH / 2, tW, tH)
     .fill({ color: 0xc8bc98 });
  }

  return cont;
};
```

**Note on the cubicle bank direction variable `bankDir`**: this is a typo in the
scaffold above — `bankDir` is not defined. Replace the `cvActual` line with just
`const cvActual = cv;` or remove it entirely; the actual `cv` value is what you
use in the rect calls anyway. Clean this up when you write the final code.

---

### Step 4: Add `interiorRoot`, `interiorContainers`, and `renderInteriors()`

Insert **just before** the line `let pixiApp = null;`:

```js
// ---- Interior floor rendering (factory / warehouse / office) ----
// Sits below beltRoot in the PixiJS scene, fades in at INTERIOR_MIN_ZOOM.
let interiorRoot = null;
const interiorContainers = new Map();   // building id → PIXI.Container
```

Insert after `refreshBelts()` (find the comment
`// Hook for factory-state changes`), before the delivery box section:

```js
const renderInteriors = () => {
  if (!pixiApp || !interiorRoot) return;
  const zoom = map.getZoom();
  const alpha = smoothstep(INTERIOR_MIN_ZOOM - 0.5, INTERIOR_MIN_ZOOM + 0.5, zoom);
  interiorRoot.alpha = alpha;
  if (alpha === 0) { interiorRoot.visible = false; return; }
  interiorRoot.visible = true;

  const mpp = 156543.03392 * Math.cos(CHATTERIS[1] * Math.PI / 180) / Math.pow(2, zoom);
  const scale = (MODULE_M / mpp) / 32;
  const w = pixiApp.screen.width, h = pixiApp.screen.height;

  for (const [id, rec] of owned) {
    const geom = geometryFor(id);
    if (!geom) continue;

    // Bbox cull — same pattern as belt rendering
    const [minX, minY, maxX, maxY] = bboxOfGeometry(id, geom);
    const tl = map.project([minX, maxY]);
    const br = map.project([maxX, minY]);
    if (br.x < 0 || tl.x > w || br.y < 0 || tl.y > h) {
      const existing = interiorContainers.get(id);
      if (existing) existing.visible = false;
      continue;
    }

    let cont = interiorContainers.get(id);
    if (!cont) {
      cont = buildInterior(id, rec.cls, geom);
      interiorRoot.addChild(cont);
      interiorContainers.set(id, cont);
    }

    const layout = layoutFor(id, geom);
    const anchor = map.project([layout.cx, layout.cy]);
    cont.position.set(anchor.x, anchor.y);
    cont.rotation = layout.angle;
    cont.scale.set(scale);
    cont.visible = true;
  }

  // Remove containers for buildings that are no longer owned
  for (const id of [...interiorContainers.keys()]) {
    if (!owned.has(id)) {
      interiorContainers.get(id).destroy({ children: true });
      interiorContainers.delete(id);
    }
  }
};

// Called after a building is claimed or sold — drops the cached interior
// so it rebuilds on next render (class may have changed)
const refreshInteriors = () => {
  for (const c of interiorContainers.values()) c.destroy({ children: true });
  interiorContainers.clear();
};
```

---

### Step 5: Wire into PixiJS init

In the async init IIFE, change:

```js
beltRoot = new PIXI.Container();
pixiApp.stage.addChild(beltRoot);
boxRoot = new PIXI.Container();
pixiApp.stage.addChild(boxRoot);
```

To:

```js
interiorRoot = new PIXI.Container();
pixiApp.stage.addChild(interiorRoot);   // ← below belts
beltRoot = new PIXI.Container();
pixiApp.stage.addChild(beltRoot);
boxRoot = new PIXI.Container();
pixiApp.stage.addChild(boxRoot);
```

And change:

```js
pixiApp.ticker.add(() => renderBelts());
pixiApp.ticker.add(() => renderBoxes());
```

To:

```js
pixiApp.ticker.add(() => renderInteriors());
pixiApp.ticker.add(() => renderBelts());
pixiApp.ticker.add(() => renderBoxes());
```

---

### Step 6: Call `refreshInteriors()` alongside `refreshBelts()`

Find every place `refreshBelts()` is called (search the file — it's called on
reset and on factory-line change). Add `refreshInteriors()` immediately after
each one.

Also find where a building is **claimed** (the `owned.set(id, ...)` call in the
buy handler) and where it is **sold** (the `owned.delete(id)` call in the sell
handler). Add `refreshInteriors()` after each of those too, so the interior
rebuilds correctly when the class changes.

---

## Things to watch out for

1. **PixiJS v8 Graphics API**: uses method chaining with `.fill({color})` and
   `.stroke({color, width})` called *after* the shape method. Not the v7
   `beginFill()` / `endFill()` style. The existing belt code uses v8 — follow
   its pattern.

2. **Local coordinate frame**: everything is in local px (1 local px =
   `MODULE_M / 32` metres = `4 / 32` = 0.125 metres). U is along the longest
   wall, V is perpendicular. The container's `rotation` and `scale` handle the
   screen transform — never mix screen and local coordinates in `buildInterior`.

3. **mask must be a child**: In PixiJS v8 a Graphics mask must be added to the
   container as a child before being assigned to `container.mask`. The mask
   Graphics is also in local coordinates and transforms with the container.

4. **One `buildInterior` call per building**: it's expensive (lots of Graphics
   calls). It runs once when the building first appears at `INTERIOR_MIN_ZOOM`.
   Do not call it in the ticker. `interiorContainers` is the cache.

5. **`refreshInteriors()` drops the cache**: call it when cls changes (buy/sell).
   The next `renderInteriors()` tick rebuilds it.

6. **`bankDir` typo**: the scaffold cubicle code has a reference to an undefined
   `bankDir` variable. Fix it before running — either remove the line or inline
   the value.

7. **Large buildings**: the dither loop has a 2000-iteration cap. The rack loop
   and box counts are also clamped. Don't remove these caps — some OSM footprints
   are huge.

8. **MultiPolygon**: `geometryFor` can return a MultiPolygon. `buildInterior`
   uses `geometry.coordinates[0][0]` for MultiPolygon rings (same as
   `longestEdgeAngle`). This covers the common case; complex multi-part
   footprints get the first polygon's ring.

9. **Test zoom levels**: open the browser, claim a factory, zoom to 16 (interior
   appears, no belts), then zoom to 18 (belts appear on top of the floor),
   then zoom back out (should fade clean). Check the fill-opacity transition
   hides the solid colour correctly.

---

## Success criteria

- [ ] At zoom < 16: solid class colour fill visible as before (no regression)
- [ ] At zoom 16–17: interior fades in over the footprint, floor texture visible
- [ ] At zoom 17+: interior fully opaque, solid fill faded out entirely
- [ ] At zoom 18+: conveyor belts draw on top of the factory interior
- [ ] Factory: concrete floor + floor grid + yellow diagonal loading zone + scattered boxes
- [ ] Warehouse: concrete + alternating rack bays (with shelves) and walkways (with dashed safety line)
- [ ] Office/HQ: carpet with dither + cubicles (desk + chair) + corridor + meeting room
- [ ] Interiors are deterministic: same building always gets the same layout
- [ ] Interiors are oriented to the building's longest wall (inherited from `layoutFor`)
- [ ] No visual regression on unowned buildings or NPC company buildings
- [ ] `refreshInteriors()` is called after buy, sell, and reset so interiors rebuild cleanly
- [ ] No errors in console related to PixiJS Graphics API usage
