// Fetch individual building footprints for Chatteris from Overpass API
// and write buildings-data.js (a global variable, so it works over file:// too)
import fs from 'fs';

const query = `
[out:json][timeout:120];
(
  way["building"](52.435,-0.03,52.50,0.13);
);
out geom;
`;

console.log('Querying Overpass...');
const res = await fetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query), {
  headers: {
    'Accept': 'application/json',
    'User-Agent': 'chatteris-map-experiment/1.0 (local development)'
  }
});
if (!res.ok) { console.error('Overpass failed:', res.status, await res.text()); process.exit(1); }
const osm = await res.json();

const features = [];
for (const el of osm.elements) {
  if (el.type === 'way' && el.geometry && el.geometry.length > 3) {
    const ring = el.geometry.map((p) => [p.lon, p.lat]);
    const first = ring[0], last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
    features.push({
      type: 'Feature',
      id: 'w' + el.id,
      properties: {
        id: 'w' + el.id,
        osm_id: el.id,
        name: el.tags?.name || null,
        class: el.tags?.building || 'yes',
        height: el.tags?.height ? parseFloat(el.tags.height) : null,
        levels: el.tags?.['building:levels'] ? parseFloat(el.tags['building:levels']) : null
      },
      geometry: { type: 'Polygon', coordinates: [ring] }
    });
  }
}

const geojson = { type: 'FeatureCollection', features };
fs.writeFileSync('buildings.geojson', JSON.stringify(geojson));
fs.writeFileSync('buildings-data.js', 'window.BUILDINGS_DATA = ' + JSON.stringify(geojson) + ';');
console.log('Buildings fetched:', features.length);
console.log('Wrote buildings.geojson (' + (fs.statSync('buildings.geojson').size / 1048576).toFixed(2) + ' MB)');
console.log('Wrote buildings-data.js (' + (fs.statSync('buildings-data.js').size / 1048576).toFixed(2) + ' MB)');
