// One-off tuning helper: counts company-candidate buildings near Chatteris
// (footprint 250–4000 m², within 2 km) so MARKET.DENSITY lands ~12–16 companies.
import { readFileSync, writeFileSync } from 'node:fs';

// 1) Extract the game script from index.html for syntax checking
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const m = html.match(/<script>\s*\n([\s\S]*?)<\/script>/);
if (!m) throw new Error('script block not found');
writeFileSync(new URL('./.tmp-script.js', import.meta.url), m[1]);

// 2) Candidate measurement against the real footprint data
const fc = JSON.parse(readFileSync(new URL('./buildings.geojson', import.meta.url), 'utf8'));
const C = [0.05030011035594765, 52.45514770133596]; // Chatteris town centre
const R = 2000;

const ringOf = (g) =>
  g.type === 'Polygon' ? g.coordinates[0]
  : (g.type === 'MultiPolygon' && g.coordinates.length && g.coordinates[0].length ? g.coordinates[0][0] : null);

const areaOf = (g) => {
  const r = ringOf(g);
  if (!r || r.length < 4) return 0;
  const cy = C[1];
  const mLon = 111320 * Math.cos(cy * Math.PI / 180);
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) {
    s += (r[i][0] * mLon) * (-(r[i + 1][1] * 111320)) - ((r[i + 1][0] * mLon) * (-(r[i][1] * 111320)));
  }
  return Math.abs(s / 2);
};

let cand = 0, total = 0;
const cosLat = Math.cos(C[1] * Math.PI / 180) * 111320;
for (const f of fc.features) {
  total++;
  const r = ringOf(f.geometry);
  if (!r || !r.length) continue;
  let x = 0, y = 0;
  for (const p of r) { x += p[0]; y += p[1]; }
  x /= r.length; y /= r.length;
  const dx = (x - C[0]) * cosLat, dy = (y - C[1]) * 111320;
  const a = areaOf(f.geometry);
  if (dx * dx + dy * dy <= R * R && a >= 250 && a <= 4000) cand++;
}
console.log('features:', total, '| candidates (2 km, 250–4000 m²):', cand);
console.log('DENSITY for ~14 companies:', Math.max(1, Math.round(cand / 14)));

// Brute-force: exact deterministic roster size per DENSITY (hash is fixed)
const hash32 = (str) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const cands = [];
for (const f of fc.features) {
  const r = ringOf(f.geometry);
  if (!r || !r.length || !f.properties || !f.properties.id) continue;
  let x = 0, y = 0;
  for (const p of r) { x += p[0]; y += p[1]; }
  x /= r.length; y /= r.length;
  const dx = (x - C[0]) * cosLat, dy = (y - C[1]) * 111320;
  const a = areaOf(f.geometry);
  if (dx * dx + dy * dy <= R * R && a >= 250 && a <= 4000) cands.push(f.properties.id);
}
for (let D = 8; D <= 40; D++) {
  const n = cands.filter((id) => hash32(id + ':site') % D === 0).length;
  if (n >= 12 && n <= 16) console.log(`DENSITY=${D} -> ${n} companies  <== in range`);
  else console.log(`DENSITY=${D} -> ${n}`);
}
