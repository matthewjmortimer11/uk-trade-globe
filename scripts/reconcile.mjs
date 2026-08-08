// Correctness checks on the baked bundle. Run with `npm run check`.
//
// The important one is reconciliation: ONS publishes a `W1 — Whole world` row alongside the
// per-country rows. Summing our 217 countries should land on that total. If it doesn't, the
// join, the parsing or the zero-pruning is wrong, and the dashboard is quietly lying.
import { readFile } from 'node:fs/promises';
import { ISO2_TO_NUM, AGGREGATES, NO_POLYGON, BY_NAME } from './iso.mjs';

const bundle = JSON.parse(await readFile(new URL('../src/data/trade.json', import.meta.url), 'utf8'));
const iso2Map = JSON.parse(
  JSON.stringify(ISO2_TO_NUM),
);

let failures = 0;
let warnings = 0;

const fail = (msg) => { console.error(`  ✗ ${msg}`); failures += 1; };
const warn = (msg) => { console.warn(`  ! ${msg}`); warnings += 1; };
const pass = (msg) => console.log(`  ✓ ${msg}`);

console.log('\nONS trade bundle — checks\n');

// ——— 1. Reconciliation against ONS's own world total ——————————————————————
console.log('Reconciliation vs ONS "W1 — Whole world"');
{
  let worst = null;
  let checked = 0;

  for (const direction of ['EX', 'IM']) {
    for (const time of bundle.meta.times) {
      const world = bundle.world[direction][time];
      const row = bundle.series[direction][time];
      if (world == null || !row) { fail(`missing data for ${direction} ${time}`); continue; }
      const sum = Object.values(row).reduce((a, b) => a + b, 0);
      const gap = Math.abs(sum - world) / world;
      checked += 1;
      if (!worst || gap > worst.gap) worst = { gap, direction, time, sum, world };
    }
  }

  // In practice ONS's W1 row is exactly the sum of the country rows, so this lands on zero.
  // The tolerance exists because a future release could start carrying an unallocated
  // residual (ships' stores, low-value trade); a couple of percent absorbs that, anything
  // more means the join or the parsing is broken.
  const pct = (worst.gap * 100).toFixed(2);
  if (worst.gap > 0.02) {
    fail(`worst cell is ${pct}% off — ${worst.direction} ${worst.time}: summed ${worst.sum}, ONS W1 ${worst.world}`);
  } else if (worst.gap === 0) {
    pass(`${checked} month × direction totals reconcile exactly against ONS's own world row`);
  } else {
    pass(`${checked} month × direction totals reconcile; worst gap ${pct}% (${worst.direction} ${worst.time}: ${worst.sum} vs ${worst.world})`);
  }
}

// ——— 2. Every ONS country code is accounted for ————————————————————————
console.log('\nCountry code coverage');
{
  const codes = Object.keys(bundle.countries);
  const unmapped = codes.filter(
    (c) => !iso2Map[c] && !AGGREGATES.has(c) && !NO_POLYGON.has(c) && !BY_NAME[c],
  );
  if (unmapped.length) {
    fail(`${unmapped.length} ONS codes have no ISO mapping and are not listed as polygon-less: ${unmapped.join(', ')}`);
  } else {
    pass(`all ${codes.length} trading partners either map to a polygon or are declared polygon-less`);
  }

  const aggregatesLeaked = codes.filter((c) => AGGREGATES.has(c));
  if (aggregatesLeaked.length) fail(`aggregate rows leaked into the country series: ${aggregatesLeaked.join(', ')}`);
  else pass('no aggregate rows (W1/B5/D5) in the country series');
}

