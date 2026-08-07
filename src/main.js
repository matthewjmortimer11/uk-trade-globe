// Where Britain Sells — wiring between the ONS bundle, the globe and the panels.
import './styles.css';
import { Globe, rampColor, divergingColor } from './globe/Globe.js';
import { buildWorld } from './globe/worldModel.js';
import { ISO2_TO_NUM } from './data/iso2.js';
import { MARKETS, REGIMES, TAX_AS_AT } from './data/markets.js';
import bundle from './data/trade.json';

const $ = (sel) => document.querySelector(sel);

const el = {
  shell: $('#app'),
  heroLabel: $('#hero-label'),
  heroValue: $('#hero-value'),
  heroMonth: $('#hero-month'),
  heroYoy: $('#hero-yoy'),
  rankTitle: $('#rank-title'),
  rankCount: $('#rank-count'),
  ranks: $('#ranks'),
  detail: $('#detail'),
  time: $('#time'),
  timeLabel: $('#time-label'),
  play: $('#play'),
  commodity: $('#commodity'),
  source: $('#source'),
  scrubNote: $('#scrub-note'),
  legend: $('#legend'),
  hint: $('#stage-hint'),
};

const { times, latest } = bundle.meta;

const state = {
  direction: 'EX', // EX | IM | BAL
  commodity: 'T', // 'T' or a single-digit SITC section
  t: times.length - 1,
  selected: null,
  playing: false,
};

// ——— formatting ————————————————————————————————————————————————————————

// Values arrive in £ millions.
function money(m) {
  if (m == null || Number.isNaN(m)) return '—';
  const sign = m < 0 ? '−' : '';
  const a = Math.abs(m);
  if (a >= 1000) return `${sign}£${(a / 1000).toFixed(a >= 10000 ? 1 : 2)}bn`;
  return `${sign}£${Math.round(a).toLocaleString('en-GB')}m`;
}

const MONTH_NAMES = {
  Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June',
  Jul: 'July', Aug: 'August', Sep: 'September', Oct: 'October', Nov: 'November', Dec: 'December',
};

function longMonth(t) {
  const [m, y] = t.split('-');
  return `${MONTH_NAMES[m]} 20${y}`;
}

const shortMonth = (t) => t.replace('-', ' ’');

// Clean up ONS's long-form country labels for display.
function countryName(iso2) {
  const raw = bundle.countries[iso2] ?? iso2;
  return raw
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s+inc\b.*$/i, '')
    .replace(/\s+including\b.*$/i, '')
    .trim();
}

// ——— data selection ————————————————————————————————————————————————————

// The commodity split was only fetched for the latest month, so anything other than the
// all-commodity total pins the view to that month. The UI disables the scrubber to match.
const commodityIsTimeless = () => state.commodity !== 'T';

function rowFor(direction, tIndex) {
  if (state.commodity !== 'T') return bundle.commodity[direction][state.commodity] ?? {};
  return bundle.series[direction][times[tIndex]] ?? {};
}

// iso2 -> value for the current view. Balance is exports minus imports, so every country
// that appears on either side needs to be in the union.
function valuesFor(tIndex) {
  if (state.direction !== 'BAL') return { ...rowFor(state.direction, tIndex) };
  const ex = rowFor('EX', tIndex);
  const im = rowFor('IM', tIndex);
  const out = {};
  for (const c of new Set([...Object.keys(ex), ...Object.keys(im)])) {
    out[c] = (ex[c] ?? 0) - (im[c] ?? 0);
  }
  return out;
}

function headlineFor(tIndex) {
  if (state.commodity !== 'T') {
    const sum = (dir) => Object.values(bundle.commodity[dir][state.commodity] ?? {}).reduce((a, b) => a + b, 0);
    return state.direction === 'BAL' ? sum('EX') - sum('IM') : sum(state.direction);
  }
  const t = times[tIndex];
  if (state.direction === 'BAL') return bundle.world.EX[t] - bundle.world.IM[t];
  return bundle.world[state.direction][t];
}

// ——— globe ——————————————————————————————————————————————————————————————

const world = buildWorld();
const globe = new Globe($('#globe'), world, {
  onPick: (iso2) => select(iso2),
  onHover: () => {},
});
globe.start();

// A stable per-arc phase offset, so particles don't march in lockstep.
const phaseFor = (() => {
  const cache = new Map();
  return (iso2) => {
    if (!cache.has(iso2)) {
      // Hash the code rather than use Math.random, so a redraw doesn't resync every particle.
      let h = 0;
      for (const ch of iso2) h = (h * 31 + ch.charCodeAt(0)) % 997;
      cache.set(iso2, h / 997);
    }
    return cache.get(iso2);
  };
})();

const ARC_LIMIT = 45;

