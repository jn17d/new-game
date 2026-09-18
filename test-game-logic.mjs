// Validation harness: pulls the real game logic out of index.html and runs it
// against a stubbed localStorage. Run with: node test-game-logic.mjs
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// --- extract the real code fragments we want to exercise ---
const grab = (re) => {
  const m = script.match(re);
  if (!m) throw new Error('fragment not found: ' + re);
  return m[0];
};
const classesSrc = grab(/const BUILDING_CLASSES = \{[\s\S]*?\n    \};/);
const loadOwnedSrc = grab(/const loadOwned = \(\) => \{[\s\S]*?\n    \};/);
const multSrc = grab(/const factoryOutputMult = \(\) =>[\s\S]*?globalBonus : 1\);/);
const baseSrc = grab(/const BASE_STORAGE = \d+;/);
const whStorageSrc = grab(/const warehouseStorage = \(area\) =>[\s\S]*?m2PerProduct\);/);
const capSrc = grab(/const totalCapacity = \(\) => \{[\s\S]*?\n    \};/);
const tickClampSrc = null;   // superseded: production behaviour is covered by §15 (allocateStock)
const loadStockSrc = grab(/\(\(\) => \{\r?\n      let loaded = false;[\s\S]*?\r?\n    \}\)\(\);/);
const loadClampSrc = null;   // superseded: capacity clamping now lives inside loadStockSrc
// --- per-building stock fragments ---
const stockKeySrc = grab(/const STOCK_KEY = '[^']*';/);
const yardSrc = grab(/const YARD_ID = '[^']*';/);
const stockHelpersSrc = grab(/const stockIn = \(id\) =>[\s\S]*?const syncProducts = \(\) => \{[\s\S]*?\n    \};/);
const allocSrc = grab(/const warehousesNear = \(center\) => \{[\s\S]*?const drainStock = \(n, center\) => \{[\s\S]*?\n    \};/);
const boxPointSrc = grab(/const boxPointAt = \(b, now\) => \{[\s\S]*?\n    \};/);

// --- stub localStorage ---
const makeStorage = (seed = {}) => {
  const s = { ...seed };
  return {
    getItem: (k) => (k in s ? s[k] : null),
    setItem: (k, v) => { s[k] = String(v); },
    removeItem: (k) => { delete s[k]; },
    dump: () => s
  };
};

const run = (storage, warehouseAreas = {}) => {
  const out = {};
  // eslint-disable-next-line no-new-func
  const fn = new Function('localStorage', 'AREA_OF', classesSrc + '\n' + `
    const OWNED_KEY = 'chatteris-owned';
    const HQ_KEY = 'chatteris-hq';
    const LEGACY_CLAIMS_KEY = 'chatteris-claims';
    const LEGACY_FACTORIES_KEY = 'chatteris-factories';
  ` + '\n' + loadOwnedSrc + '\n' + `
    const owned = loadOwned();
    let hqId = null;
    const candidateHq = localStorage.getItem('chatteris-hq');
    if (candidateHq && owned.has(candidateHq) && owned.get(candidateHq).cls === 'hq') {
      hqId = candidateHq;
    } else {
      localStorage.removeItem('chatteris-hq');
    }
    ${multSrc}
    // storage-capacity stubs: geometry existence + memoized area per id
    const geometryFor = (id) => (id in AREA_OF ? { id } : null);
    const areaOf = (id) => AREA_OF[id];
    ${baseSrc}
    ${whStorageSrc}
    ${capSrc}
    return { owned, hqId, factoryOutputMult, BUILDING_CLASSES, BASE_STORAGE, warehouseStorage, totalCapacity };
  `);
  Object.assign(out, fn(storage, warehouseAreas));
  return out;
};

let failures = 0;
const check = (name, cond) => {
  console.log((cond ? '  ok  ' : ' FAIL ') + name);
  if (!cond) failures++;
};

console.log('1. legacy migration (oldest claim -> HQ, rest factory, lines carried)');
{
  const st = makeStorage({
    'chatteris-claims': JSON.stringify({ w2: 2000, w1: 1000, w3: 3000 }),
    'chatteris-factories': JSON.stringify({ w2: 3, w3: 1 })
  });
  const { owned, hqId } = run(st);
  check('oldest claim (w1) becomes HQ', owned.get('w1').cls === 'hq' && hqId === 'w1');
  check('rest become factories', owned.get('w2').cls === 'factory' && owned.get('w3').cls === 'factory');
  check('legacy lines carried (w2=3, w3=1)', owned.get('w2').lines === 3 && owned.get('w3').lines === 1);
  check('legacy keys left in place (non-destructive)', st.dump()['chatteris-claims'] !== undefined);
}

console.log('2. fresh start -> empty ownership, no HQ');
{
  const st = makeStorage();
  const { owned, hqId } = run(st);
  check('no owned buildings', owned.size === 0);
  check('hqId null', hqId === null);
}

console.log('3. HQ id policed on load (stale hq pointing at missing/renamed building)');
{
  const st = makeStorage({
    'chatteris-owned': JSON.stringify({ w9: { cls: 'factory', ts: 5, lines: 1 } }),
    'chatteris-hq': 'w999'
  });
  const { hqId } = run(st);
  check('stale hq cleared', hqId === null && st.dump()['chatteris-hq'] === undefined);
}
{
  const st = makeStorage({
    'chatteris-owned': JSON.stringify({ w9: { cls: 'office', ts: 5, lines: 0 } }),
    'chatteris-hq': 'w9'
  });
  const { hqId } = run(st);
  check('hq pointing at non-hq record cleared', hqId === null);
}
{
  const st = makeStorage({
    'chatteris-owned': JSON.stringify({ w9: { cls: 'hq', ts: 5, lines: 0 } }),
    'chatteris-hq': 'w9'
  });
  const { hqId } = run(st);
  check('valid hq kept', hqId === 'w9');
}

console.log('4. HQ lock gate + buy flow logic');
{
  const st = makeStorage();
  const g = run(st);
  const { BUILDING_CLASSES } = g;
  // replicate the menu's gate logic
  const canBuy = (cls, hqId) => {
    const cfg = BUILDING_CLASSES[cls];
    if (cfg.unique && hqId !== null) return false;  // HQ row hidden once owned
    if (!cfg.unique && hqId === null) return false; // strict lock
    return true;
  };
  check('no HQ: only hq class purchasable',
    canBuy('hq', null) && !canBuy('factory', null) && !canBuy('warehouse', null) && !canBuy('office', null));
  check('HQ owned: hq hidden, others purchasable',
    !canBuy('hq', 'w1') && canBuy('factory', 'w1') && canBuy('warehouse', 'w1') && canBuy('office', 'w1'));
}

console.log('5. tick maths (HQ-only output multiplier & office income)');
{
  const { BUILDING_CLASSES, factoryOutputMult } = run(makeStorage({
    'chatteris-owned': JSON.stringify({
      h: { cls: 'hq', ts: 1, lines: 0 },
      f1: { cls: 'factory', ts: 2, lines: 4 },
      f2: { cls: 'factory', ts: 3, lines: 1 },
      w1: { cls: 'warehouse', ts: 4, lines: 0 },
      w2: { cls: 'warehouse', ts: 5, lines: 0 }
    }),
    'chatteris-hq': 'h'
  }));
  // warehouses no longer boost production: HQ only -> 1.1
  check('factoryOutputMult = 1.1 (HQ only; warehouses ignored)', Math.abs(factoryOutputMult() - 1.1) < 1e-9);
  const noHq = run(makeStorage({
    'chatteris-owned': JSON.stringify({ w1: { cls: 'warehouse', ts: 4, lines: 0 } })
  }));
  check('factoryOutputMult = 1.0 without HQ', Math.abs(noHq.factoryOutputMult() - 1.0) < 1e-9);
  check('warehouse class carries storage, not a production buff',
    BUILDING_CLASSES.warehouse.m2PerProduct === 4 &&
    BUILDING_CLASSES.warehouse.outputMultBonus === undefined);
  // 5 lines * 1 product * 1.1 -> 6 products (rounded) per tick
  check('tick products = round(5 * 1.1) = 6', Math.round(5 * BUILDING_CLASSES.factory.outputPerTick * factoryOutputMult()) === 6);
  // office: 200 m^2 * 0.5 * 1.1 = 110 per tick
  const officeTick = Math.round(200 * BUILDING_CLASSES.office.cashPerM2PerTick * (1 + BUILDING_CLASSES.hq.globalBonus));
  check('office income = 200m2 * 0.5 * 1.1 = 110', officeTick === 110);
}

console.log('6. prices (area x $10 x costMult)');
{
  const { BUILDING_CLASSES } = run(makeStorage());
  const price = (area, cls) => Math.round(area * 10 * BUILDING_CLASSES[cls].costMult);
  check('factory  100m2 = $1,000', price(100, 'factory') === 1000);
  check('warehouse 100m2 = $600', price(100, 'warehouse') === 600);
  check('office   100m2 = $1,500', price(100, 'office') === 1500);
  check('hq       100m2 = $2,000', price(100, 'hq') === 2000);
}

// ---- NPC market logic (exercised against the REAL Chatteris footprints) ----
const marketConstSrc = grab(/const MARKET = \{[\s\S]*?\n    \};/);
const hash32Src = grab(/const hash32 = \(str\) => \{[\s\S]*?\n    \};/);
const sectorsSrc = grab(/const SECTORS = \[[\s\S]*?\];/);
const nameLocalesSrc = grab(/const NAME_LOCALES = \{[\s\S]*?\n    \};/);
const centroidSrc = grab(/const centroidOf = \(geometry\) => \{[\s\S]*?\n    \};/);
const marketDeclsSrc = grab(/const companyCache = new Map\(\);[\s\S]*?const marketState = new Map\(\);[^\n]*/);
const companyForSrc = grab(/const companyFor = \(f\) => \{[\s\S]*?\n    \};/);
const demandSrc = grab(/const demandCapFor = \(area\) =>[\s\S]*?Math\.round\(area \/ 60\) \+ 3\)\);/);
const stateForSrc = grab(/const stateFor = \(co\) => \{[\s\S]*?\n    \};/);
const priceSrc = grab(/const hqSaleBonus = \(\) => \([^\n]*\);\s*\r?\n\s*const companyPrice = \(co, s\) => [^\n]*;/);
const tickSrc = grab(/const tickMarket = \(\) => \{[\s\S]*?\n    \};/);
const nearSrc = grab(/const companiesNear = \(center, radiusM\) => \{[\s\S]*?\n    \};/);
const sellSrc = grab(/const sellTo = \(co, qty\) => \{[\s\S]*?\n    \};/);
const sellAllSrc = grab(/const sellAllBest = \(\) => \{[\s\S]*?\n    \};/);
const buyoutPriceSrc = grab(/const companyBuyoutPrice = \(co\) => [^\n]*;/);
const buyoutSrc = grab(/const buyoutCompany = \(co\) => \{[\s\S]*?\n    \};/);
const marketSrc = [
  marketConstSrc, hash32Src, sectorsSrc, nameLocalesSrc, centroidSrc, marketDeclsSrc,
  companyForSrc, demandSrc, stateForSrc, priceSrc, tickSrc, nearSrc,
  sellSrc, sellAllSrc, buyoutPriceSrc, buyoutSrc
].join('\n');
const sellBackSrc = grab(/const SELL_BACK = [\d.]+;/);
const resaleSrc = grab(/const resalePrice = \(id, geometry\) => \{[\s\S]*?\n    \};/);
const sellBldgSrc = grab(/const sellBuilding = \(id, geometry\) => \{[\s\S]*?\n    \};/);

