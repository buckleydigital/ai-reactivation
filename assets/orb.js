// The agent's "core": a particle sphere, orbits and a spectrum ring, drawn on a
// canvas. Ported from Jarvis in ql-mc. Calm while idle, churning violet while
// the AI writes a reply, bright and lively while it is on a call.
//
//   const orb = createOrb(canvas); orb.set('busy'); orb.pulse();
window.createOrb = function createOrb(cv) {
  const STATES = {
    idle:     { c: [95, 216, 255],  e: .16, spin: .10 },
    busy:     { c: [169, 147, 255], e: .66, spin: .58 },
    speaking: { c: [140, 236, 255], e: .55, spin: .24 },
    booked:   { c: [61, 220, 151],  e: .40, spin: .18 },
    err:      { c: [255, 93, 108],  e: .22, spin: .06 },
  };
  const N = 520, BARS = 96;
  const pts = [];
  for (let i = 0; i < N; i++) { // Fibonacci sphere: even, no clumps
    const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.399963;
    pts.push([Math.cos(th) * r, y, Math.sin(th) * r, Math.random()]);
  }
  const spec = new Float32Array(BARS), specT = new Float32Array(BARS);
  const ORBITS = [
    { tilt: 1.15, yaw: .2, r: 1.32, sp: .55, ph: 0 },
    { tilt: .45, yaw: 1.9, r: 1.46, sp: -.38, ph: 2.1 },
    { tilt: 1.75, yaw: 3.4, r: 1.6, sp: .27, ph: 4.2 },
  ];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, raf = 0, timer = 0, t = 0, last = 0, rot = 0, kick = 0, target = 'idle', lastHalo = '';
  let col = STATES.idle.c.slice(), energy = STATES.idle.e, spin = STATES.idle.spin;

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const box = cv.getBoundingClientRect();
    W = Math.max(1, Math.round(box.width * dpr));
    H = Math.max(1, Math.round(box.height * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  }
  new ResizeObserver(size).observe(cv);

  const rgba = (a, k = 1) =>
    `rgba(${Math.min(255, col[0] * k) | 0},${Math.min(255, col[1] * k) | 0},${Math.min(255, col[2] * k) | 0},${a})`;

  function frame(now) {
    const dt = Math.max(0, Math.min(.05, last ? (now - last) / 1000 : .016));
    last = now;
    if (!reduced) t += dt;
    const s = STATES[target] || STATES.idle, k = 1 - Math.pow(.02, dt);
    for (let i = 0; i < 3; i++) col[i] += (s.c[i] - col[i]) * k;
    energy += (s.e - energy) * k;
    spin += (s.spin - spin) * k;
    kick *= Math.pow(.04, dt);
    const en = Math.min(1, energy + kick * .5);
    if (!reduced) rot += spin * dt;

    const c = ctx, cx = W / 2, cy = H / 2, R = Math.min(W, H) * .2;
    c.clearRect(0, 0, W, H);
    c.globalCompositeOperation = 'lighter';

    const halo = rgba((.16 + en * .14).toFixed(2));
    if (halo !== lastHalo) { cv.parentNode.style.setProperty('--glow', halo); lastHalo = halo; }
    let g;

    // Particle sphere, breathing; churning when busy.
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const tl = .38 + Math.sin(t * .23) * .12, ct = Math.cos(tl), st = Math.sin(tl);
    const amp = .04 + en * .16, dot = Math.max(1, Math.min(W, H) / 420);
    c.fillStyle = rgba(1, 1.25);
    for (let i = 0; i < N; i++) {
      const p = pts[i];
      let x = p[0], y = p[1], z = p[2];
      const n = Math.sin(x * 3.1 + t * 1.3) * Math.sin(y * 3.7 + t * .9) * Math.sin(z * 2.9 + t * 1.1);
      const d = 1 + n * amp + Math.sin(t * 2 + p[3] * 6.28) * .012;
      x *= d; y *= d; z *= d;
      const x1 = x * cr - z * sr, z1 = x * sr + z * cr;
      const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct;
      const f = 3 / (3 - z2);
      const depth = (z2 + 1.2) / 2.4;
      c.globalAlpha = .12 + depth * .75;
      const sz = dot * (.6 + depth * 1.5) * f;
      c.fillRect(cx + x1 * R * f - sz / 2, cy + y2 * R * f - sz / 2, sz, sz);
    }
    c.globalAlpha = 1;

    // Nucleus
    const nr = R * (.42 + en * .12 + Math.sin(t * 2.2) * .02);
    g = c.createRadialGradient(cx, cy, 0, cx, cy, nr);
    g.addColorStop(0, `rgba(255,255,255,${.55 + en * .35})`);
    g.addColorStop(.25, rgba(.55 + en * .3, 1.1));
    g.addColorStop(1, rgba(0));
    c.fillStyle = g; c.beginPath(); c.arc(cx, cy, nr, 0, 6.2832); c.fill();

    // Orbits with satellites
    c.lineWidth = Math.max(1, W / 700);
    for (const o of ORBITS) {
      const ca = Math.cos(o.tilt), sa = Math.sin(o.tilt), cyw = Math.cos(o.yaw + rot * .4), syw = Math.sin(o.yaw + rot * .4);
      const P = (a) => {
        const x = Math.cos(a) * o.r, y = 0, z = Math.sin(a) * o.r;
        const y1 = y * ca - z * sa, z1 = y * sa + z * ca;
        const x2 = x * cyw - z1 * syw, z2 = x * syw + z1 * cyw;
        const f = 3 / (3 - z2 * .6);
        return [cx + x2 * R * f, cy + y1 * R * f, z2];
      };
      const far = new Path2D(), near = new Path2D();
      let prev = P(0);
      for (let i = 1; i <= 64; i++) {
        const q = P(i / 64 * 6.2832), path = q[2] > 0 ? near : far;
        path.moveTo(prev[0], prev[1]); path.lineTo(q[0], q[1]);
        prev = q;
      }
      c.strokeStyle = rgba(.06 + en * .05); c.stroke(far);
      c.strokeStyle = rgba(.24 + en * .2); c.stroke(near);
      const sat = P(o.ph + t * o.sp * (1 + en * 1.5));
      g = c.createRadialGradient(sat[0], sat[1], 0, sat[0], sat[1], R * .09);
      g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(.3, rgba(.8)); g.addColorStop(1, rgba(0));
      c.fillStyle = g; c.beginPath(); c.arc(sat[0], sat[1], R * .09, 0, 6.2832); c.fill();
    }

    // Spectrum ring
    const r0 = R * 1.9, maxL = R * (.08 + en * .42);
    for (let i = 0; i < BARS; i++) {
      if (!reduced && Math.random() < .12 + en * .3) specT[i] = Math.random() * (.25 + en * .75) + kick * .6;
      spec[i] += (specT[i] - spec[i]) * Math.min(1, dt * 14);
    }
    c.lineWidth = Math.max(1.5, W / 330); c.lineCap = 'round';
    const buckets = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    for (let i = 0; i < BARS; i++) {
      const v = (spec[i] + spec[(i + 1) % BARS] + spec[(i + BARS - 1) % BARS]) / 3;
      const a = i / BARS * 6.2832 + rot * .25 - 1.5708;
      const l = 2 + v * maxL, ca = Math.cos(a), sa = Math.sin(a);
      const b = buckets[Math.max(0, Math.min(3, (v * 4) | 0))];
      b.moveTo(cx + ca * r0, cy + sa * r0); b.lineTo(cx + ca * (r0 + l), cy + sa * (r0 + l));
    }
    buckets.forEach((b, i) => { c.strokeStyle = rgba(.25 + i * .17); c.stroke(b); });

    // Instrument rings
    c.lineCap = 'butt';
    c.lineWidth = Math.max(1, W / 900);
    c.strokeStyle = rgba(.18);
    c.beginPath(); c.arc(cx, cy, R * 1.82, 0, 6.2832); c.stroke();
    c.lineWidth = Math.max(1.5, W / 420);
    for (let i = 0; i < 6; i++) {
      const a0 = i / 6 * 6.2832 - rot * .6;
      c.strokeStyle = rgba(i % 2 ? .22 : .45);
      c.beginPath(); c.arc(cx, cy, R * 2.32, a0, a0 + 6.2832 / 6 - .16); c.stroke();
    }
    c.lineWidth = Math.max(1, W / 800);
    const sweep = t * .9;
    c.strokeStyle = rgba(.6, 1.15);
    c.beginPath(); c.arc(cx, cy, R * 2.42, sweep, sweep + .5 + en * .9); c.stroke();
    c.globalCompositeOperation = 'source-over';
  }

  function loop(now) {
    // Nothing to draw when the canvas is hidden (e.g. another mobile tab).
    if (!document.hidden && cv.offsetParent !== null) { size(); frame(now); }
    if (reduced) timer = setTimeout(() => loop(performance.now()), 400);
    else raf = requestAnimationFrame(loop);
  }
  loop(performance.now());

  return {
    set(state) { if (state !== target) { target = state; kick = Math.min(1.2, kick + .5); } },
    pulse(n = 1) { kick = Math.min(1.2, kick + .35 * n); },
    stop() { cancelAnimationFrame(raf); clearTimeout(timer); },
  };
};
