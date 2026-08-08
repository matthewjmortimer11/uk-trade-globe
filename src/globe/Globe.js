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

// The palette is defined once, in tokens.css. Reading it here at module load keeps the
// legend gradient (CSS) and the landmasses (canvas) from drifting apart, and means a
// colour change is a one-file edit.
const token = (name, fallback) => {
  if (typeof getComputedStyle !== 'function') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
};

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const lerp = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const css = (rgb, alpha) => (alpha == null ? `rgb(${rgb.join(',')})` : `rgba(${rgb.join(',')},${alpha})`);

// Sequential ramp: one hue, dark to light. A magnitude scale must not change hue — a
// rainbow reads as categories that aren't there.
const RAMP = ['--seq-0', '--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6']
  .map((n, i) => hexToRgb(token(n, ['#1c1814', '#2b2216', '#44331a', '#674b1f', '#926c29', '#bf933b', '#e8c378'][i])));

export function rampColor(t) {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  return css(lerp(RAMP[i], RAMP[i + 1], x - i));
}

// Diverging ramp for the balance view: two hues either side of a neutral midpoint. Takes
// -1..1 and is symmetric, so a £2bn surplus and a £2bn deficit read equally strongly.
const DIV_MID = hexToRgb(token('--ink-750', '#2a251f'));
const DIV_NEG = hexToRgb(token('--deficit', '#b3654d'));
const DIV_POS = hexToRgb(token('--surplus', '#6f9a6f'));

export function divergingColor(t) {
  const x = Math.max(-1, Math.min(1, t));
  return css(lerp(DIV_MID, x < 0 ? DIV_NEG : DIV_POS, Math.sqrt(Math.abs(x))));
}

// Warm ink rather than navy. The ocean sits only a step above the well it's drawn in, so
// the sphere reads as a mass rather than a lit ball.
const STYLE = {
  space: token('--ink-950', '#100e0c'),
  ocean: ['#1b262c', '#141d22', '#0e1418'],
  landNoData: token('--land-empty', '#1a1613'),
  coast: 'rgba(215,207,196,0.26)',
  border: 'rgba(215,207,196,0.10)',
  grat: 'rgba(215,207,196,0.045)',
  atmo: 'rgba(120,150,168,0.14)',
  rim: 'rgba(215,207,196,0.18)',
  hover: 'rgba(236,230,220,0.13)',
  shade: 0.44,
  home: token('--ink-100', '#ece6dc'),
};

