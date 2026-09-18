// Debug: scan tiles around Chatteris for building counts
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { VectorTile } = require('@mapbox/vector-tile');
const { PbfReader } = require('pbf');
const zlib = require('zlib');

async function countBuildings(z, x, y) {
  const url = `https://tiles.openfreemap.org/planet/20260913_164504_pt/${z}/${x}/${y}.pbf`;
  const res = await fetch(url);
  if (!res.ok) return `HTTP ${res.status}`;
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  try {
    const tile = new VectorTile(new PbfReader(buf));
    return tile.layers.building ? tile.layers.building.length : 0;
  } catch (e) { return 'parse err'; }
}

// z14 tile containing Chatteris is 8194/5376 — scan 3x3
for (let dy = -1; dy <= 1; dy++) {
  const row = [];
  for (let dx = -1; dx <= 1; dx++) {
    row.push(await countBuildings(14, 8194 + dx, 5376 + dy));
  }
  console.log('z14', row.join('\t'));
}

// and the containing z13 tile
console.log('z13 8197/2688 buildings:', await countBuildings(13, 8197, 2688));


if (tile.layers.building) {
  const l = tile.layers.building;
  console.log(`building: ${l.length} features, extent ${l.extent}`);
  const areas = [];
  for (let i = 0; i < l.length; i++) {
    const f = l.feature(i);
    const g = f.toGeoJSON(8194, 5376, 14);
    // rough planar area in m^2
    let a = 0;
    const rings = g.geometry.type === 'Polygon' ? [g.geometry.coordinates] : g.geometry.coordinates;
    for (const poly of rings) {
      const ring = poly[0];
      for (let k = 0; k < ring.length - 1; k++) {
        const [x1, y1] = ring[k], [x2, y2] = ring[k + 1];
        a += (x1 * 111320 * Math.cos(52.45 * Math.PI / 180)) * (y2 * 111320)
           - (x2 * 111320 * Math.cos(52.45 * Math.PI / 180)) * (y1 * 111320);
      }
    }
    areas.push(Math.abs(a / 2));
  }
  areas.sort((a, b) => a - b);
  console.log('feature count:', areas.length);
  console.log('min/median/max area m2:', Math.round(areas[0]), Math.round(areas[Math.floor(areas.length / 2)]), Math.round(areas[areas.length - 1]));
  console.log('features over 5000 m2:', areas.filter(a => a > 5000).length);
  console.log('sample properties:', JSON.stringify(l.feature(0).properties));
}