// How much of UK trade the tax layer actually accounts for. Computed rather than asserted,
// so it stays honest when markets are added to (or dropped from) `markets.js`.
const TAX_COVERAGE = (() => {
  const both = [bundle.series.EX[latest], bundle.series.IM[latest]];
  const total = both.reduce((a, row) => a + Object.values(row).reduce((x, y) => x + y, 0), 0);
  const covered = Object.keys(MARKETS)
    .reduce((a, c) => a + (both[0][c] ?? 0) + (both[1][c] ?? 0), 0);
  return (covered / total * 100).toFixed(1);
})();

function pushToGlobe(entries) {
  const values = new Map();
  let max = 0;
  for (const [iso2, v] of entries) max = Math.max(max, Math.abs(v));

  for (const [iso2, v] of entries) {
    const num = ISO2_TO_NUM[iso2];
    const meta = num ? world.byNum.get(num) : world.byIso2.get(iso2);
    if (meta) values.set(meta.num, v);
  }

  const arcs = entries
    .slice(0, ARC_LIMIT)
    .map(([iso2, v]) => {
      const meta = world.byIso2.get(iso2);
      if (!meta || iso2 === 'GB') return null;
      return {
        iso2,
        cen: meta.cen,
        weight: max ? Math.sqrt(Math.abs(v) / max) : 0,
        phase: phaseFor(iso2),
        // In balance mode the sign decides which way the money nets, so each arc carries
        // its own direction rather than inheriting the global one.
        dir: state.direction === 'BAL' ? (v >= 0 ? 'EX' : 'IM') : state.direction,
      };
    })
    .filter(Boolean);

  globe.setData({
    values,
    maxValue: max || 1,
    arcs,
    direction: state.direction,
    diverging: state.direction === 'BAL',
  });
}

// ——— rendering ——————————————————————————————————————————————————————————

function render() {
  const tIndex = commodityIsTimeless() ? times.length - 1 : state.t;
  const t = times[tIndex];
  const values = valuesFor(tIndex);

  // Balance ranks by magnitude (biggest imbalances first); flows rank by size.
  const entries = Object.entries(values).sort((a, b) =>
    state.direction === 'BAL' ? Math.abs(b[1]) - Math.abs(a[1]) : b[1] - a[1]);

  el.shell.dataset.dir = state.direction;

  // — hero —
  const dirWord = { EX: 'exports', IM: 'imports', BAL: 'trade balance' }[state.direction];
  const sectionLabel = state.commodity === 'T'
    ? 'goods'
    : bundle.sections.find((s) => s.code === state.commodity)?.label.toLowerCase() ?? 'goods';
  el.heroLabel.textContent = state.direction === 'BAL'
    ? `${sectionLabel} trade balance`
    : `Total ${sectionLabel} ${dirWord}`;

  const headline = headlineFor(tIndex);
  el.heroValue.textContent = money(headline);
  el.heroMonth.textContent = longMonth(t);

  // Year on year, same month, so seasonality doesn't masquerade as a trend.
  if (!commodityIsTimeless() && tIndex >= 12) {
    const prior = headlineFor(tIndex - 12);
    const pct = prior ? ((headline - prior) / Math.abs(prior)) * 100 : null;
    if (pct == null || !Number.isFinite(pct)) {
      el.heroYoy.textContent = '';
    } else {
      el.heroYoy.textContent = `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}% YoY`;
      el.heroYoy.className = `delta ${pct >= 0 ? 'up' : 'down'}`;
    }
  } else {
    el.heroYoy.textContent = '';
    el.heroYoy.className = 'delta';
  }

  // — ranked markets —
  el.rankTitle.textContent = state.direction === 'BAL' ? 'Largest imbalances' : 'Top markets';
  const withValue = entries.filter(([, v]) => v !== 0);
  el.rankCount.textContent = `${withValue.length} markets`;

  const total = entries.reduce((a, [, v]) => a + (state.direction === 'BAL' ? Math.abs(v) : v), 0) || 1;
  const top = entries[0] ? Math.abs(entries[0][1]) : 1;

  el.ranks.replaceChildren(...entries.slice(0, 60).map(([iso2, v], i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rank';
    b.dataset.iso2 = iso2;
    if (iso2 === state.selected) b.setAttribute('aria-current', 'true');

    const share = ((state.direction === 'BAL' ? Math.abs(v) : v) / total) * 100;
    b.innerHTML =
      `<span class="rank-n">${i + 1}</span>` +
      `<span class="rank-name">${countryName(iso2)}</span>` +
      `<span class="rank-right"><span class="rank-val">${money(v)}</span>` +
      `<span class="rank-share">${share.toFixed(1)}%</span></span>` +
      `<span class="rank-bar${v < 0 ? ' neg' : ''}" style="width:${Math.max(1, (Math.abs(v) / top) * 100).toFixed(1)}%"></span>`;

    b.setAttribute('aria-label',
      `${countryName(iso2)}, ${money(v)}, ${share.toFixed(1)} per cent of the total`);
    li.append(b);
    return li;
  }));

  // — scrubber —
  el.time.value = String(tIndex);
  el.timeLabel.value = shortMonth(t);
  el.time.disabled = commodityIsTimeless();
  el.play.disabled = commodityIsTimeless();
  el.scrubNote.hidden = !commodityIsTimeless();
  el.scrubNote.textContent = commodityIsTimeless()
    ? `Commodity detail is fetched for ${shortMonth(latest)} only — switch to All goods for the full ${times.length}-month history.`
    : '';

  pushToGlobe(entries);
  renderDetail(tIndex);
  renderLegend(entries);
}