// ——— 3. Shape and sanity ——————————————————————————————————————————————
console.log('\nShape');
{
  if (bundle.meta.times.length !== 96) warn(`expected 96 months, got ${bundle.meta.times.length}`);
  else pass('96 months present');

  const sorted = [...bundle.meta.times];
  const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const key = (t) => { const [m, y] = t.split('-'); return (2000 + +y) * 12 + MONTHS[m]; };
  const inOrder = sorted.every((t, i) => i === 0 || key(t) > key(sorted[i - 1]));
  if (!inOrder) fail('times are not in chronological order'); else pass('times are chronological');

  const gaps = sorted.filter((t, i) => i > 0 && key(t) - key(sorted[i - 1]) !== 1);
  if (gaps.length) fail(`gaps in the monthly series before: ${gaps.join(', ')}`);
  else pass('no gaps in the monthly series');

  for (const direction of ['EX', 'IM']) {
    const negatives = bundle.meta.times.flatMap((t) =>
      Object.entries(bundle.series[direction][t]).filter(([, v]) => v < 0).map(([c]) => `${c}@${t}`));
    // Negative trade values are legitimate but rare (returns and credits exceeding the
    // month's flow), so surface them rather than treat them as corruption.
    if (negatives.length) warn(`${direction}: ${negatives.length} negative cells (returns/credits) e.g. ${negatives.slice(0, 3).join(', ')}`);
    else pass(`${direction}: no negative values`);
  }
}

// ——— 4. Commodity split reconciles to the all-commodity total ————————————
console.log('\nCommodity split');
{
  const latest = bundle.meta.latest;
  for (const direction of ['EX', 'IM']) {
    const total = Object.values(bundle.series[direction][latest]).reduce((a, b) => a + b, 0);
    const bySection = Object.values(bundle.commodity[direction])
      .reduce((acc, row) => acc + Object.values(row).reduce((a, b) => a + b, 0), 0);
    const gap = Math.abs(bySection - total) / total;
    if (gap > 0.02) fail(`${direction} ${latest}: sections sum to ${Math.round(bySection)} vs total ${Math.round(total)} (${(gap * 100).toFixed(2)}% off)`);
    else pass(`${direction} ${latest}: 10 SITC sections sum to within ${(gap * 100).toFixed(2)}% of the all-commodity total`);
  }
}