const ARC_COLOR = {
  EX: hexToRgb(token('--export-bright', '#dcae52')),
  IM: hexToRgb(token('--import-bright', '#82aac2')),
};

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

    // On touch the page scrolls and the globe is only part of it, so a single finger must
    // belong to the page — otherwise a finger landing anywhere on the globe traps the
    // scroll. Two fingers rotate and pinch, the same convention embedded maps use.
    this.coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

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

    // Whether this pointer should drive the camera at all. A lone finger never does.
    const oneFingerDrags = (e) => !(this.coarse && e.pointerType === 'touch');

    this._onDown = (e) => {
      const pt = local(e);
      this.pointers.set(e.pointerId, pt);
      if (this.pointers.size === 1) {
        this.camAnim = null;
        this.pinch = null;
        this.vel = [0, 0];
        // Still record the press, so a tap can resolve to a country even on touch.
        this.drag = { x: pt[0], y: pt[1], moved: 0, t: Date.now(), rotates: oneFingerDrags(e) };
        if (this.drag.rotates) {
          cv.setPointerCapture(e.pointerId);
          cv.style.cursor = 'grabbing';
        }
      } else if (this.pointers.size === 2) {
        this.drag = null;
        this.vel = [0, 0];
        this.pinch = { dist: this._pinchDist(), zoom: this.zoom, mid: this._pinchMid() };
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
        // Two-finger drag rotates: the midpoint between the fingers steers the camera, so
        // pinching and turning the globe are one continuous gesture rather than two modes.
        const mid = this._pinchMid();
        if (mid && this.pinch.mid) {
          const k = 70 / this.proj.scale();
          this.rot[0] += (mid[0] - this.pinch.mid[0]) * k;
          this.rot[1] = Math.max(-89, Math.min(89, this.rot[1] - (mid[1] - this.pinch.mid[1]) * k));
          this.pinch.mid = mid;
          this.dirty = true;
        }
        return;
      }
      if (this.drag && !this.drag.rotates) {
        // A lone finger: track how far it has moved so we can tell a tap from a scroll,
        // but leave the camera alone and let the page scroll underneath.
        this.drag.moved += Math.abs(pt[0] - this.drag.x) + Math.abs(pt[1] - this.drag.y);
        this.drag.x = pt[0];
        this.drag.y = pt[1];
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
      } else if (!this.coarse) {
        // No hover state on touch — there is no pointer resting anywhere to justify one.
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

    // The browser fires pointercancel when it claims the gesture for scrolling. Without
    // this the globe keeps a stale drag and the next tap is swallowed.
    this._onCancel = () => {
      this.drag = null;
      this.pinch = null;
      this.pointers.clear();
      this.vel = [0, 0];
    };

    cv.addEventListener('pointerdown', this._onDown);
    cv.addEventListener('pointermove', this._onMove);
    cv.addEventListener('pointerup', this._onUp);
    cv.addEventListener('pointercancel', this._onCancel);
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
    cv.removeEventListener('pointercancel', this._onCancel);
    cv.removeEventListener('pointerleave', this._onLeave);
    cv.removeEventListener('wheel', this._onWheel);
  }

  // ——— camera ————————————————————————————————————————————————————————

  _pinchDist() {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0;
  }

  _pinchMid() {
    const [a, b] = [...this.pointers.values()];
    return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
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

    this.proj.rotate([this.rot[0], this.rot[1]]).scale(Math.max(1, this.baseScale * this.zoom));
    const path = geoPath(this.proj, ctx);
    const [cx, cy] = this.proj.translate();
    const R = this.proj.scale();

    // A thin, cool halo that separates the sphere from the well. Tight and faint — the
    // previous version bloomed out to 1.28R in saturated blue, which is the single most
    // recognisable "AI space dashboard" cue.
    const halo = ctx.createRadialGradient(cx, cy, R * 0.985, cx, cy, R * 1.07);
    halo.addColorStop(0, 'rgba(0,0,0,0)');
    halo.addColorStop(0.35, STYLE.atmo);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.08, 0, 7);
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

    // The selected market: a steady paper-white outline. It used to pulse, which drew the
    // eye continuously to something the user had already found.
    if (this.selectedIso2) {
      const m = this.world.byIso2.get(this.selectedIso2);
      if (m) {
        ctx.beginPath();
        path(m.f);
        ctx.strokeStyle = 'rgba(236,230,220,0.85)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }

    // Terminator-ish shading: a lit north-west limb falling to a dark south-east one. This is
    // stylised, not a real solar position — it exists to make the sphere read as a sphere.
    const shade = ctx.createRadialGradient(cx - R * 0.45, cy - R * 0.5, R * 0.2, cx - R * 0.08, cy, R * 1.05);
    shade.addColorStop(0, 'rgba(255,246,232,0.05)');
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
      // Thin marks. Weight still encodes value, but across a narrow band (0.6–2.2px)
      // rather than the wide, soft strokes the glow was compensating for.
      const width = selected ? 2.2 : Math.max(0.6, 0.6 + arc.weight * 1.1);
      const alpha = selected ? 0.95 : 0.22 + arc.weight * 0.42;

      ctx.beginPath();
      let pen = false;
      for (const p of pts) {
        if (!p) { pen = false; continue; }
        if (pen) ctx.lineTo(p[0], p[1]); else { ctx.moveTo(p[0], p[1]); pen = true; }
      }
      ctx.strokeStyle = `rgba(${ar},${ag},${ab},${alpha.toFixed(3)})`;
      ctx.lineWidth = width;
      ctx.stroke();

      // One travelling mark per arc — a small solid dot, not a glowing orb. It still
      // reads as flow because it moves; it doesn't need a halo to say so.
      if (!this.reducedMotion) {
        const t = (ts * (0.00013 + arc.weight * 0.00006) + arc.phase) % 1;
        const p = pts[Math.round(t * (pts.length - 1))];
        if (p) {
          // Fade in and out at the endpoints so marks don't pop into existence.
          const edge = Math.min(1, Math.sin(Math.PI * t) * 2.4);
          ctx.beginPath();
          ctx.arc(p[0], p[1], selected ? 2.4 : 1.5, 0, 7);
          ctx.fillStyle = `rgba(${ar},${ag},${ab},${(edge * (selected ? 1 : 0.8)).toFixed(3)})`;
          ctx.fill();
        }
      }
    }

    // The origin, drawn last so it sits above every arc. A surveyor's crosshair rather
    // than a pulsing dot: this is a fixed reference point, and it should look like one.
    const hp = this.proj(home);
    if (hp && geoDistance(home, [-this.rot[0], -this.rot[1]]) < Math.PI / 2) {
      const arm = Math.max(5, R * 0.018);
      ctx.strokeStyle = STYLE.home;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hp[0] - arm, hp[1]);
      ctx.lineTo(hp[0] + arm, hp[1]);
      ctx.moveTo(hp[0], hp[1] - arm);
      ctx.lineTo(hp[0], hp[1] + arm);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(hp[0], hp[1], arm * 0.42, 0, 7);
      ctx.stroke();
    }

    ctx.restore();
  }
}