function renderLegend(entries) {
  const max = entries.length ? Math.abs(entries[0][1]) : 0;
  const stops = Array.from({ length: 12 }, (_, i) => {
    const t = i / 11;
    return state.direction === 'BAL' ? divergingColor(t * 2 - 1) : rampColor(t);
  }).join(',');
  el.legend.innerHTML =
    `<span>${state.direction === 'BAL' ? money(-max) : '0'}</span>` +
    `<span class="legend-scale" style="background:linear-gradient(90deg,${stops})"></span>` +
    `<span>${money(max)}</span>`;
}

function sparkline(iso2) {
  // 24 months of history for the selected market, in the current direction.
  const window = times.slice(Math.max(0, state.t - 23), state.t + 1);
  const series = window.map((t) => {
    if (state.direction === 'BAL') {
      return (bundle.series.EX[t][iso2] ?? 0) - (bundle.series.IM[t][iso2] ?? 0);
    }
    return bundle.series[state.direction][t][iso2] ?? 0;
  });
  if (series.length < 2) return '';

  const max = Math.max(...series, 0);
  const min = Math.min(...series, 0);
  const span = max - min || 1;
  const W = 250;
  const H = 46;
  const x = (i) => (i / (series.length - 1)) * W;
  const y = (v) => H - 3 - ((v - min) / span) * (H - 8);

  const line = series.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const colour = state.direction === 'IM' ? '#60ced6' : state.direction === 'BAL' && series.at(-1) < 0 ? '#e8836f' : '#f2c14e';

  const zero = min < 0 && max > 0
    ? `<line x1="0" y1="${y(0).toFixed(1)}" x2="${W}" y2="${y(0).toFixed(1)}" stroke="rgba(255,255,255,0.22)" stroke-width="1" stroke-dasharray="3 3"/>`
    : '';

  return (
    `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" ` +
    `aria-label="${window.length}-month trend to ${longMonth(window.at(-1))}">` +
    `<path d="${area}" fill="${colour}" opacity="0.11"/>${zero}` +
    `<path d="${line}" fill="none" stroke="${colour}" stroke-width="1.6" stroke-linejoin="round"/>` +
    `<circle cx="${W}" cy="${y(series.at(-1)).toFixed(1)}" r="2.6" fill="${colour}"/></svg>`
  );
}

function renderDetail(tIndex) {
  const iso2 = state.selected;
  if (!iso2) {
    el.detail.innerHTML =
      '<p class="empty">Click a country on the globe, or pick one from the list, to see its trade with the UK ' +
      'and the indirect-tax regime you would be selling into.</p>';
    return;
  }

  const t = times[tIndex];
  const ex = rowFor('EX', tIndex)[iso2] ?? 0;
  const im = rowFor('IM', tIndex)[iso2] ?? 0;
  const bal = ex - im;
  const market = MARKETS[iso2];

  const taxBlock = market
    ? (() => {
        const regime = REGIMES[market.regime];
        const pill = market.regime === 'eu-oss'
          ? '<span class="pill oss">OSS eligible</span>'
          : `<span class="pill no-oss">${regime.label}</span>`;
        return (
          `<div class="tax"><p class="eyebrow">Selling into this market</p>${pill}` +
          '<dl>' +
          `<dt>Standard rate</dt><dd>${market.vat == null ? '—' : `${market.vat}%`}</dd>` +
          `<dt>Regime</dt><dd>${regime.label}</dd>` +
          '</dl>' +
          `<p class="note">${regime.blurb}${market.note ? ` ${market.note}` : ''}</p>` +
          `<p class="note">Indicative, as at ${TAX_AS_AT}. Rates and thresholds change — verify with the ` +
          'tax authority before relying on this. Not tax advice.</p></div>'
        );
      })()
    : '<div class="tax"><p class="eyebrow">Selling into this market</p>' +
      `<p class="note">No indirect-tax profile recorded for ${countryName(iso2)}. The profile covers ` +
      `${Object.keys(MARKETS).length} markets — ${TAX_COVERAGE}% of UK two-way goods trade in ` +
      `${longMonth(latest)}.</p></div>`;

  el.detail.innerHTML =
    `<div><p class="eyebrow">${longMonth(t)}</p><h2>${countryName(iso2)}</h2></div>` +
    '<div class="stat-row">' +
    `<div class="stat"><p>UK exports</p><p style="color:#f2c14e">${money(ex)}</p></div>` +
    `<div class="stat"><p>UK imports</p><p style="color:#60ced6">${money(im)}</p></div>` +
    '</div>' +
    `<div class="stat"><p>Balance</p><p style="color:${bal >= 0 ? '#6fd39a' : '#e8836f'}">${money(bal)}</p></div>` +
    (commodityIsTimeless() ? '' : sparkline(iso2)) +
    taxBlock;
}

