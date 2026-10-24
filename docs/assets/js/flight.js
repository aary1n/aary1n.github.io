// The logo butterfly's flight path, drawn like a pen sketch of a constellation: a broken, wobbly line from its tail
// down the page, ink dots at the turns, faint side lines out to stars, a scatter of stars and doodles, one gold orbit.
// Decoration only. Lines "boil" a little, like hand-drawn animation. Most of the sky stays put, but a few stars and
// small constellations drift, and the mouse can nudge them; now and then a shooting star runs along the gold orbit.
// Everything holds still for reduced motion.
(() => {
  const bfly = document.querySelector(".bfly--name");
  const canvas = document.createElement("canvas");
  if (!bfly || !canvas.getContext) return;
  canvas.className = "flight";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  const ctx = canvas.getContext("2d");
  const root = document.documentElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)");

  const BOIL = 3;       // times a second the wobble changes; every line has three versions that take turns
  const FPS = 12;       // for the twinkle and the orbiting dot
  const REACH = 130;    // px around the cursor that drifting things get pushed away from
  const SHOVE = 120;    // how hard, in px/s², right next to it
  const SETTLE = 2;     // seconds for a nudge to die away and the slow drift to take over again
  const SHOTS = [14, 30];  // seconds between shooting stars
  const ORBIT = 140;    // seconds a shooting star would take to go all the way round; it only crosses the visible arc

  let scene = null;
  let ink = "", gold = "", strength = 1;
  let planWidth = 0;
  let reveal = null;    // {from, for}: the path draws itself out of the tail on the first page of a visit
  let dirty = true;
  // The cursor, in window coordinates. `on` while it's out in the margins; never over text, links, or off the page.
  const hand = { x: 0, y: 0, on: false };
  let shot = null, nextShot = Infinity;  // the shooting star in flight, and when the next one goes

  // Seeded by the page's address, so each page keeps the same sky from one visit to the next.
  function rng(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const seedOf = (s) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261);
  let random = Math.random;
  const rand = (a, b) => a + random() * (b - a);
  const pick = (xs) => xs[Math.floor(random() * xs.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const TAU = Math.PI * 2;

  // The tail end of the drawing, in page coordinates, and the direction the body points away from the head.
  function tail() {
    const r = bfly.getBoundingClientRect();
    const rot = (parseFloat(getComputedStyle(bfly).getPropertyValue("--rot")) || 0) * Math.PI / 180;
    const d = bfly.offsetHeight * 0.26;  // the end of the body sits about a quarter of the height below the centre
    return {
      x: r.left + r.width / 2 - Math.sin(rot) * d + scrollX,
      y: r.top + r.height / 2 + Math.cos(rot) * d + scrollY,
      dir: rot + Math.PI / 2,
    };
  }

  // ---- geometry -------------------------------------------------------------------------------------------

  const lineAt = (a, b, step) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }));
  };
  const densify = (pts, step) => pts.slice(1).flatMap((b, i) => lineAt(pts[i], b, step).slice(i ? 1 : 0));

  function lengths(pts) {
    const s = [0];
    for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    return s;
  }

  function bounds(pts, pad) {
    let top = Infinity, bottom = -Infinity;
    for (const p of pts) { top = Math.min(top, p.y); bottom = Math.max(bottom, p.y); }
    return { top: top - pad, bottom: bottom + pad };
  }

  // Catmull-Rom through the points, as cubic bezier segments: [p1, c1, c2, p2].
  // Handles are capped relative to the segment's length; otherwise a short hop next to a long one bulges sideways.
  function segments(pts) {
    const out = [];
    const handle = (dx, dy, max) => {
      const len = Math.hypot(dx, dy) / 6;
      const k = len > max ? max / len : 1;
      return { x: dx / 6 * k, y: dy / 6 * k };
    };
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const max = Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.4;
      const h1 = handle(p2.x - p0.x, p2.y - p0.y, max);
      const h2 = handle(p3.x - p1.x, p3.y - p1.y, max);
      out.push([p1, { x: p1.x + h1.x, y: p1.y + h1.y }, { x: p2.x - h2.x, y: p2.y - h2.y }, p2]);
    }
    return out;
  }

  function bezierAt([a, b, c, d], step) {
    const rough = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y) + Math.hypot(d.x - c.x, d.y - c.y);
    const n = Math.max(2, Math.ceil(rough / step));
    return Array.from({ length: n + 1 }, (_, i) => {
      const t = i / n, u = 1 - t;
      return {
        x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
        y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
      };
    });
  }

  // A pen line never lands exactly where it was meant to. Bend the points sideways along smooth noise (`drift`),
  // then make three versions that differ by a fraction of a pixel (`boil`) for the line to flicker between.
  // `k` raises the noise frequency for small marks, so a 10px doodle still gets a wobble.
  function sketch(pts, drift, boil, k = 1) {
    const s = lengths(pts);
    const normal = pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
      return { x: -dy / l, y: dx / l };
    });
    const wave = (amp) => {
      const f1 = rand(0.01, 0.03) * k, f2 = rand(0.06, 0.12) * k, p1 = rand(0, TAU), p2 = rand(0, TAU);
      return (d) => amp * (0.7 * Math.sin(d * f1 + p1) + 0.3 * Math.sin(d * f2 + p2));
    };
    const base = wave(drift);
    return [0, 1, 2].map(() => {
      const w = wave(boil);
      return pts.map((p, i) => {
        const o = base(s[i]) + w(s[i]) + rand(-boil, boil) * 0.3;
        return { x: p.x + normal[i].x * o, y: p.y + normal[i].y * o };
      });
    });
  }

  // Any line that isn't the main path: side lines, doodles, motion marks, the orbit.
  // `s` is how far along the path it belongs (for the fade and the reveal); `bg` marks it as part of the sky instead.
  const mark = (pts, o) => ({
    v: sketch(pts, o.drift ?? 0.6, o.boil ?? 0.35, o.k ?? 1),
    ...bounds(pts, 8), s: 0, a: 0.3, w: 1, bg: false, gold: false, ...o,
  });

  // Doodles, in unit coordinates.
  const quad = (a, c, b, n = 6) => Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, u = 1 - t;
    return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
  });
  const TIPS = [[0, -1], [1, 0], [0, 1], [-1, 0], [0, -1]];
  const SHAPES = {
    // ✧, drawn as one stroke round the four tips with the sides pulled in
    sparkle: [TIPS.slice(0, 4).flatMap((a, i) => {
      const b = TIPS[i + 1];
      return quad(a, [(a[0] + b[0]) * 0.1, (a[1] + b[1]) * 0.1], b).slice(i ? 1 : 0);
    })],
    plus: [[[-1, 0], [1, 0]], [[0, -1.1], [0, 0.9]]],
    cross: [[[-0.7, -0.7], [0.7, 0.7]], [[0.7, -0.7], [-0.7, 0.7]]],
    asterisk: [0, 1, 2].map((i) => {
      const a = i * Math.PI / 3 + 0.3;
      return [[Math.cos(a), Math.sin(a)], [-Math.cos(a), -Math.sin(a)]];
    }),
    // a small o, with the pen carrying on past where it started
    ring: [Array.from({ length: 14 }, (_, i) => [Math.cos(i / 12 * TAU) * 0.6, Math.sin(i / 12 * TAU) * 0.6])],
  };
  const KINDS = ["sparkle", "sparkle", "sparkle", "plus", "plus", "ring", "asterisk", "cross"];

  function doodle(kind, at, size, o) {
    const r = rand(0, TAU), c = Math.cos(r), s = Math.sin(r);
    return SHAPES[kind].map((line) => {
      const pts = line.map(([x, y]) => ({ x: at.x + (x * c - y * s) * size, y: at.y + (x * s + y * c) * size }));
      return mark(densify(pts, 1.5), { drift: 0.25, boil: 0.25, k: 6, w: rand(0.9, 1.25), ...o });
    });
  }

  // An open, slightly lopsided circle round a point, the way you'd ring a star on a chart.
  function circle(at, r, o) {
    const a0 = rand(0, TAU), over = rand(0.25, 0.6), ph = rand(0, TAU);
    const n = Math.ceil((TAU + over) * r / 1.5);
    const pts = Array.from({ length: n + 1 }, (_, i) => {
      const a = a0 + (TAU + over) * i / n, rr = r * (1 + 0.08 * Math.sin(a * 2 + ph)) + i / n * 0.8;
      return { x: at.x + Math.cos(a) * rr, y: at.y + Math.sin(a) * rr };
    });
    return mark(pts, { drift: 0.3, boil: 0.25, k: 4, ...o });
  }

  // A few short strokes in a clump: spray, or motion marks.
  function spray(at, angle, spread, o) {
    return Array.from({ length: Math.floor(rand(4, 8)) }, () => {
      const p = { x: at.x + rand(-spread, spread), y: at.y + rand(-spread, spread) };
      const a = angle + rand(-0.35, 0.35), len = rand(3, 8);
      const q = { x: p.x + Math.cos(a) * len, y: p.y + Math.sin(a) * len };
      return mark(lineAt(p, q, 1.5), { drift: 0.2, boil: 0.2, k: 6, w: rand(0.8, 1.2), ...o });
    });
  }

  // A few stars joined by pen lines, centred on (0, 0) so the whole thing can drift and turn as one.
  function constellation() {
    const pts = [{ x: 0, y: 0 }];
    let a = rand(0, TAU);
    for (let n = Math.floor(rand(3, 6)); pts.length < n;) {
      a += rand(-1.2, 1.2);
      const d = rand(22, 46), p = pts[pts.length - 1];
      pts.push({ x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d });
    }
    const links = pts.slice(1).map((q, i) => [pts[i], q]);
    if (pts.length > 3 && random() < 0.5) {  // a spur off the second star
      const b = rand(0, TAU), d = rand(20, 34);
      const q = { x: pts[1].x + Math.cos(b) * d, y: pts[1].y + Math.sin(b) * d };
      pts.push(q);
      links.push([pts[1], q]);
    }
    const cx = pts.reduce((t, p) => t + p.x, 0) / pts.length, cy = pts.reduce((t, p) => t + p.y, 0) / pts.length;
    const at = (p) => ({ x: p.x - cx, y: p.y - cy });
    return {
      stars: pts.map((p) => ({ ...at(p), r: rand(1.1, 1.9), a: rand(0.45, 0.7) })),
      marks: links.map(([p, q]) => mark(lineAt(at(p), at(q), 3), { drift: 0.6, boil: 0.35, a: 0.22, w: 0.9 })),
      spin: rand(-0.02, 0.02),
      mass: 2,  // a constellation is shoved less than a lone star
    };
  }

  // Somewhere on the page, with a slow wandering heading: a few px a second.
  function drifter(W, H, body) {
    return {
      x: rand(0, W), y: rand(0, H), vx: 0, vy: 0, rot: rand(0, TAU),
      speed: rand(2, 6), heading: rand(0, TAU), wander: rand(0.03, 0.08), phase: rand(0, TAU),
      stars: [], marks: [], spin: 0, mass: 1, ...body,
    };
  }

  // ---- the plan for this page ------------------------------------------------------------------------------

  // The trail runs straight out of the tail along the body first, so the butterfly faces down its own path.
  // Then it sweeps back and forth down the page with plenty of jitter, plus the odd loop-the-loop.
  function waypoints(W, H, t) {
    const ux = Math.cos(t.dir), uy = Math.sin(t.dir);
    const pts = [
      { x: t.x + ux * 40, y: t.y + uy * 40, lead: true },
      { x: t.x + ux * 110, y: t.y + uy * 110 },
    ];
    const lead = pts[1];
    const cols = W < 640 ? 2 : W < 1100 ? 3 : 4;
    const rowH = W < 640 ? 170 : 230;
    const rows = Math.max(2, Math.round((H - lead.y) / rowH));
    const cellW = W / cols;
    const firstRight = ux >= 0;  // the first sweep carries on sideways the way the tail points; rows then alternate
    for (let r = 0; r < rows; r++) {
      const right = (r % 2 === 0) === firstRight;
      const order = [...Array(cols).keys()];
      if (!right) order.reverse();
      for (const c of order) {
        const x = clamp((c + rand(0.15, 0.85)) * cellW, 24, W - 24);
        const y = clamp(lead.y + (r + rand(0.25, 0.85)) * rowH, 24, H - 24);
        if (r === 0 && (right ? x < lead.x + 60 : x > lead.x - 60)) continue;  // no doubling back past the lead-in
        if (random() < 0.25) continue;  // skip some cells so it doesn't look like a grid
        pts.push({ x, y });
        if (random() < 0.12) {  // a small loop: a circle beside this point that starts and ends on it
          const rad = rand(18, 30);
          const spin = random() < 0.5 ? 1 : -1;
          for (let k = 1; k <= 4; k++) {
            const a = Math.PI + spin * k * Math.PI / 2;
            pts.push({ x: x + rad + Math.cos(a) * rad, y: y + Math.sin(a) * rad, loop: true });
          }
        }
      }
    }
    return pts;
  }

  // Curl a line round the boxes instead of through them. Where it crosses one, add a single quartic dip,
  // depth × (1 − u²)²: flat where it starts and ends, round at the bottom. Of a few centres and widths, it takes the
  // one that clears the box (past its nearer edge) with the shallowest dip, so a sloping line isn't pushed miles out.
  function bendRound(pts, boxes) {
    const RAMP = 170;
    return boxes.reduce((pts, b) => {
      const hit = pts.filter((p) => p.x > b.left && p.x < b.right && p.y > b.top && p.y < b.bottom);
      if (!hit.length) return pts;
      const y = hit.reduce((t, p) => t + p.y, 0) / hit.length;
      const under = b.bottom - y < y - b.top;
      const over = pts.filter((p) => p.x > b.left && p.x < b.right && p.y > b.top - RAMP && p.y < b.bottom + RAMP);
      let best = null;
      for (let i = 0; i <= 10; i++) {
        const cx = b.left + (b.right - b.left) * i / 10;
        for (const extra of [1, 1.5, 2]) {
          const half = Math.max(cx - b.left, b.right - cx) + RAMP * extra;
          let depth = 0;
          for (const p of over) {
            const past = under ? b.bottom - p.y : p.y - b.top;  // how far this point must move to clear the edge
            if (past > 0) depth = Math.max(depth, past / (1 - ((p.x - cx) / half) ** 2) ** 2);
          }
          if (!best || depth < best.depth) best = { cx, half, depth };
        }
      }
      const { cx, half, depth } = best;
      return pts.map((p) => {
        const u = (p.x - cx) / half;
        if (Math.abs(u) >= 1 || p.y < b.top - RAMP || p.y > b.bottom + RAMP) return p;
        return { x: p.x, y: p.y + (under ? 1 : -1) * depth * (1 - u * u) ** 2 };
      });
    }, pts);
  }

  // Wherever a stretch of the path would cross one of the boxes, add a waypoint just off the side of the box nearest
  // to the crossing, then look again; a few rounds take it cleanly round the corners too.
  function detour(way, boxes, W, H) {
    const inBox = (p, b) => p.x > b.left && p.x < b.right && p.y > b.top && p.y < b.bottom;
    for (let i = way.length - 1; i > 2; i--) if (boxes.some((b) => inBox(way[i], b))) way.splice(i, 1);
    for (let round = 0; round < 16; round++) {
      let added = false;
      const segs = segments(way);
      for (let i = 0; i < segs.length && !added; i++) {
        const pts = bezierAt(segs[i], 6);
        for (const b of boxes) {
          const hit = pts.filter((p) => inBox(p, b));
          if (!hit.length) continue;
          const c = { x: hit.reduce((t, p) => t + p.x, 0) / hit.length, y: hit.reduce((t, p) => t + p.y, 0) / hit.length };
          const sides = [
            { d: c.y - b.top, p: { x: c.x, y: b.top - 12 } },
            { d: b.bottom - c.y, p: { x: c.x, y: b.bottom + 12 } },
            { d: c.x - b.left, p: { x: b.left - 12, y: c.y } },
            { d: b.right - c.x, p: { x: b.right + 12, y: c.y } },
          ].filter((s) => s.p.x > 8 && s.p.x < W - 8 && s.p.y > 8 && s.p.y < H - 8);  // not off the page
          if (!sides.length) continue;
          const out = sides.reduce((m, s) => (s.d < m.d ? s : m)).p;
          way.splice(i + 1, 0, { ...out, detour: true });
          added = true;
          break;
        }
      }
      if (!added) return;
    }
  }

  function plan() {
    random = rng(seedOf(location.pathname));
    const W = root.clientWidth;
    const H = Math.max(root.scrollHeight, innerHeight);
    const vh = innerHeight;
    const t = tail();
    const way = [{ x: t.x, y: t.y }, ...waypoints(W, H, t)];

    // Anything the page marks data-clear (the crane) gets a margin of empty sky: the path goes round it,
    // and no side lines, spray, doodles or fixed stars are drawn over it. Drifting things may still pass through.
    const keep = [...document.querySelectorAll("[data-clear]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left + scrollX - 28, right: r.right + scrollX + 28, top: r.top + scrollY - 28, bottom: r.bottom + scrollY + 28 };
    });
    const blocked = (p) => keep.some((b) => p.x > b.left && p.x < b.right && p.y > b.top && p.y < b.bottom);
    if (keep.length) detour(way, keep, W, H);

    // The path itself, as a run of pen strokes with short gaps where the pen lifted.
    const ends = [0];  // index in `curve` of each waypoint
    const curve = segments(way).flatMap((seg, i) => {
      const pts = bezierAt(seg, 5).slice(i ? 1 : 0);
      ends.push(ends[ends.length - 1] + pts.length - (i ? 0 : 1));
      return pts;
    });
    const along = lengths(curve);
    const strokes = [];
    for (let i = 0; i < curve.length - 1;) {
      const want = strokes.length ? rand(25, 110) : rand(80, 120);  // the first one leaves the tail unbroken
      let j = i;
      while (j < curve.length - 1 && along[j] - along[i] < want) j++;
      const pts = curve.slice(i, j + 1);
      const st = { s: along.slice(i, j + 1), v: sketch(pts, 2.4, 0.5), w: rand(1.1, 1.8), a: rand(0.75, 1), ...bounds(pts, 8) };
      if (pts.length > 8 && random() < 0.3) {  // gone over twice, as if the first pass came out faint
        const a = Math.floor(pts.length * rand(0.1, 0.3)), b = Math.ceil(pts.length * rand(0.6, 0.9));
        st.again = { from: a, v: sketch(pts.slice(a, b), 2, 0.45) };
      }
      strokes.push(st);
      const gap = rand(4, 11);
      i = j;
      while (i < curve.length - 1 && along[i] - along[j] < gap) i++;
    }

    const dots = [], marks = [];
    const node = (i) => ({ ...way[i], s: along[Math.min(ends[i], along.length - 1)] });

    // Ink dots at the turns, some ringed, some with faint side lines out to stars, like a constellation's inner lines.
    for (let i = 2; i < way.length; i++) {
      if (way[i].loop || way[i].detour) continue;  // those only shape the curve
      const n = node(i);
      dots.push({ x: n.x, y: n.y, r: rand(1.9, 2.7), a: 0.8, s: n.s });
      if (random() < 0.3) marks.push(circle(n, rand(4.5, 6.5), { s: n.s, a: 0.4 }));
      if (random() < 0.45) {
        let p = n;
        for (let hop = random() < 0.4 ? 2 : 1; hop > 0; hop--) {
          const a = rand(0, TAU), d = rand(35, 100);
          const q = { x: clamp(p.x + Math.cos(a) * d, 8, W - 8), y: clamp(p.y + Math.sin(a) * d, 8, H - 8) };
          if (blocked(q) || blocked({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })) break;
          marks.push(mark(lineAt(p, q, 4), { drift: 1, s: n.s, a: 0.2, w: 0.8 }));
          dots.push({ x: q.x, y: q.y, r: rand(1, 1.5), a: 0.45, s: n.s });
          p = q;
        }
      }
    }

    // Motion marks beside the start of the trail, along the line of flight; and spray off a couple of turns.
    const lead = node(1);
    const perp = t.dir + Math.PI / 2;
    for (const side of [-1, 1]) {
      const at = { x: lead.x + Math.cos(perp) * side * 14, y: lead.y + Math.sin(perp) * side * 14 };
      marks.push(...spray(at, t.dir, 8, { s: lead.s, a: 0.3 }));
    }
    const turns = way.map((p, i) => i).filter((i) => i > 3 && !way[i].loop && !way[i].detour);
    for (let k = 0; k < Math.min(2, turns.length); k++) {
      const n = node(pick(turns));
      const a = rand(0, TAU);
      if (blocked({ x: n.x + Math.cos(a) * 22, y: n.y + Math.sin(a) * 22 })) continue;
      marks.push(...spray({ x: n.x + Math.cos(a) * 22, y: n.y + Math.sin(a) * 22 }, a, 10, { s: n.s, a: 0.26 }));
    }

    // The sky: fine stars everywhere (fainter over the text), doodles out in the margins where there's room.
    const page = document.querySelector(".page")?.getBoundingClientRect();
    const colL = page ? page.left + scrollX + 20 : W * 0.25, colR = page ? page.right + scrollX - 20 : W * 0.75;
    const stars = Array.from({ length: Math.min(900, Math.round(W * H / 7000)) }, () => {
      const x = rand(0, W), y = rand(0, H);
      const over = x > colL - 10 && x < colR + 10;
      return {
        x, y,
        r: random() < 0.1 ? rand(1.1, 1.5) : rand(0.5, 0.9),
        a: rand(0.1, 0.42) * (over ? 0.6 : 1),
        tw: random() < 0.2 ? { f: rand(0.6, 1.6), p: rand(0, TAU) } : null,
      };
    }).filter((st) => !blocked(st));
    const margins = [[10, colL - 28], [colR + 28, W - 10]].filter(([a, b]) => b - a > 40);
    const count = Math.round(H / (margins.length ? 150 : 320));
    for (let k = 0; k < count; k++) {
      const y = rand(50, H - 20);
      const x = margins.length ? rand(...pick(margins)) : rand(12, W - 12);
      if (blocked({ x, y })) continue;
      const kind = pick(KINDS);
      marks.push(...doodle(kind, { x, y }, kind === "sparkle" ? rand(4, 9) : rand(3, 6),
        { bg: true, a: rand(0.22, 0.42) * (margins.length ? 1 : 0.7) }));
    }

    // One gold orbit, a big tilted ellipse mostly off the page, so what shows is an arc across the first screen
    // and another further down; shooting stars run along the top one, and a gold sparkle sits just above its crest.
    const o = W < 640
      ? { cx: W * 0.5, cy: vh * 0.95, rx: W * 0.95, ry: vh * 0.6, tilt: -0.1 }
      : { cx: W * 0.55, cy: vh * 1.05, rx: W * 0.78, ry: vh * 0.68, tilt: -0.14 };
    const orbitAt = (a) => {
      const x = Math.cos(a) * o.rx, y = Math.sin(a) * o.ry;
      return { x: o.cx + x * Math.cos(o.tilt) - y * Math.sin(o.tilt), y: o.cy + x * Math.sin(o.tilt) + y * Math.cos(o.tilt) };
    };
    const ring = Array.from({ length: 361 }, (_, i) => orbitAt(i / 360 * TAU));
    marks.push(mark(bendRound(ring, keep), { drift: 2.5, boil: 0.4, bg: true, gold: true, a: 0.3, w: 1 }));
    let crest = null;
    for (let tries = 0; tries < 10 && !crest; tries++) {  // somewhere outside the clear space
      const c = orbitAt(-Math.PI / 2 + rand(-0.5, 0.3));
      if (!blocked(c) && !blocked({ x: c.x, y: c.y - 16 })) crest = c;
    }
    if (crest) marks.push(...doodle("sparkle", { x: crest.x, y: crest.y - 16 }, 6.5, { bg: true, gold: true, a: 0.6 }));

    // The part of the top arc that's on the page, left to right, for the shooting stars.
    const crestward = Array.from({ length: 241 }, (_, i) => Math.PI + i / 240 * Math.PI);
    const arc = [
      crestward.find((a) => orbitAt(a).x > -30) ?? Math.PI,
      crestward.findLast((a) => orbitAt(a).x < W + 30) ?? TAU,
    ];

    // The things that move: lone stars, the odd sparkle, and a few small constellations, spread down the whole page.
    const drifters = [];
    for (let k = Math.round(W * H / 110000); k > 0; k--) {
      drifters.push(drifter(W, H, random() < 0.25
        ? { marks: doodle("sparkle", { x: 0, y: 0 }, rand(3.5, 6), { a: rand(0.35, 0.55) }), spin: rand(-0.15, 0.15) }
        : { stars: [{ x: 0, y: 0, r: rand(1, 1.6), a: rand(0.4, 0.65) }] }));
    }
    for (let k = Math.max(1, Math.round(H / 650)); k > 0; k--) drifters.push(drifter(W, H, constellation()));

    scene = {
      strokes, dots, marks, stars, drifters, orbitAt, arc,
      text: page && { left: page.left + scrollX, right: page.right + scrollX, top: page.top + scrollY, bottom: page.bottom + scrollY },
      total: along[along.length - 1],
    };
    planWidth = W;
  }

  // ---- drawing -----------------------------------------------------------------------------------------------

  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function readInk() {
    const css = getComputedStyle(root);
    ink = css.getPropertyValue("--trail").trim() || "128 128 128";
    gold = css.getPropertyValue("--trail-gold").trim() || ink;
    strength = parseFloat(css.getPropertyValue("--trail-strength")) || 1;
  }

  // Move the drifters on by dt seconds. Near the mouse they're pushed away; the push then fades into the slow drift.
  // Returns whether anything is moving fast enough to need a smooth frame rate.
  function move(dt, seconds) {
    const W = root.clientWidth, H = Math.max(root.scrollHeight, innerHeight);
    const mx = hand.x + scrollX, my = hand.y + scrollY;
    const settle = 1 - Math.exp(-dt / SETTLE);
    let fast = false;
    for (const d of scene.drifters) {
      if (hand.on) {
        const dx = d.x - mx, dy = d.y - my, dist = Math.hypot(dx, dy);
        if (dist < REACH && dist > 0.1) {
          const f = (1 - dist / REACH) ** 2 * SHOVE * dt / (dist * d.mass);
          d.vx += dx * f;
          d.vy += dy * f;
        }
      }
      const h = d.heading + Math.sin(seconds * d.wander + d.phase) * 0.8;
      d.vx += (Math.cos(h) * d.speed - d.vx) * settle;
      d.vy += (Math.sin(h) * d.speed - d.vy) * settle;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.rot += d.spin * dt;
      if (d.x < -60) d.x += W + 120; else if (d.x > W + 60) d.x -= W + 120;  // off one edge, back in at the other
      if (d.y < -60) d.y += H + 120; else if (d.y > H + 60) d.y -= H + 120;
      if (Math.hypot(d.vx, d.vy) > 12) fast = true;
    }
    return fast;
  }

  function line(pts, n = pts.length) {
    n = Math.min(n, pts.length);
    if (n < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  function draw(seconds) {
    const sc = scene;
    const moving = !still.matches;
    const v = moving ? Math.floor(seconds * BOIL) % 3 : 0;
    const top = scrollY, bottom = scrollY + innerHeight;
    const seen = (o) => o.bottom > top && o.top < bottom;
    const colour = (rgb, a) => `rgb(${rgb} / ${Math.min(1, a * strength)})`;
    const fade = (s) => Math.max(0.35, 1 - s / 5000);  // fainter the further it gets from the butterfly

    let front = Infinity, appear = 1;
    if (reveal) {
      const p = Math.min(1, (seconds - reveal.from) / reveal.for);
      front = sc.total * (1 - (1 - p) ** 3);
      appear = p;
      if (p >= 1) reveal = null;
    }

    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.save();
    ctx.translate(-scrollX, -scrollY);
    ctx.lineCap = ctx.lineJoin = "round";

    for (const st of sc.stars) {
      if (st.y < top - 2 || st.y > bottom + 2) continue;
      let a = st.a * appear;
      if (st.tw && moving) a *= 0.55 + 0.45 * Math.sin(seconds * st.tw.f + st.tw.p);
      ctx.fillStyle = colour(ink, a);
      ctx.fillRect(st.x - st.r, st.y - st.r, st.r * 2, st.r * 2);
    }

    for (const m of sc.marks) {
      if (m.s > front || !seen(m)) continue;
      ctx.lineWidth = m.w;
      ctx.strokeStyle = colour(m.gold ? gold : ink, m.a * (m.bg ? appear : fade(m.s)));
      line(m.v[v]);
    }

    for (const st of sc.strokes) {
      if (st.s[0] > front) break;
      if (!seen(st)) continue;
      let n = st.s.length;
      while (n > 0 && st.s[n - 1] > front) n--;
      ctx.lineWidth = st.w;
      ctx.strokeStyle = colour(ink, 0.44 * st.a * fade(st.s[0]));
      line(st.v[v], n);
      if (st.again && n > st.again.from) {
        ctx.lineWidth = 0.7;
        ctx.strokeStyle = colour(ink, 0.2 * fade(st.s[0]));
        line(st.again.v[v], n - st.again.from);
      }
    }

    for (const d of sc.dots) {
      if (d.s > front || d.y < top - 4 || d.y > bottom + 4) continue;
      ctx.fillStyle = colour(ink, d.a * fade(d.s));
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, TAU);
      ctx.fill();
    }

    for (const d of sc.drifters) {
      if (d.y < top - 80 || d.y > bottom + 80) continue;
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.rot);
      for (const m of d.marks) {
        ctx.lineWidth = m.w;
        ctx.strokeStyle = colour(ink, m.a * appear);
        line(m.v[v]);
      }
      for (const st of d.stars) {
        ctx.fillStyle = colour(ink, st.a * appear);
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    if (moving && !shot && seconds >= nextShot) shot = { from: seconds };
    if (shot && !flyShot(seconds)) {
      shot = null;
      nextShot = seconds + SHOTS[0] + Math.random() * (SHOTS[1] - SHOTS[0]);
    }
    ctx.restore();
  }

  // A shooting star along the visible top of the gold orbit, left to right, with a fading tail.
  // It steps at 12 fps whatever rate the rest is drawn at, like the old hand-drawn boil, and it fades out as it nears
  // the text column (the photo included) and back in once it's past. Returns false once it has gone off the far end.
  function flyShot(seconds) {
    seconds = Math.floor(seconds * 12) / 12;
    const sc = scene, [a0, a1] = sc.arc, box = sc.text;
    const clear = (q) => {  // 0 on or right next to the text, up to 1 at 70px away
      if (!box) return 1;
      const dx = Math.max(box.left - q.x, 0, q.x - box.right), dy = Math.max(box.top - q.y, 0, q.y - box.bottom);
      return clamp((Math.hypot(dx, dy) - 10) / 60, 0, 1);
    };
    const a = (u) => a0 + (a1 - a0) * u;
    const s0 = sc.orbitAt(a0), s1 = sc.orbitAt(a1);
    const across = Math.hypot(s1.x - s0.x, s1.y - s0.y);
    const dur = (a1 - a0) / TAU * ORBIT;
    const p = (seconds - shot.from) / dur;
    if (p >= 1) return false;
    const u = p;  // an unhurried glide, at a steady pace
    const glow = Math.min(1, p * dur / 1.5, (1 - p) * dur / 1.5);  // fades in and out over a second and a half
    const head = sc.orbitAt(a(u));
    const back = 110 / across, N = 16;  // a tail about 110px long, in shrinking, fading pieces
    let prev = head;
    for (let i = 1; i <= N; i++) {
      const q = sc.orbitAt(a(Math.max(0, u - back * i / N)));
      const k = 1 - i / N;
      ctx.lineWidth = 0.4 + 1.8 * k;
      ctx.strokeStyle = `rgb(${gold} / ${0.75 * k * k * glow * clear(q)})`;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
      prev = q;
    }
    const shine = glow * clear(head);
    ctx.fillStyle = `rgb(${gold} / ${0.2 * shine})`;
    ctx.beginPath();
    ctx.arc(head.x, head.y, 6, 0, TAU);
    ctx.fill();
    ctx.fillStyle = `rgb(${gold} / ${0.95 * shine})`;
    ctx.beginPath();
    ctx.arc(head.x, head.y, 2.2, 0, TAU);
    ctx.fill();
    return true;
  }

  // ---- running it --------------------------------------------------------------------------------------------

  let last = performance.now(), busy = false;
  function frame(now) {
    const smooth = busy || hand.on;
    if (dirty || reveal || now - last >= 1000 / (smooth ? 30 : FPS)) {
      busy = move(Math.min(0.1, (now - last) / 1000), now / 1000);
      last = now;
      dirty = false;
      draw(now / 1000);
    }
    requestAnimationFrame(frame);
  }

  const redraw = () => { if (still.matches) draw(0); else dirty = true; };

  function start() {
    size();
    readInk();
    plan();
    let first = false;
    try {
      first = !sessionStorage.getItem("flown");
      sessionStorage.setItem("flown", "1");
    } catch {}
    const now = performance.now() / 1000;
    if (first && !still.matches) reveal = { from: now, for: clamp(scene.total / 1500, 1.6, 4) };
    nextShot = now + 3 + Math.random() * 4;  // the first one comes soon, so it gets seen
    if (still.matches) draw(0);
    else requestAnimationFrame(frame);
    addEventListener("scroll", redraw, { passive: true });  // the canvas is fixed to the window, so it follows the page
  }

  // Mouse only: touch has no hover, and a lens that jumps to every tap would just look broken.
  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || still.matches) return;
    hand.x = e.clientX;
    hand.y = e.clientY;
    hand.on = !e.target.closest?.("main, .foot, a, button");  // never while reading or reaching for a link
  }, { passive: true });
  root.addEventListener("mouseleave", () => { hand.on = false; });
  addEventListener("blur", () => { hand.on = false; });

  addEventListener("resize", () => {
    if (!scene) return;
    size();
    if (root.clientWidth !== planWidth) plan();  // phones fire resize on scroll; only replan on a real width change
    redraw();
  });
  new MutationObserver(() => { readInk(); if (scene) redraw(); })
    .observe(root, { attributes: true, attributeFilter: ["data-theme"] });

  if (document.readyState === "complete") start();
  else addEventListener("load", start);
})();