// ——— 5. Spot checks ————————————————————————————————————————————————————
// Values a human can eyeball against the ONS release. If the pipeline ever silently
// reshapes, these are the first things to go wrong.
console.log('\nSpot checks');
{
  const latest = bundle.meta.latest;
  const top = Object.entries(bundle.series.EX[latest]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const names = top.map(([c, v]) => `${bundle.countries[c]} £${v.toLocaleString()}m`);
  console.log(`  · top 5 export markets, ${latest}: ${names.join(' · ')}`);

  if (top[0][0] !== 'US') warn(`largest export market is ${bundle.countries[top[0][0]]}, not the US — worth a look`);
  else pass('the US is the largest single export market, as expected');

  const deficit = bundle.world.IM[latest] - bundle.world.EX[latest];
  console.log(`  · ${latest}: exports £${bundle.world.EX[latest].toLocaleString()}m, imports £${bundle.world.IM[latest].toLocaleString()}m, deficit £${deficit.toLocaleString()}m`);
  if (deficit <= 0) warn('the UK is running a goods surplus this month — that would be a first in decades, check the direction mapping');
  else pass('goods deficit, as expected for the UK');
}

// ——— 6. The ISO join lands on the right polygons ————————————————————————
// The failure mode this guards against is silent and ugly: an off-by-one in the numeric
// codes would shade Greenland with the United States' trade and nobody would notice.
console.log('\nCountry join');
{
  const { buildWorld } = await import('../src/globe/worldModel.js');
  const world = buildWorld();

  const expected = {
    US: 'United States of America', DE: 'Germany', NL: 'Netherlands', IE: 'Ireland',
    FR: 'France', CN: 'China', BE: 'Belgium', ES: 'Spain', IT: 'Italy', JP: 'Japan',
    IN: 'India', CA: 'Canada', AU: 'Australia', ZA: 'South Africa', BR: 'Brazil',
    GB: 'United Kingdom', GL: 'Greenland', NO: 'Norway', KR: 'South Korea', TR: 'Turkey',
  };

  const wrong = Object.entries(expected)
    .map(([iso2, name]) => [iso2, name, world.byIso2.get(iso2)?.name])
    .filter(([, name, got]) => got !== name);

  if (wrong.length) {
    for (const [iso2, want, got] of wrong) fail(`${iso2} resolves to "${got ?? 'nothing'}", expected "${want}"`);
  } else {
    pass(`all ${Object.keys(expected).length} spot-checked ISO codes resolve to the right polygon`);
  }

  // The top 20 markets must all be drawable, or the globe is telling a different story
  // from the table beside it.
  const top20 = Object.entries(bundle.series.EX[bundle.meta.latest])
    .sort((a, b) => b[1] - a[1]).slice(0, 20).map(([c]) => c);
  const undrawable = top20.filter((c) => !world.byIso2.get(c) && !NO_POLYGON.has(c));
  if (undrawable.length) fail(`top-20 markets with no polygon and not declared polygon-less: ${undrawable.join(', ')}`);
  else pass('every top-20 export market is either drawable or explicitly declared polygon-less');
}

// ——— 7. The country rows partition into ONS's own EU / non-EU subtotals ——————
// Stronger than the world-total check. That one only proves the rows add up; this proves
// each row is on the correct side of a boundary ONS drew separately. One country assigned
// to the wrong bloc, or dropped, breaks it while leaving the world total intact.
console.log('\nEU / non-EU partition');
{
  // ONS labels the row "EU(28)", but for these periods it is the 27 member states —
  // the UK is the reporting country, not a partner.
  const EU27 = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
    'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

  let checked = 0;
  let mismatches = 0;
  let worstEu = 0;

  for (const direction of ['EX', 'IM']) {
    for (const time of bundle.meta.times) {
      const row = bundle.series[direction][time];
      const bloc = bundle.blocs?.[direction]?.[time];
      if (!bloc) { fail(`no EU/non-EU subtotals for ${direction} ${time}`); continue; }

      const eu = EU27.reduce((a, c) => a + (row[c] ?? 0), 0);
      const nonEu = Object.entries(row).reduce((a, [c, v]) => a + (EU27.includes(c) ? 0 : v), 0);
      checked += 1;

      if (eu !== bloc.B5 || nonEu !== bloc.D5) {
        mismatches += 1;
        worstEu = Math.max(worstEu, Math.abs(eu - bloc.B5));
        if (mismatches <= 3) {
          fail(`${direction} ${time}: EU rows sum to ${eu} vs ONS B5 ${bloc.B5}; non-EU ${nonEu} vs D5 ${bloc.D5}`);
        }
      }
      if (bloc.B5 + bloc.D5 !== bundle.world[direction][time]) {
        fail(`${direction} ${time}: B5 + D5 (${bloc.B5 + bloc.D5}) ≠ W1 (${bundle.world[direction][time]})`);
      }
    }
  }

  if (!mismatches) pass(`${checked} cells: the 27 EU rows sum exactly to ONS's EU subtotal, the rest to its non-EU subtotal`);
  else fail(`${mismatches} of ${checked} cells mis-partition (worst EU gap ${worstEu})`);
}

// ——— 8. Direction is not transposed ————————————————————————————————————
// A swapped EX/IM mapping would leave every total, partition and reconciliation intact
// while inverting the entire dashboard. These are trade relationships whose direction is
// a matter of public record, so they pin the mapping to reality.
console.log('\nDirection');
{
  const latest = bundle.meta.latest;
  const bal = (c) => (bundle.series.EX[latest][c] ?? 0) - (bundle.series.IM[latest][c] ?? 0);

  // The UK buys Norwegian gas and sells Norway comparatively little.
  if (bal('NO') >= 0) fail(`a surplus with Norway (${bal('NO')}) — the UK is a large net importer of Norwegian energy; EX/IM look transposed`);
  else pass(`net importer from Norway (${bal('NO')} £m), as expected for energy`);

  // The UK runs a persistent goods surplus with Ireland.
  if (bal('IE') <= 0) warn(`a deficit with Ireland (${bal('IE')}) — the UK normally runs a goods surplus there; worth checking`);
  else pass(`net exporter to Ireland (+${bal('IE')} £m), as expected`);

  // And a large deficit with China.
  if (bal('CN') >= 0) fail(`a surplus with China (${bal('CN')}) — EX/IM look transposed`);
  else pass(`net importer from China (${bal('CN')} £m), as expected`);
}

// ——— 9. Magnitude sanity ————————————————————————————————————————————————
// Catches a unit error — thousands read as millions, or vice versa — which no internal
// consistency check can see, because everything would still reconcile.
console.log('\nMagnitude');
{
  const last12 = bundle.meta.times.slice(-12);
  const annual = last12.reduce((a, t) => a + bundle.world.EX[t], 0) / 1000;
  if (annual < 250 || annual > 550) {
    fail(`annual goods exports of £${annual.toFixed(0)}bn is outside the plausible £250–550bn band — check the unit`);
  } else {
    pass(`last 12 months of goods exports total £${annual.toFixed(0)}bn, consistent with a £ million unit`);
  }
}

// ——— 10. The cache still matches the live API ————————————————————————————
// Everything above is computed from a bundle built out of .cache/. This is the only check
// that reaches the network, so it is the only one that can catch the bundle having drifted
// from what ONS actually publishes. Opt-in: `npm run check -- --live`.
if (process.argv.includes('--live')) {
  console.log('\nLive API (re-fetching, bypassing cache)');
  const version = bundle.meta.version;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const samples = Array.from({ length: 4 }, () => ({
    time: pick(bundle.meta.times),
    direction: pick(['EX', 'IM']),
  }));

  // Always include the latest month; it is the one on screen when the page opens.
  samples.push({ time: bundle.meta.latest, direction: 'EX' });

  for (const { time, direction } of samples) {
    const url = `https://api.beta.ons.gov.uk/v1/datasets/trade/editions/time-series/versions/${version}` +
      `/observations?time=${encodeURIComponent(time)}&geography=K02000001&countriesandterritories=*` +
      `&direction=${direction}&standardindustrialtradeclassification=T`;
    try {
      // The ONS endpoint intermittently takes longer than a minute to answer. One retry
      // keeps a slow response from reading as a data mismatch.
      let json;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          json = await res.json();
          break;
        } catch (err) {
          if (attempt >= 1) throw err;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      let live = 0;
      let liveWorld = null;
      for (const obs of json.observations ?? []) {
        const code = obs.dimensions.CountriesAndTerritories.id;
        const value = Number(obs.observation);
        if (!Number.isFinite(value)) continue;
        if (code === 'W1') { liveWorld = value; continue; }
        if (code === 'B5' || code === 'D5') continue;
        live += value;
      }

      const baked = Object.values(bundle.series[direction][time]).reduce((a, b) => a + b, 0);
      if (live !== baked || liveWorld !== bundle.world[direction][time]) {
        fail(`${direction} ${time}: live API says ${live} (W1 ${liveWorld}), bundle says ${baked} (W1 ${bundle.world[direction][time]})`);
      } else {
        pass(`${direction} ${time}: live API matches the bundle exactly (${baked} £m)`);
      }
    } catch (err) {
      warn(`${direction} ${time}: could not reach the ONS API (${err.message})`);
    }
  }
} else {
  console.log('\nLive API');
  console.log('  · skipped — run `npm run check -- --live` to re-fetch sample cells and compare');
}

console.log(`\n${failures ? `FAILED — ${failures} error(s)` : 'All checks passed'}${warnings ? `, ${warnings} warning(s)` : ''}\n`);
process.exit(failures ? 1 : 0);