// Real footprint data (same dataset index.html loads via buildings-data.js)
const fc = JSON.parse(readFileSync(new URL('./buildings.geojson', import.meta.url), 'utf8'));
const CENTER = [0.05030011035594765, 52.45514770133596];  // Chatteris town centre

// Shoelace area (metres) — close enough to turf.area for candidate selection.
// Self-contained (no outer references) so it can be inlined into the sandbox.
const areaOfGeom = (g) => {
  const r = g.type === 'Polygon' ? g.coordinates[0]
    : (g.type === 'MultiPolygon' && g.coordinates.length && g.coordinates[0].length ? g.coordinates[0][0] : null);
  if (!r || r.length < 4) return 0;
  const mLon = 111320 * Math.cos(52.45514770133596 * Math.PI / 180);
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) {
    s += (r[i][0] * mLon) * (-(r[i + 1][1] * 111320)) - ((r[i + 1][0] * mLon) * (-(r[i][1] * 111320)));
  }
  return Math.abs(s / 2);
};
const features = fc.features.filter((f) => f.properties && f.properties.id && f.geometry);
const footprintStub = (() => {
  const byId = new Map(features.map((f) => [f.properties.id, f]));
  return {
    all: () => features,
    featureById: (id) => byId.get(id) || null,
    geometryFor: (id) => { const f = byId.get(id); return f ? f.geometry : null; }
  };
})();

