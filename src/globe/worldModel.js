// Turns the world-atlas TopoJSON into everything the globe needs: per-country features,
// centroids for arc endpoints, the border/coast meshes, a graticule, and point hit-testing.
//
// Countries are keyed by ISO 3166-1 numeric (world-atlas `id`); the trade bundle is keyed by
// alpha-2, so `numByIso2` is inverted here once and reused.
import { feature, mesh } from 'topojson-client';
import { geoCentroid, geoContains, geoGraticule10 } from 'd3-geo';
// Import attribute so this module also loads under plain Node, which is how the join is
// asserted in `npm run check` — the test exercises the real model rather than a copy of it.
import topo from 'world-atlas/countries-110m.json' with { type: 'json' };
import { ISO2_TO_NUM } from '../data/iso2.js';

export const NUM_TO_ISO2 = Object.fromEntries(
  Object.entries(ISO2_TO_NUM).map(([iso2, num]) => [num, iso2]),
);

// world-atlas ships three partially-recognised territories with `id: undefined`
// (Kosovo, N. Cyprus, Somaliland). Only Kosovo is an ONS trading partner in its own right,
// and its `XK` code is user-assigned rather than ISO — so it joins by name.
const NAME_TO_ISO2 = { Kosovo: 'XK' };

export const UK_LONLAT = [-2.2, 54.0]; // roughly the UK's landmass centroid

export function buildWorld() {
  const geo = feature(topo, topo.objects.countries);

  const metas = [];
  const byNum = new Map();
  const byIso2 = new Map();

  for (const f of geo.features) {
    const name = f.properties?.name ?? '';
    // Features without an id get a stable synthetic key so hover/select still work on them.
    const num = f.id == null ? `x:${name}` : String(f.id).padStart(3, '0');
    const cen = geoCentroid(f);
    if (!Number.isFinite(cen[0]) || !Number.isFinite(cen[1])) continue;
    const meta = {
      num,
      iso2: NUM_TO_ISO2[num] ?? NAME_TO_ISO2[name] ?? null,
      name: name || num,
      f,
      cen,
    };
    metas.push(meta);
    byNum.set(num, meta);
    if (meta.iso2) byIso2.set(meta.iso2, meta);
  }

  // Interior borders only (a !== b), so coastlines aren't double-stroked.
  const borders = mesh(topo, topo.objects.countries, (a, b) => a !== b);
  const coast = mesh(topo, topo.objects.countries, (a, b) => a === b);

  return {
    metas,
    byNum,
    byIso2,
    borders,
    coast,
    // Every arc originates from (or arrives at) the UK, so resolve it once here.
    homeLonLat: byIso2.get('GB')?.cen ?? UK_LONLAT,
    graticule: geoGraticule10(),
    // Which country contains this [lon, lat]? Linear scan over 177 features is well under a
    // frame at pointer rates, and avoids shipping a spatial index for no measurable gain.
    hit(lonlat) {
      if (!lonlat) return null;
      for (const m of metas) if (geoContains(m.f, lonlat)) return m;
      return null;
    },
  };
}
