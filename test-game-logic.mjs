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
const multSrc = grab(/const factoryOutputMult = \(\) =>[\s\S]*?hqId !== null \? 1 \+ BUILDING_CLASSES\.hq\.globalBonus : 1\);/);

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

const run = (storage) => {
  const out = {};
  // eslint-disable-next-line no-new-func
  const fn = new Function('localStorage', classesSrc + '\n' + `
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
    ${multSrc.replace('const factoryOutputMult', 'const factoryOutputMult')}
    const classCount = (cls) => { let n = 0; for (const r of owned.values()) if (r.cls === cls) n++; return n; };
    return { owned, hqId, factoryOutputMult, BUILDING_CLASSES };
  `);
  Object.assign(out, fn(storage));
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

console.log('5. tick maths (factory output multiplier & office income)');
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
  // 2 warehouses: 1 + 0.2*2 = 1.4 ; HQ: 1.1  -> 1.54
  check('factoryOutputMult = 1.54 (2 warehouses + HQ)', Math.abs(factoryOutputMult() - 1.54) < 1e-9);
  // 5 lines * 1 product * 1.54 -> 8 products (rounded) per tick
  check('tick products = round(5 * 1.54) = 8', Math.round(5 * BUILDING_CLASSES.factory.outputPerTick * factoryOutputMult()) === 8);
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

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