const { BUILDING_CLASSES } = run(makeStorage());

const makeMarket = (opts = {}) => {
  const fn = new Function('localStorage', 'owned', 'hqId0', 'products0', 'wallet0', 'Footprints', 'mapStub', `
    let hqId = hqId0;
    let wallet = wallet0;
    let marketRoster = [];
    const PRODUCTS_KEY = 'chatteris-products';
    const BUILDING_CLASSES = ${JSON.stringify(BUILDING_CLASSES)};
    const saveWallet = () => {};
    const saveOwned = () => {};
    const updateProductDisplay = () => {};
    const updateWalletDisplay = () => {};
    const updateOwnedDisplay = () => {};
    const applyOwnershipState = () => {};
    const map = mapStub;
    const areaOfGeomLocal = ${areaOfGeom.toString()};
    const areaOf = (id, geometry) => areaOfGeomLocal(geometry);
    const geometryFor = () => null;                   // no footprints in this sandbox
    
    let products = 0;                                 // derived from the stock map below
    const stock = new Map();
    const spawnLog = [];
    const spawnBoxes = (from, to, units, dur) => spawnLog.push({ from, to, units, dur });
    const BOX_SALE_MS = 1800;
    ${baseSrc}
    ${whStorageSrc}
    ${capSrc}
    ${stockKeySrc}
    ${yardSrc}
    ${stockHelpersSrc}
    ${allocSrc}
    // the legacy scalar total now lives in the virtual yard
    stock.set(YARD_ID, Math.max(0, products0));
    products = totalStock();

    ${marketSrc}
    const NAME_LOCALE = NAME_LOCALES.UK_EN;
    const refreshMarket = () => {
      const c = map.getCenter();
      marketRoster = companiesNear([c.lng, c.lat], MARKET.RADIUS_M);
    };
    return { MARKET, hash32, companyFor, demandCapFor, stateFor, companyPrice, tickMarket,
      companiesNear, sellTo, sellAllBest, companyBuyoutPrice, buyoutCompany, forcedCompanies,
      companyCache, refreshMarket,
      spawnLog, stock, stockIn, drainStock, allocateStock, setStock, YARD_ID,
      getProducts: () => products, getWallet: () => wallet,
      setRoster: (r) => { marketRoster = r; } };
  `);
  return fn(makeStorage(), opts.owned || new Map(), opts.hqId ?? null,
    opts.products ?? 0, opts.wallet ?? 10000000, footprintStub,
    { getCenter: () => ({ lng: CENTER[0], lat: CENTER[1] }), setFeatureState() {}, removeFeatureState() {} });
};

console.log('7. hash determinism (same id -> same site/name/sector/price)');
{
  const m1 = makeMarket();
  const m2 = makeMarket();
  const coA = m1.companiesNear(CENTER, 2000);
  const coB = m2.companiesNear(CENTER, 2000);
  check('roster identical across independent runs',
    JSON.stringify(coA.map((c) => [c.id, c.name, c.sector, c.base])) ===
    JSON.stringify(coB.map((c) => [c.id, c.name, c.sector, c.base])));
  const first = coA[0];
  check('companyFor memoized decision is stable',
    JSON.stringify(m1.companyFor(features.find((f) => f.properties.id === first.id))) ===
    JSON.stringify(first));
  check('base price within $18–$40', coA.every((c) => c.base >= 18 && c.base <= 40));
  check('name non-empty',
    coA.every((c) => c.name.length > 0 && /\S/.test(c.name)));
}

