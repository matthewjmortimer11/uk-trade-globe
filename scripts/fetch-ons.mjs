// Pulls UK trade in goods from the ONS beta API and bakes it into a static bundle.
//
//   node scripts/fetch-ons.mjs
//
// Every response is cached under .cache/ so reruns are near-free and the build is
// reproducible offline. Pass --refresh to ignore the cache.
//
// Source: ONS "Trade in goods: country by commodity" (dataset `trade`), Open Government
// Licence v3. https://api.beta.ons.gov.uk/v1/datasets/trade
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'src/data/trade.json');
const API = 'https://api.beta.ons.gov.uk/v1/datasets/trade';
const GEO = 'K02000001'; // United Kingdom — the only geography this dataset carries.
const REFRESH = process.argv.includes('--refresh');
const CONCURRENCY = 6;

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// 'Dec-25' -> 2025-12, as a sortable integer.
const monthKey = (t) => {
  const [mon, yy] = t.split('-');
  return (2000 + Number(yy)) * 12 + MONTHS[mon];
};

async function getJSON(url, cacheKey) {
  const file = path.join(CACHE, `${cacheKey}.json`);
  if (!REFRESH && existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const json = await res.json();
      await writeFile(file, JSON.stringify(json));
      return json;
    } catch (err) {
      lastErr = err;
      // The ONS API rate-limits under load; back off rather than hammer it.
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw lastErr;
}

// Run `jobs` with a fixed worker pool, reporting progress on one line.
async function pool(jobs, label) {
  const results = new Array(jobs.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
      done += 1;
      process.stdout.write(`\r  ${label}: ${done}/${jobs.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');
  return results;
}

const obsUrl = (version, time, direction, sitc) =>
  `${API}/editions/time-series/versions/${version}/observations` +
  `?time=${encodeURIComponent(time)}&geography=${GEO}&countriesandterritories=*` +
  `&direction=${direction}&standardindustrialtradeclassification=${encodeURIComponent(sitc)}`;

// ONS returns observations as strings; blanks and suppressed cells come back non-numeric.
const toNumber = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

async function main() {
  await mkdir(CACHE, { recursive: true });
  await mkdir(path.dirname(OUT), { recursive: true });

  console.log('ONS trade in goods — building static bundle\n');

  // 1. Pin the exact version, so the bundle records what it was built from.
  const dataset = await getJSON(API, 'dataset');
  const version = dataset.links.latest_version.id;
  const base = `${API}/editions/time-series/versions/${version}`;
  console.log(`  dataset v${version}, ONS last updated ${dataset.last_updated.slice(0, 10)}`);

  // 2. Dimension options.
  const dim = (name, limit = 1000) =>
    getJSON(`${base}/dimensions/${name}/options?limit=${limit}`, `v${version}-dim-${name}`);

  const [timeOpt, countryOpt, sitcOpt] = await Promise.all([
    dim('time'),
    dim('countriesandterritories'),
    dim('standardindustrialtradeclassification'),
  ]);

  const times = timeOpt.items.map((i) => i.option).sort((a, b) => monthKey(a) - monthKey(b));
  const countryNames = {};
  for (const item of countryOpt.items) {
    // Labels arrive as "US - United States including Puerto Rico ...".
    countryNames[item.option] = item.label.replace(/^[A-Z0-9]{2}\s*-\s*/, '').trim();
  }
  // Top-level SITC sections are the single-digit codes; 'T' is the all-commodities total.
  const sections = sitcOpt.items
    .filter((i) => /^\d$/.test(i.option))
    .map((i) => ({ code: i.option, label: i.label.replace(/^\d:\s*/, '') }))
    .sort((a, b) => a.code.localeCompare(b.code));

  console.log(`  ${times.length} months (${times[0]} → ${times.at(-1)}), ` +
    `${countryOpt.items.length} countries, ${sections.length} commodity sections`);

  const latest = times.at(-1);
  const directions = ['EX', 'IM'];

  // 3. All-commodity totals for every month and both directions — this drives the
  //    globe, the ranked table and the time scrubber.
  console.log(`\n  Fetching ${times.length * directions.length} monthly totals…`);
  const totalJobs = [];
  for (const direction of directions) {
    for (const time of times) {
      totalJobs.push(async () => ({
        direction,
        time,
        data: await getJSON(obsUrl(version, time, direction, 'T'), `v${version}-T-${direction}-${time}`),
      }));
    }
  }
  const totals = await pool(totalJobs, 'months');

  // 4. Commodity breakdown for the latest month only — enough to power the filter
  //    without a 2,000-call fetch. Documented as a limitation in the README.
  console.log(`\n  Fetching ${sections.length * directions.length} commodity splits for ${latest}…`);
  const comJobs = [];
  for (const direction of directions) {
    for (const s of sections) {
      comJobs.push(async () => ({
        direction,
        code: s.code,
        data: await getJSON(obsUrl(version, latest, direction, s.code), `v${version}-${s.code}-${direction}-${latest}`),
      }));
    }
  }
  const commodities = await pool(comJobs, 'sections');

  // 5. Shape it. Zero and null cells are dropped — the overwhelming majority of the
  //    239 × 96 × 2 grid is zero, and omitting them roughly halves the payload.
  const series = { EX: {}, IM: {} };
  const world = { EX: {}, IM: {} };
  const seen = new Set();

  for (const { direction, time, data } of totals) {
    const row = {};
    for (const obs of data.observations ?? []) {
      const code = obs.dimensions.CountriesAndTerritories.id;
      const value = toNumber(obs.observation);
      if (value === null) continue;
      if (code === 'W1') { world[direction][time] = value; continue; }
      if (code === 'B5' || code === 'D5') continue; // EU / non-EU aggregates
      if (value === 0) continue;
      row[code] = value;
      seen.add(code);
    }
    series[direction][time] = row;
  }

  const commodity = { EX: {}, IM: {} };
  for (const { direction, code, data } of commodities) {
    const row = {};
    for (const obs of data.observations ?? []) {
      const c = obs.dimensions.CountriesAndTerritories.id;
      const value = toNumber(obs.observation);
      if (value === null || value === 0) continue;
      if (c === 'W1' || c === 'B5' || c === 'D5') continue;
      row[c] = value;
    }
    commodity[direction][code] = row;
  }

  const countries = {};
  for (const code of [...seen].sort()) countries[code] = countryNames[code] ?? code;

  const bundle = {
    meta: {
      source: 'Office for National Statistics — Trade in goods: country by commodity',
      sourceUrl: 'https://api.beta.ons.gov.uk/v1/datasets/trade',
      licence: 'Open Government Licence v3.0',
      dataset: 'trade',
      edition: 'time-series',
      version: Number(version),
      onsLastUpdated: dataset.last_updated,
      nextRelease: dataset.next_release,
      releaseFrequency: dataset.release_frequency,
      unit: '£ million, non seasonally adjusted',
      geography: 'United Kingdom',
      builtAt: new Date().toISOString(),
      times,
      latest,
      commodityScope: `Commodity breakdown covers ${latest} only; totals cover all ${times.length} months.`,
    },
    sections,
    countries,
    series,
    world,
    commodity,
  };

  await writeFile(OUT, JSON.stringify(bundle));
  const kb = Math.round(Buffer.byteLength(JSON.stringify(bundle)) / 1024);
  console.log(`\n  Wrote ${path.relative(ROOT, OUT)} — ${kb} KB, ${Object.keys(countries).length} countries with data`);

  const cached = (await readdir(CACHE)).length;
  console.log(`  ${cached} responses cached under .cache/\n`);
}

main().catch((err) => {
  console.error('\nFetch failed:', err.message);
  process.exit(1);
});
