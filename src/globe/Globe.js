// The orthographic globe on a <canvas>: space, atmosphere, choropleth land, great-circle
// trade arcs with flowing particles, and pointer interaction.
//
// This is a pure view. It never decides what the data means: the app pushes in a value map
// and an arc list, and taps come back out through `onPick` as ISO alpha-2 codes.
//
// Lineage: the projection setup, drag/momentum model, atmosphere/ocean gradients and star
// field are carried over from the globe in Meridian (github.com/…/Meridian, src/globe/Globe.js),
// which was written for a country-naming game. The choropleth, arc flow and value-driven
// styling here are new.
import { geoOrthographic, geoPath, geoDistance, geoInterpolate } from 'd3-geo';

// Sequential ramp for trade value: deep slate through teal to a hot gold. Multi-hue so
// adjacent bands stay distinguishable, and monotonic in lightness so it survives greyscale.
const RAMP = [
  [0.0, [26, 38, 56]],
  [0.2, [24, 74, 96]],
  [0.4, [30, 122, 130]],
  [0.6, [90, 170, 130]],
  [0.8, [222, 178, 88]],
  [1.0, [255, 226, 168]],
];

export function rampColor(t) {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i += 1) {
    const [p1, c1] = RAMP[i];
    const [p0, c0] = RAMP[i - 1];
    if (x <= p1) {
      const k = (x - p0) / (p1 - p0);
      return `rgb(${Math.round(c0[0] + (c1[0] - c0[0]) * k)},${Math.round(c0[1] + (c1[1] - c0[1]) * k)},${Math.round(c0[2] + (c1[2] - c0[2]) * k)})`;
    }
  }
  return `rgb(${RAMP.at(-1)[1].join(',')})`;
}

// Diverging ramp for the balance view: deficit red through a neutral slate to surplus green.
// Takes -1..1 and is symmetric, so a £2bn surplus and a £2bn deficit read equally strongly.
export function divergingColor(t) {
  const x = Math.max(-1, Math.min(1, t));
  const neutral = [30, 40, 56];
  const end = x < 0 ? [226, 106, 84] : [96, 200, 138];
  const k = Math.sqrt(Math.abs(x));
  return `rgb(${neutral.map((c, i) => Math.round(c + (end[i] - c) * k)).join(',')})`;
}

const STYLE = {
  space: '#05080f',
  ocean: ['#123049', '#0b1d31', '#050d1a'],
  land: '#16202f',
  landNoData: '#131a26',
  coast: 'rgba(190,216,240,0.30)',
  border: 'rgba(190,216,240,0.16)',
  grat: 'rgba(255,255,255,0.035)',
  atmo: 'rgba(96,168,240,0.34)',
  rim: 'rgba(170,205,245,0.26)',
  hover: 'rgba(255,255,255,0.16)',
  shade: 0.5,
  home: '#f2c14e',
};

const ARC_COLOR = { EX: [242, 193, 78], IM: [96, 206, 214] };

export class Globe {
  constructor(canvas, world, { onPick, onHover } = {}) {
    this.cv = canvas;
    this.world = world;
    this.onPick = onPick ?? (() => {});
    this.onHover = onHover ?? (() => {});

    // Opens on the mid-Atlantic: the UK, Europe and North America — which between them carry
    // most of the trade — are all on the near face.
    this.rot = [18, -38];
    this.zoom = 1;
    this.baseScale = 300;
    this.vel = [0, 0];
    this.dirty = true;
    this.hoverNum = null;
    this.selectedIso2 = null;
    this.lastInteract = 0;
    this.pointers = new Map();
    this.drag = null;
    this.pinch = null;
    this.camAnim = null;

    // Pushed in by the app.
    this.values = new Map(); // ISO numeric -> £m
    this.maxValue = 0;
    this.arcs = []; // { cen:[lon,lat], weight:0..1, iso2 }
    this.direction = 'EX';

    this.reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    this.proj = geoOrthographic().clipAngle(90).precision(0.5);
    this._setup();
  }

  // ——— data ———————————————————————————————————————————————————————————