console.log('8. local roster size (target 12–16 within 2 km of centre)');
{
  const m = makeMarket();
  const roster = m.companiesNear(CENTER, 2000);
  console.log(`    roster size: ${roster.length}`);
  check(`roster within 12–16 (got ${roster.length})`, roster.length >= 12 && roster.length <= 16);
  check('all footprints within 250–4000 m²',
    roster.every((c) => c.area >= m.MARKET.AREA_MIN && c.area <= m.MARKET.AREA_MAX));
  const d = (c) => Math.hypot(
    (c.centroid[0] - CENTER[0]) * Math.cos(CENTER[1] * Math.PI / 180) * 111320,
    (c.centroid[1] - CENTER[1]) * 111320);
  check('sorted nearest-first', roster.every((c, i) => i === 0 || d(roster[i - 1]) <= d(c) + 1e-6));
}

console.log('9. drift clamped to ±25% over 1,000 ticks');
{
  const m = makeMarket();
  const roster = m.companiesNear(CENTER, 2000);
  roster.forEach((c) => m.stateFor(c));
  for (let i = 0; i < 1000; i++) m.tickMarket();
  let okClamp = true, okPrice = true;
  for (const c of roster) {
    const s = m.stateFor(c);
    if (Math.abs(s.drift) > m.MARKET.DRIFT_MAX + 1e-9) okClamp = false;
    const p = m.companyPrice(c, s);
    if (p < Math.round(c.base * 0.75) - 1 || p > Math.round(c.base * 1.25) + 1) okPrice = false;
  }
  check('drift never exceeds ±0.25', okClamp);
  check('price stays within ±25% of base', okPrice);
  check('demand refilled to cap after tick',
    roster.every((c) => m.stateFor(c).demand === m.stateFor(c).cap));
}

console.log('10. demand clamps (5–60, round(area/60)+3)');
{
  const m = makeMarket();
  check('huge area clamps to 60', m.demandCapFor(100000) === 60);
  check('tiny area clamps to 5', m.demandCapFor(10) === 5);
  check('typical 1800 m² -> 33', m.demandCapFor(1800) === 33);
}

console.log('11. sellTo clamps (demand, stock) & wallet/products consistent');
{
  const m = makeMarket({ products: 7, wallet: 0 });
  const co = { id: 't1', name: 'T', sector: 'S', base: 20, area: 600, centroid: CENTER };
  const s = m.stateFor(co);                 // cap = round(600/60)+3 = 13
  check('cap for 600 m² is 13', s.cap === 13);
  const cash = m.sellTo(co, 100);           // clamped by stock (7)
  check('sold only the 7 in stock', cash === 140 && m.getProducts() === 0);
  check('wallet credited', m.getWallet() === 140);
  const m2 = makeMarket({ products: 500, wallet: 0 });
  const co2 = { id: 't2', name: 'T', sector: 'S', base: 30, area: 300, centroid: CENTER }; // cap 8
  const sold = m2.sellTo(co2, 500);         // clamped by demand (8)
  check('sold only demand (8)', sold === 240 && m2.getProducts() === 492);
  check('demand decremented', m2.stateFor(co2).demand === 0);
  check('selling to exhausted demand yields 0', m2.sellTo(co2, 5) === 0);
}

console.log('12. sellAllBest fills highest price first');
{
  const mk = (id, base, area) => ({ id, name: id, sector: 'S', base, area, centroid: CENTER });
  const m = makeMarket({ products: 20, wallet: 0 });
  const cheap = mk('c1', 18, 300);   // cap 8, $18
  const mid = mk('c2', 25, 600);     // cap 13, $25
  const dear = mk('c3', 40, 300);    // cap 8, $40
  m.setRoster([cheap, mid, dear]);
  const total = m.sellAllBest();
  // greedy optimum: 8×$40 = 320, then 12 left × $25 = 300  -> 620
  check('greedy total = 8×$40 + 12×$25 = $620', total === 620);
  check('stock emptied', m.getProducts() === 0);
  check('dear exhausted, mid partially drained',
    m.stateFor(dear).demand === 0 && m.stateFor(mid).demand === 1);
}

console.log('13. buyout: 4× office price -> owned office + company relocates');
{
  const owned = new Map();
  const m = makeMarket({ owned, products: 0, wallet: 10000000 });
  const roster = m.companiesNear(CENTER, 2000);
  const co = roster[0];
  const price = m.companyBuyoutPrice(co);
  const officePrice = Math.round(co.area * 10 * BUILDING_CLASSES.office.costMult);
  check('buyout = 4× office price (± rounding)', Math.abs(price - 4 * officePrice) <= 4);
  check('buyout = $60/m²', price === Math.round(co.area * 60));
  const walletBefore = m.getWallet();
  check('buyout succeeds', m.buyoutCompany(co) === true);
  check('wallet debited exactly', m.getWallet() === walletBefore - price);
  check('building now owned office', owned.get(co.id).cls === 'office');
  check('old site no longer a company (cached null)', m.companyCache.get(co.id) === null);
  const relocated = [...m.forcedCompanies.values()].find((c) => c.name === co.name);
  check('company relocated to a new site', !!relocated && relocated.id !== co.id);
  check('relocation keeps sector/base',
    relocated.sector === co.sector && relocated.base === co.base);
  check('relocated site is a company in the refreshed roster',
    m.companiesNear(CENTER, 2000).some((c) => c.id === relocated.id && c.name === co.name));
  const owned2 = new Map([[co.id, { cls: 'office', ts: 1, lines: 0 }]]);
  const m2 = makeMarket({ owned: owned2, products: 0, wallet: 10000000 });
  check('owned buildings never host companies',
    m2.companiesNear(CENTER, 2000).every((c) => !owned2.has(c.id)));
}