// `fly` is off when the pick came from the globe itself — the country is already under the
// pointer, so moving the camera would just be motion for its own sake.
function select(iso2, { fly = false } = {}) {
  state.selected = iso2 && iso2 !== state.selected ? iso2 : null;
  globe.setSelected(state.selected);
  if (state.selected && fly) {
    const meta = world.byIso2.get(state.selected);
    if (meta) globe.flyTo(meta.cen);
  }
  render();
}

// ——— controls ————————————————————————————————————————————————————————————

for (const btn of document.querySelectorAll('.seg button')) {
  btn.addEventListener('click', () => {
    state.direction = btn.dataset.dir;
    for (const b of document.querySelectorAll('.seg button')) {
      b.setAttribute('aria-checked', String(b === btn));
    }
    render();
  });
}

el.commodity.replaceChildren(
  new Option('All goods', 'T'),
  ...bundle.sections.map((s) => new Option(s.label, s.code)),
);
el.commodity.addEventListener('change', () => {
  state.commodity = el.commodity.value;
  if (commodityIsTimeless()) {
    stop();
    state.t = times.length - 1;
  }
  render();
});

el.ranks.addEventListener('click', (e) => {
  const btn = e.target.closest('.rank');
  if (btn) select(btn.dataset.iso2, { fly: true });
});

el.time.addEventListener('input', () => {
  stop();
  state.t = Number(el.time.value);
  render();
});

// Playback advances on elapsed wall-clock time rather than one month per tick. Both timers
// and rAF get clamped when a tab isn't being painted — rAF stops entirely, setInterval drops
// to ~1Hz — and a naive "one month per tick" turns a 10-second run into several minutes.
// Deriving the step count from elapsed time keeps the playthrough the same length either way;
// under throttling it simply gets chunkier.
const MS_PER_MONTH = 110;
let timer = null;
let playClock = 0;

function stop() {
  clearInterval(timer);
  timer = null;
  state.playing = false;
  el.play.textContent = '▶';
  el.play.setAttribute('aria-label', 'Play through every month');
}

function play() {
  state.playing = true;
  el.play.textContent = '❚❚';
  el.play.setAttribute('aria-label', 'Pause');
  // Restart from the beginning if we're already parked at the end.
  if (state.t >= times.length - 1) state.t = 0;

  playClock = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    const steps = Math.floor((now - playClock) / MS_PER_MONTH);
    if (steps < 1) return;
    playClock += steps * MS_PER_MONTH;
    state.t = Math.min(times.length - 1, state.t + steps);
    render();
    if (state.t >= times.length - 1) stop();
  }, MS_PER_MONTH);
}

el.play.addEventListener('click', () => (state.playing ? stop() : play()));

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, button')) return;
  if (e.key === ' ') { e.preventDefault(); state.playing ? stop() : play(); }
  if (e.key === 'Escape' && state.selected) select(null);
});

// Fade the interaction hint once the user has clearly got the idea.
let hinted = false;
$('#globe').addEventListener('pointerdown', () => {
  if (hinted) return;
  hinted = true;
  el.hint.classList.add('hide');
}, { once: true });

// ——— boot ————————————————————————————————————————————————————————————————

el.time.max = String(times.length - 1);
el.source.innerHTML =
  `Source: <a href="${bundle.meta.sourceUrl}" rel="noreferrer">ONS — Trade in goods: country by commodity</a>, ` +
  `v${bundle.meta.version}, updated ${new Date(bundle.meta.onsLastUpdated).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. ` +
  `${bundle.meta.unit}. Contains public sector information licensed under the ${bundle.meta.licence}.`;

render();
el.shell.setAttribute('aria-busy', 'false');

// Open on the largest export market, so the first frame shows the tax layer doing its job —
// but leave the camera on its mid-Atlantic default rather than flying on load.
const opener = Object.entries(bundle.series.EX[latest]).sort((a, b) => b[1] - a[1])[0]?.[0];
if (opener) select(opener);