  setData({ values, maxValue, arcs, direction, diverging = false }) {
    this.values = values;
    this.maxValue = maxValue || 1;
    this.arcs = arcs;
    this.direction = direction;
    this.diverging = diverging;
    this.dirty = true;
  }

  setSelected(iso2) {
    this.selectedIso2 = iso2;
    this.dirty = true;
  }

  // ——— lifecycle ——————————————————————————————————————————————————————

  _setup() {
    const cv = this.cv;

    const fit = () => {
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      this.dpr = dpr;
      this.w = w;
      this.h = h;
      this.baseScale = Math.max(1, Math.min(w, h) * 0.5 * 0.86);
      this.proj.translate([w / 2, h / 2]);
      this._makeStars();
      this.dirty = true;
    };
    this.fit = fit;
    fit();
    this.ro = new ResizeObserver(fit);
    this.ro.observe(cv);

    const local = (e) => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    this._onDown = (e) => {
      const pt = local(e);
      this.pointers.set(e.pointerId, pt);
      if (this.pointers.size === 1) {
        cv.setPointerCapture(e.pointerId);
        this.camAnim = null;
        this.pinch = null;
        this.drag = { x: pt[0], y: pt[1], moved: 0, t: Date.now() };
        this.vel = [0, 0];
        cv.style.cursor = 'grabbing';
      } else if (this.pointers.size === 2) {
        this.drag = null;
        this.pinch = { dist: this._pinchDist(), zoom: this.zoom };
        this.vel = [0, 0];
      }
      this.lastInteract = Date.now();
    };

    this._onMove = (e) => {
      this.lastInteract = Date.now();
      const pt = local(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, pt);

      if (this.pinch && this.pointers.size >= 2) {
        const dist = this._pinchDist();
        if (dist > 0 && this.pinch.dist > 0) this.setZoom(this.pinch.zoom * (dist / this.pinch.dist));
        return;
      }
      if (this.drag) {
        const dx = pt[0] - this.drag.x;
        const dy = pt[1] - this.drag.y;
        this.drag.x = pt[0];
        this.drag.y = pt[1];
        this.drag.moved += Math.abs(dx) + Math.abs(dy);
        const k = 70 / this.proj.scale();
        this.rot[0] += dx * k;
        this.rot[1] = Math.max(-89, Math.min(89, this.rot[1] - dy * k));
        this.vel = [dx * k, -dy * k];
        this.dirty = true;
      } else {
        this.pendingHover = pt;
      }
    };

    this._onUp = (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pinch && this.pointers.size < 2) this.pinch = null;
      const d = this.drag;
      if (this.pointers.size === 0) {
        this.drag = null;
        cv.style.cursor = 'grab';
      }
      // A tap, not a drag: resolve to a country.
      if (d && d.moved < 6 && Date.now() - d.t < 500 && this.pointers.size === 0) {
        const m = this.world.hit(this._invertPt(...local(e)));
        this.onPick(m?.iso2 ?? null);
      }
    };

    this._onLeave = () => {
      this.drag = null;
      this.pinch = null;
      this.pointers.clear();
      if (this.hoverNum) {
        this.hoverNum = null;
        this.onHover(null);
        this.dirty = true;
      }
    };