console.log('14. warehouse storage maths (m2PerProduct, base yard, aggregation)');
{
  const { BUILDING_CLASSES, BASE_STORAGE, warehouseStorage, totalCapacity } = run(makeStorage({
    'chatteris-owned': JSON.stringify({
      h:  { cls: 'hq',        ts: 1, lines: 0 },
      f1: { cls: 'factory',   ts: 2, lines: 2 },
      w1: { cls: 'warehouse', ts: 3, lines: 0 },
      w2: { cls: 'warehouse', ts: 4, lines: 0 },
      o1: { cls: 'office',    ts: 5, lines: 0 }
    }),
    'chatteris-hq': 'h'
  }), { w1: 1000, w2: 600 });
  check('free loading yard = 50', BASE_STORAGE === 50);
  check('warehouseStorage(1000 m²) = 250 @ 4 m²/product', warehouseStorage(1000) === 250);
  check('warehouseStorage floors (399 m² = 99)', warehouseStorage(399) === 99);
  check('totalCapacity = 50 + 250 + 150 = 450 (HQ/office/factory ignored)', totalCapacity() === 450);
  const bare = run(makeStorage());
  check('no warehouses: capacity = base yard only (50)', bare.totalCapacity() === 50);
  const { totalCapacity: cap2 } = run(makeStorage({
    'chatteris-owned': JSON.stringify({ wX: { cls: 'warehouse', ts: 1, lines: 0 } })
  }), {}); // owned warehouse whose geometry is missing (shouldn't happen, but safe)
  check('warehouse without geometry adds nothing', cap2() === 50);
}

// Sandbox for per-building stock: storage helpers + allocation + market
// selling + building resale, assembled from the real index.html fragments.
const makeGame = (opts = {}) => {
  // eslint-disable-next-line no-new-func
  const fn = new Function('localStorage', 'AREA_OF', 'CENTS', 'owned0', 'hqId0', 'roster0', 'wallet0', `
    const BUILDING_CLASSES = ${JSON.stringify(BUILDING_CLASSES)};
    const OWNED_KEY = 'chatteris-owned';
    const HQ_KEY = 'chatteris-hq';
    const PRICE_PER_M2 = 10;
    const PRODUCTS_KEY = 'chatteris-products';   // legacy scalar (migration source)
    const owned = new Map(Object.entries(owned0));
    let hqId = hqId0;
    let wallet = wallet0;
    let marketRoster = roster0;
    const saveWallet = () => {};
    const saveOwned = () => {};
    const saveHq = () => {};
    const updateOwnedDisplay = () => {};
    const updateWalletDisplay = () => {};
    const updateProductDisplay = () => {};
    const refreshBelts = () => {};
    let marketPanelOpen = false;
    const renderMarketPanel = () => {};
    const map = { removeFeatureState: () => {} };
    const geometryFor = (id) => (id in AREA_OF ? { id } : null);
    const areaOf = (id) => AREA_OF[id];
    const centroidOf = (geom) => CENTS[geom.id] || [0, 0];
    const spawnLog = [];
    const spawnBoxes = (from, to, units, dur) => spawnLog.push({ from, to, units, dur });
    const BOX_PROD_MS = 1400;
    const BOX_SALE_MS = 1800;
    let products = 0;
    const stock = new Map();
    ${baseSrc}
    ${whStorageSrc}
    ${capSrc}
    ${marketConstSrc}
    ${marketDeclsSrc}
    ${demandSrc}
    ${stateForSrc}
    ${priceSrc}
    ${stockKeySrc}
    ${yardSrc}
    ${stockHelpersSrc}
    ${allocSrc}
    ${sellBackSrc}
    ${resaleSrc}
    ${sellSrc}
    ${sellBldgSrc}
    ${loadStockSrc}
    return {
      owned, stock, spawnLog, YARD_ID, STOCK_KEY,
      stockIn, setStock, freeRoom, capacityOf, totalCapacity, totalStock,
      allocateStock, drainStock, warehousesNear, syncProducts, sellBuilding,
      resalePrice, sellTo, stateFor, companyPrice, setRoster: (r) => { marketRoster = r; },
      getProducts: () => products, getWallet: () => wallet, setWallet: (v) => { wallet = v; },
      getHq: () => hqId
    };
  `);
  return fn(opts.storage || makeStorage(), opts.areas || {}, opts.cents || {},
    opts.owned || {}, opts.hq ?? null, opts.roster || [], opts.wallet ?? 0);
};

// Three warehouses + a factory, positioned so "nearest" is unambiguous.
const GEO = {
  areas: { f1: 1000, wNear: 400, wMid: 1000, wBig: 2000, h: 500 },
  cents: {
    f1: [0.0500, 52.4550],
    wNear: [0.0505, 52.4550],   // ~35 m east of the factory
    wMid: [0.2000, 52.5000],    // ~10 km away
    wBig: [0.3500, 52.5500],    // ~20 km away
    h: [0.0490, 52.4540]
  },
  owned: {
    f1: { cls: 'factory', ts: 1, lines: 1 },
    wNear: { cls: 'warehouse', ts: 2, lines: 0 },
    wMid: { cls: 'warehouse', ts: 3, lines: 0 },
    wBig: { cls: 'warehouse', ts: 4, lines: 0 }
  }
};
const buyerCo = () => ({ id: 't1', name: 'NearestCo', sector: 'S', base: 20, area: 600,
  centroid: GEO.cents.f1 });

console.log('15. production allocation (nearest warehouse with room, then yard)');
{
  const mk = (seed = {}, owned = GEO.owned) => makeGame({
    storage: makeStorage(Object.keys(seed).length
      ? { 'chatteris-stock': JSON.stringify(seed) } : {}),
    areas: GEO.areas, cents: GEO.cents, owned
  });
  // wNear holds 100 (its 400 m² cap), wFar holds 0 (cap 250), yard empty.
  const g = mk();
  check('warehouse caps from area (400 m² -> 100, 1000 m² -> 250, 2000 m² -> 500)',
    g.capacityOf('wNear') === 100 && g.capacityOf('wMid') === 250 && g.capacityOf('wBig') === 500);
  check('virtual yard cap = 50 (no building needed)', g.capacityOf(g.YARD_ID) === 50);
  check('capacityOf ignores factories/HQ', g.capacityOf('f1') === 0 && g.capacityOf('h') === 0);
  check('totalCapacity = 50 + 100 + 250 + 500 = 900', g.totalCapacity() === 900);

  // nearest-first
  const a = g.allocateStock(10, GEO.cents.f1);
  check('10 units go to the NEAREST warehouse', a.placed === 10 && a.legs.length === 1 &&
    a.legs[0].holderId === 'wNear' && g.stockIn('wNear') === 10);

  // spill to the next warehouse when the nearest runs out of room
  g.setStock('wNear', 95);
  const b = g.allocateStock(10, GEO.cents.f1);
  check('overflow splits nearest -> next (5 + 5)',
    b.placed === 10 && b.legs.length === 2 &&
    b.legs[0].holderId === 'wNear' && b.legs[0].n === 5 &&
    b.legs[1].holderId === 'wMid' && b.legs[1].n === 5);
  check('stock lands where the legs say',
    g.stockIn('wNear') === 100 && g.stockIn('wMid') === 5);

  // yard is the last resort
  g.setStock('wMid', 250);
  g.setStock('wBig', 500);
  const c = g.allocateStock(7, GEO.cents.f1);
  check('warehouses full -> yard takes it', c.placed === 7 && c.legs.length === 1 &&
    c.legs[0].holderId === g.YARD_ID && g.stockIn(g.YARD_ID) === 7);
  check('yard partial fill counts against its cap (43 left)', g.freeRoom(g.YARD_ID) === 43);
  g.setStock(g.YARD_ID, 50);
  const d = g.allocateStock(7, GEO.cents.f1);
  check('everything full -> nothing placed (nothing is made)', d.placed === 0 && d.legs.length === 0);

  // per-tick output matches the tick formula: round(lines * outputPerTick * mult)
  const made = Math.round(1 * BUILDING_CLASSES.factory.outputPerTick * 1.1);
  check('1 line with HQ = round(1 * 1 * 1.1) = 1', made === 1);
  const g2 = makeGame({ storage: makeStorage(), areas: GEO.areas, cents: GEO.cents,
    owned: GEO.owned, hq: 'h' });
  const e = g2.allocateStock(made, GEO.cents.f1);
  check('tick batch is allocated to the nearest warehouse', e.placed === 1 && g2.stockIn('wNear') === 1);
}

console.log('16. stock load & legacy migration (per-holder key, clamped)');
{
  const withStock = (seed, owned = GEO.owned) => makeGame({
    storage: makeStorage(seed), areas: GEO.areas, cents: GEO.cents, owned
  });
  // legacy scalar with nowhere to put it -> yard, clamped to 50
  const legacy = withStock({ 'chatteris-products': '30' }, {});
  check('legacy scalar lands in the yard', legacy.getProducts() === 30 &&
    legacy.stockIn(legacy.YARD_ID) === 30);
  const legacyBig = withStock({ 'chatteris-products': '5000' }, GEO.owned);
  check('legacy 5000 -> warehouses first (100 + 250 + 500), yard 50, capped at 900',
    legacyBig.stockIn('wNear') === 100 && legacyBig.stockIn('wMid') === 250 &&
    legacyBig.stockIn('wBig') === 500 && legacyBig.stockIn(legacyBig.YARD_ID) === 50 &&
    legacyBig.getProducts() === 900);
  // per-holder key wins over the legacy scalar
  const fresh = withStock({
    'chatteris-stock': JSON.stringify({ wBig: 12, __yard: 3 }),
    'chatteris-products': '999'
  });
  check('per-holder stock is authoritative (12 + 3, legacy ignored)',
    fresh.stockIn('wBig') === 12 && fresh.stockIn(fresh.YARD_ID) === 3 &&
    fresh.getProducts() === 15);
  // stale holder ids vanish; over-cap holders clamp to their own capacity
  const stale = withStock({ 'chatteris-stock': JSON.stringify({ gone: 100 }) });
  check('unknown holder id is dropped', stale.getProducts() === 0 && stale.stock.size === 0);
  const over = withStock({ 'chatteris-stock': JSON.stringify({ wNear: 999 }) });
  check('holder stock clamps to its capacity (999 -> 100)', over.stockIn('wNear') === 100);
  const yardOver = withStock({ 'chatteris-stock': JSON.stringify({ __yard: 900 }) });
  check('yard clamps to BASE_STORAGE (900 -> 50)', yardOver.stockIn(yardOver.YARD_ID) === 50);
  // garbage is ignored, not fatal
  const bad = withStock({ 'chatteris-stock': 'not json' });
  check('malformed stock payload falls back safely', bad.getProducts() === 0);
  // written back so the next session reads per-holder stock
  const st = makeStorage({ 'chatteris-products': '30' });
  makeGame({ storage: st, areas: GEO.areas, cents: GEO.cents, owned: {} });
  check('load writes the per-holder key', JSON.parse(st.dump()['chatteris-stock']).__yard === 30);
}