    this._onWheel = (e) => {
      e.preventDefault();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0013));
      this.lastInteract = Date.now();
    };

    cv.addEventListener('pointerdown', this._onDown);
    cv.addEventListener('pointermove', this._onMove);
    cv.addEventListener('pointerup', this._onUp);
    cv.addEventListener('pointerleave', this._onLeave);
    cv.addEventListener('wheel', this._onWheel, { passive: false });
  }

  start() {
    if (!this.raf) this.raf = requestAnimationFrame(this._tick);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = null;
    this.ro?.disconnect();
    const cv = this.cv;
    cv.removeEventListener('pointerdown', this._onDown);
    cv.removeEventListener('pointermove', this._onMove);
    cv.removeEventListener('pointerup', this._onUp);
    cv.removeEventListener('pointerleave', this._onLeave);
    cv.removeEventListener('wheel', this._onWheel);
  }

  // ——— camera ————————————————————————————————————————————————————————

  _pinchDist() {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0;
  }

  setZoom(z) {
    this.zoom = Math.max(0.85, Math.min(4, z));
    this.dirty = true;
  }

  _invertPt(x, y) {
    const t = this.proj.translate();
    const R = this.proj.scale();
    // Outside the disc there is no sphere to invert onto.
    if (Math.hypot(x - t[0], y - t[1]) > R) return null;
    return this.proj.invert([x, y]);
  }

  flyTo(lonlat, { zoom } = {}) {
    if (!lonlat) return;
    this.camAnim = {
      t0: performance.now(),
      dur: 620,
      from: [this.rot[0], this.rot[1], this.zoom],
      to: [-lonlat[0], -lonlat[1], zoom ?? Math.max(this.zoom, 1.25)],
    };
  }

  // ——— render loop ————————————————————————————————————————————————————

  _makeStars() {
    const { w, h } = this;
    if (!w || !h) return;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    const n = Math.round((w * h) / 2600);
    for (let i = 0; i < n; i += 1) {
      const r = Math.random();
      x.globalAlpha = 0.1 + Math.random() * 0.5;
      x.fillStyle = r < 0.12 ? '#ffd9a6' : r < 0.32 ? '#bcd4ff' : '#e8eef8';
      x.fillRect(Math.random() * w, Math.random() * h, Math.random() < 0.92 ? 1 : 2, 1);
    }
    this.starCv = c;
  }

  _tick = (ts) => {
    this.raf = requestAnimationFrame(this._tick);

    if (this.camAnim) {
      const a = this.camAnim;
      const p = Math.min(1, (ts - a.t0) / a.dur);
      const e = p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2; // easeInOutCubic
      // Rotate the short way round rather than unwinding through 360°.
      let dLon = a.to[0] - a.from[0];
      dLon = ((dLon + 180) % 360 + 360) % 360 - 180;
      this.rot[0] = a.from[0] + dLon * e;
      this.rot[1] = a.from[1] + (a.to[1] - a.from[1]) * e;
      this.zoom = a.from[2] + (a.to[2] - a.from[2]) * e;
      this.dirty = true;
      if (p >= 1) this.camAnim = null;
    }

    // Hover is resolved at most once a frame — geoContains over 177 features is cheap but
    // not free, and pointermove fires far faster than 60Hz on a trackpad.
    if (this.pendingHover && !this.drag) {
      const m = this.world.hit(this._invertPt(...this.pendingHover));
      this.pendingHover = null;
      const num = m?.num ?? null;
      if (num !== this.hoverNum) {
        this.hoverNum = num;
        this.onHover(m?.iso2 ?? null);
        this.dirty = true;
      }
      if (!this.drag) this.cv.style.cursor = num ? 'pointer' : 'grab';
    }

    // Momentum, then a slow idle drift once the pointer has been still for a while.
    if (!this.drag && !this.camAnim && (Math.abs(this.vel[0]) > 0.004 || Math.abs(this.vel[1]) > 0.004)) {
      this.rot[0] += this.vel[0];
      this.rot[1] = Math.max(-89, Math.min(89, this.rot[1] + this.vel[1]));
      this.vel = [this.vel[0] * 0.94, this.vel[1] * 0.94];
      this.dirty = true;
    } else if (!this.reducedMotion && !this.drag && !this.camAnim && Date.now() - this.lastInteract > 3200) {
      this.rot[0] += 0.045;
      this.dirty = true;
    }

    // Particles are always in motion, so redraw every frame while any arc is on screen.
    if (!this.reducedMotion && this.arcs.length) this.dirty = true;

    if (this.dirty && this.w) this._draw(ts);
  };

  _draw(ts) {
    this.dirty = false;
    const ctx = this.cv.getContext('2d');
    const { w, h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    ctx.fillStyle = STYLE.space;
    ctx.fillRect(0, 0, w, h);
    if (this.starCv) {
      ctx.globalAlpha = 0.85;
      ctx.drawImage(this.starCv, 0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    this.proj.rotate([this.rot[0], this.rot[1]]).scale(Math.max(1, this.baseScale * this.zoom));
    const path = geoPath(this.proj, ctx);
    const [cx, cy] = this.proj.translate();
    const R = this.proj.scale();

    // Atmosphere halo outside the disc.
    const halo = ctx.createRadialGradient(cx, cy, R * 0.94, cx, cy, R * 1.26);
    halo.addColorStop(0, 'rgba(0,0,0,0)');
    halo.addColorStop(0.2, STYLE.atmo);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.28, 0, 7);
    ctx.fill();

    // Ocean.
    const ocean = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
    ocean.addColorStop(0, STYLE.ocean[0]);
    ocean.addColorStop(0.55, STYLE.ocean[1]);
    ocean.addColorStop(1, STYLE.ocean[2]);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 7);
    ctx.fillStyle = ocean;
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 7);
    ctx.clip();

    ctx.beginPath();
    path(this.world.graticule);
    ctx.strokeStyle = STYLE.grat;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Choropleth. sqrt scaling, because trade value is extremely long-tailed — linear would
    // leave every partner outside the top five indistinguishable from zero.
    for (const m of this.world.metas) {
      const v = this.values.get(m.num);
      ctx.beginPath();
      path(m.f);
      if (v == null) ctx.fillStyle = STYLE.landNoData;
      else if (this.diverging) ctx.fillStyle = divergingColor(v / this.maxValue);
      else ctx.fillStyle = rampColor(Math.sqrt(v / this.maxValue));
      ctx.fill();
    }

    if (this.hoverNum) {
      const m = this.world.byNum.get(this.hoverNum);
      if (m) {
        ctx.beginPath();
        path(m.f);
        ctx.fillStyle = STYLE.hover;
        ctx.fill();
      }
    }

    ctx.beginPath();
    path(this.world.borders);
    ctx.strokeStyle = STYLE.border;
    ctx.lineWidth = 0.7;
    ctx.stroke();

    ctx.beginPath();
    path(this.world.coast);
    ctx.strokeStyle = STYLE.coast;
    ctx.lineWidth = 0.9;
    ctx.stroke();

    // The selected market, pulsing.
    if (this.selectedIso2) {
      const m = this.world.byIso2.get(this.selectedIso2);
      if (m) {
        const a = this.reducedMotion ? 0.85 : 0.55 + 0.35 * Math.sin(ts / 260);
        ctx.beginPath();
        path(m.f);
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.fill();
        ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }

    // Terminator-ish shading: a lit north-west limb falling to a dark south-east one. This is
    // stylised, not a real solar position — it exists to make the sphere read as a sphere.
    const shade = ctx.createRadialGradient(cx - R * 0.45, cy - R * 0.5, R * 0.2, cx - R * 0.08, cy, R * 1.05);
    shade.addColorStop(0, 'rgba(255,255,255,0.10)');
    shade.addColorStop(0.45, 'rgba(0,0,0,0)');
    shade.addColorStop(1, `rgba(2,6,16,${STYLE.shade})`);
    ctx.fillStyle = shade;
    ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);

    ctx.restore();

    // Arcs sit above the shading and outside the clip, so they can rise over the limb.
    this._drawArcs(ctx, R, ts);

    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 7);
    ctx.strokeStyle = STYLE.rim;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Sample a great circle, project it, and push each point away from the globe centre so the
  // arc lifts off the surface — peaking at the midpoint, anchored at both ends.
  _arcPoints(a, b, R, samples = 64) {
    const interp = geoInterpolate(a, b);
    const [cx, cy] = this.proj.translate();
    const centre = [-this.rot[0], -this.rot[1]];
    const span = geoDistance(a, b);
    const lift = Math.min(0.34, 0.06 + span * 0.16);
    const pts = [];

    for (let i = 0; i <= samples; i += 1) {
      const t = i / samples;
      const ll = interp(t);
      const p = this.proj(ll);
      if (!p) {
        pts.push(null);
        continue;
      }
      const bump = Math.sin(Math.PI * t) * lift;
      // Hide the segment once the ground track is far enough behind the limb that even the
      // lifted arc would be occluded.
      if (geoDistance(ll, centre) > Math.PI / 2 + bump * 1.15) {
        pts.push(null);
        continue;
      }
      const dx = p[0] - cx;
      const dy = p[1] - cy;
      const d = Math.hypot(dx, dy) || 1;
      pts.push([cx + (dx / d) * (d + R * bump), cy + (dy / d) * (d + R * bump)]);
    }
    return pts;
  }

  _drawArcs(ctx, R, ts) {
    if (!this.arcs.length) return;
    const home = this.world.homeLonLat;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const arc of this.arcs) {
      // In balance mode each arc carries its own direction — the sign of the net flow.
      const dir = arc.dir ?? this.direction;
      const [ar, ag, ab] = ARC_COLOR[dir] ?? ARC_COLOR.EX;
      // Exports leave the UK; imports arrive at it. Reversing the endpoints makes the
      // particle flow read in the right direction without any extra state.
      const [from, to] = dir === 'EX' ? [home, arc.cen] : [arc.cen, home];
      const pts = this._arcPoints(from, to, R);
      const selected = arc.iso2 === this.selectedIso2;
      const width = Math.max(0.7, R * 0.0045 * (0.35 + arc.weight * 1.9)) * (selected ? 2 : 1);
      const alpha = (0.18 + arc.weight * 0.5) * (selected ? 1.6 : 1);

      // Additive blending is what makes overlapping corridors glow rather than muddy.
      ctx.globalCompositeOperation = 'lighter';

      ctx.beginPath();
      let pen = false;
      for (const p of pts) {
        if (!p) { pen = false; continue; }
        if (pen) ctx.lineTo(p[0], p[1]); else { ctx.moveTo(p[0], p[1]); pen = true; }
      }
      ctx.strokeStyle = `rgba(${ar},${ag},${ab},${Math.min(0.9, alpha).toFixed(3)})`;
      ctx.lineWidth = width;
      ctx.shadowColor = `rgba(${ar},${ag},${ab},0.6)`;
      ctx.shadowBlur = selected ? 14 : 6;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Flow particles — the thing that says "this is a flow, not a line".
      if (!this.reducedMotion) {
        const count = selected ? 3 : arc.weight > 0.45 ? 2 : 1;
        const speed = 0.00016 + arc.weight * 0.00008;
        for (let k = 0; k < count; k += 1) {
          const t = ((ts * speed + k / count + arc.phase) % 1);
          const idx = Math.round(t * (pts.length - 1));
          const p = pts[idx];
          if (!p) continue;
          // Fade in and out at the endpoints so particles don't pop.
          const edge = Math.min(1, Math.sin(Math.PI * t) * 2.2);
          const r = Math.max(1.1, R * 0.0075 * (0.5 + arc.weight)) * (selected ? 1.5 : 1);
          const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r * 3);
          g.addColorStop(0, `rgba(255,255,255,${(0.9 * edge).toFixed(3)})`);
          g.addColorStop(0.35, `rgba(${ar},${ag},${ab},${(0.75 * edge).toFixed(3)})`);
          g.addColorStop(1, `rgba(${ar},${ag},${ab},0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p[0], p[1], r * 3, 0, 7);
          ctx.fill();
        }
      }

      ctx.globalCompositeOperation = 'source-over';
    }

    // The UK marker, drawn last so it sits on top of every arc origin.
    const hp = this.proj(home);
    if (hp && geoDistance(home, [-this.rot[0], -this.rot[1]]) < Math.PI / 2) {
      const pulse = this.reducedMotion ? 1 : 1 + 0.22 * Math.sin(ts / 420);
      ctx.beginPath();
      ctx.arc(hp[0], hp[1], Math.max(4, R * 0.014) * pulse, 0, 7);
      ctx.strokeStyle = 'rgba(242,193,78,0.75)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(hp[0], hp[1], Math.max(1.8, R * 0.005), 0, 7);
      ctx.fillStyle = STYLE.home;
      ctx.fill();
    }

    ctx.restore();
  }
}