console.log('17. selling buildings (refund + warehouse spill, true overflow liquidated)');
{
  const g = (seed, opts = {}) => makeGame({
    storage: makeStorage(seed), areas: GEO.areas, cents: GEO.cents, owned: opts.owned || GEO.owned,
    roster: opts.roster || [], wallet: opts.wallet ?? 0, hq: opts.hq ?? null
  });

  // factory resale: half price, lines lost, wallet credited
  {
    const m = g({}, { owned: { f1: { cls: 'factory', ts: 1, lines: 3 } }, wallet: 1000 });
    const res = m.sellBuilding('f1', { id: 'f1' });
    check('factory refund = half of $10,000 = $5,000', res.refund === 5000 && res.liquidated === 0);
    check('factory removed from owned & wallet credited', !m.owned.has('f1') && m.getWallet() === 6000);
    check('un-owned id is a no-op (null)', m.sellBuilding('zzz', {}) === null);
  }

  // warehouse contents SPILL into remaining storage; only true overflow sells
  {
    const co = buyerCo();
    const m = g({ 'chatteris-stock': JSON.stringify({ wBig: 450 }) }, { roster: [co] });
    const price = m.companyPrice(co, m.stateFor(co));
    const res = m.sellBuilding('wBig', { id: 'wBig' });
    // wBig is gone (450 units): wMid takes 250 (full), wNear takes 100 (full),
    // the yard takes its 50 — only the last 50 has nowhere to go.
    check('contents spill nearest-first (250 + 100) then the yard (50)',
      m.stockIn('wMid') === 250 && m.stockIn('wNear') === 100 && m.stockIn(m.YARD_ID) === 50);
    check('only true overflow is liquidated (450 -> 400 kept, 50 sold)',
      res.liquidated === 50 && m.getProducts() === 400);
    check('refund = half of $12,000 = $6,000; liquidation = 50 x price',
      res.refund === 6000 && res.liquidationCash === 50 * price && res.buyerName === 'NearestCo');
    check('sold building keeps no stock', m.stockIn('wBig') === 0 && !m.owned.has('wBig'));
    check('buyer demand drained by the overflow only',
      m.stateFor(co).demand === Math.max(0, m.stateFor(co).cap - 50));
    check('spill legs animate short hops (one per receiving warehouse)',
      m.spawnLog.filter((s) => s.dur === 1400).length === 2 &&
      m.spawnLog.some((s) => s.dur === 1400 && s.units === 250) &&
      m.spawnLog.some((s) => s.dur === 1400 && s.units === 100));
    check('liquidation animates a long hop from the sold warehouse',
      m.spawnLog.some((s) => s.dur === 1800 && s.units === 50));
  }

  // true overflow (nothing has room) -> auto-sold to the nearest company
  {
    const co = buyerCo();
    const m = g({
      'chatteris-stock': JSON.stringify({ wNear: 100, __yard: 50 })
    }, { owned: { wNear: { cls: 'warehouse', ts: 2, lines: 0 } }, roster: [co] });
    const price = m.companyPrice(co, m.stateFor(co));
    const res = m.sellBuilding('wNear', { id: 'wNear' });
    check('100 overflow liquidated (yard already full, nothing else to spill into)',
      res.liquidated === 100 && m.getProducts() === 50 && m.stockIn(m.YARD_ID) === 50);
    check('liquidation cash = 100 x nearest price', res.liquidationCash === 100 * price &&
      res.buyerName === 'NearestCo');
    check('refund = half of $2,400 = $1,200 + liquidation credited to wallet',
      m.getWallet() === Math.round(400 * 10 * 0.6 * 0.5) + 100 * price);
    check('buyer demand floored at 0', m.stateFor(co).demand === 0);
  }

  // same overflow with no company in range -> scrapped (no cash, no box)
  {
    const m = g({
      'chatteris-stock': JSON.stringify({ wNear: 100, __yard: 50 })
    }, { owned: { wNear: { cls: 'warehouse', ts: 2, lines: 0 } }, roster: [] });
    const res = m.sellBuilding('wNear', { id: 'wNear' });
    check('no buyer: overflow scrapped, refund only', res.liquidated === 100 &&
      res.liquidationCash === 0 && m.getWallet() === 1200);
    check('scrapped stock leaves no animation', m.spawnLog.length === 0);
  }

  // contents fit the remaining storage -> nothing spills past it
  {
    const m = g({ 'chatteris-stock': JSON.stringify({ wNear: 40 }) });
    const res = m.sellBuilding('wNear', { id: 'wNear' });
    check('small contents move entirely to the nearest remaining warehouse',
      res.liquidated === 0 && m.stockIn('wMid') === 40 && m.getProducts() === 40);
  }

  // selling the HQ clears the unique slot
  {
    const m = g({}, {
      owned: { h: { cls: 'hq', ts: 1, lines: 0 } }, hq: 'h', wallet: 0
    });
    const res = m.sellBuilding('h', { id: 'h' });
    check('HQ refund = half of $10,000 = $5,000 (500 m² x $10 x 2 x 0.5)', res.refund === 5000);
    check('HQ slot cleared', m.getHq() === null);
  }
}

console.log('18. sale sourcing (nearest-to-buyer first, yard last, conserved)');
{
  const game = (seed, owned) => makeGame({
    storage: makeStorage({ 'chatteris-stock': JSON.stringify(seed) }),
    areas: GEO.areas, cents: GEO.cents, owned, roster: [buyerCo()], hq: 'h'
  });

  // wNear 3, wBig 5, yard 2 -> a sale of 8 drains both warehouses, yard intact
  const m = game({ wNear: 3, wBig: 5, __yard: 2 }, GEO.owned);
  const s = m.stateFor(buyerCo());                 // centroid = the factory, ~35 m from wNear
  check('buyer cap for 600 m² = 13', s.cap === 13);
  const cash = m.sellTo(buyerCo(), 8);
  check('sale drains the NEAREST warehouse first', m.stockIn('wNear') === 0);
  check('then the next warehouse', m.stockIn('wBig') === 0);
  check('yard untouched while warehouses still hold stock', m.stockIn(m.YARD_ID) === 2);
  check('products = remaining stock (2)', m.getProducts() === 2);
  check('cash = 8 x price', cash === 8 * m.companyPrice(buyerCo(), s));
  check('demand drained by the units actually taken (13 -> 5)', s.demand === 5);
  check('one box batch per contributing source, units preserved',
    m.spawnLog.length === 2 && m.spawnLog[0].units === 3 && m.spawnLog[1].units === 5);
  check('sale hops use the long duration', m.spawnLog.every((x) => x.dur === 1800));
  check('boxes leave from each warehouse centroid',
    JSON.stringify(m.spawnLog[0].from) === JSON.stringify(GEO.cents.wNear) &&
    JSON.stringify(m.spawnLog[1].from) === JSON.stringify(GEO.cents.wBig));

  // a sale bigger than the warehouses: the yard drains last, from the HQ
  const m2 = game({ wNear: 3, wBig: 5, __yard: 2 }, GEO.owned);
  m2.sellTo(buyerCo(), 10);
  check('yard drained only after every warehouse (10 of 10 sold)', m2.getProducts() === 0);
  check('yard leg animates from the HQ (the yard is virtual)',
    m2.spawnLog.length === 3 && m2.spawnLog[2].units === 2 &&
    JSON.stringify(m2.spawnLog[2].from) === JSON.stringify(GEO.cents.h));

  // exhausted demand: sale refused, stock untouched (conservation)
  const m3 = game({ wNear: 3, wBig: 5, __yard: 2 }, GEO.owned);
  const before = m3.getProducts();
  m3.stateFor(buyerCo()).demand = 0;
  check('exhausted demand sells nothing and keeps every unit',
    m3.sellTo(buyerCo(), 5) === 0 && m3.getProducts() === before && m3.spawnLog.length === 0);
}

console.log('19. delivery box maths (boxPointAt)');
{
  const boxPointAt = new Function(boxPointSrc + '\n    return boxPointAt;')();
  const b = { from: [0, 0], to: [0.01, 0], start: 1000, dur: 1000 };
  const at = (t) => boxPointAt(b, 1000 + t * 1000);
  check('t = 0 sits exactly on the origin', at(0)[0] === 0 && at(0)[1] === 0);
  check('t = 1 lands exactly on the destination', at(1)[0] === 0.01 && at(1)[1] === 0);
  check('times before the start clamp to the origin', boxPointAt(b, 0)[0] === 0);
  check('times after the end clamp to the destination', boxPointAt(b, 5000)[0] === 0.01);
  const mid = at(0.5);
  check('mid-flight arcs off the straight line (perpendicular lift)',
    mid[0] > 0 && mid[0] < 0.01 && mid[1] > 0);
  const excursion = Math.abs(mid[1]) / 0.01;
  check(`arc lift stays a gentle fraction of the hop (${excursion.toFixed(4)})`,
    excursion > 0 && excursion <= 0.1);
  let monotonic = true;
  for (let i = 1; i <= 20; i++) if (at(i / 20)[0] < at((i - 1) / 20)[0]) monotonic = false;
  check('horizontal progress never reverses', monotonic);
  const a = at(0.25), c = at(0.75);
  check('easing is symmetric about the midpoint',
    Math.abs((0.01 - c[0]) - a[0]) < 1e-12 && Math.abs(a[1] - c[1]) < 1e-12);
  const z = boxPointAt({ from: [1, 1], to: [1, 1], start: 0, dur: 10 }, 5);
  check('zero-length hop stays put (no division by zero)', z[0] === 1 && z[1] === 1);
  const capped = { from: [0, 0], to: [1, 0], start: 0, dur: 100 };
  const cm = boxPointAt(capped, 50);
  check('long hops cap the lift at 15% of the span', Math.abs(cm[1]) <= 0.15 * 1 + 1e-12);
}
// (the makeGame tail + GEO fixture live above §15 — see the reorder note)

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
