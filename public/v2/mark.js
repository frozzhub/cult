// CULT's animated mark: the hooded member, alive. brand/hooded/cult-mark-animated.html inlines a copy of this file.
//   - The halo is the round. It draws itself round as the 10 minutes run and is whole when the cult gets paid.
//   - pay(): the whole halo turns USDC blue and empties clockwise as the pot is split; the dot gives, then refills.
//   - The dot under the hood watches the mouse. On touch screens it looks at a tap, then back.
//   - prefers-reduced-motion: the static brand mark. Nothing moves.
// The brand file's soft glow round the dot is left out on purpose: the site has no glows.
window.CultMark = (() => {
  const HOOD = "M256,70 C186,96 148,170 148,252 C148,306 112,372 70,530 L442,530 C400,372 364,306 364,252 C364,170 326,96 256,70 Z";
  const VOID = "M256,140 C212,158 192,212 192,262 C192,318 224,356 256,356 C288,356 320,318 320,262 C320,212 300,158 256,140 Z";
  const BONE = "#e9e4d8", NIGHT = "#0d0e10", BLUE = "#2775CA";
  const CIRC = 2 * Math.PI * 176;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const marks = new Set();
  let ptr = null, release = 0, raf = 0, last = 0, uid = 0;

  addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") { ptr = [e.clientX, e.clientY]; wake(); } }, { passive: true });
  addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    ptr = [e.clientX, e.clientY];
    clearTimeout(release);
    release = setTimeout(() => { ptr = null; wake(); }, 1400);
    wake();
  }, { passive: true });
  document.addEventListener("mouseout", (e) => { if (!e.relatedTarget) { ptr = null; wake(); } });
  addEventListener("scroll", () => ptr && wake(), { passive: true });
  reduce.addEventListener?.("change", () => marks.forEach((m) => m.reset()));

  function wake() { if (!raf && marks.size) raf = requestAnimationFrame(frame); }
  function frame(t) {
    raf = 0;
    const dt = last ? Math.min(64, t - last) : 16;
    last = t;
    let busy = false;
    for (const m of marks) busy = m.step(t, dt) || busy;
    if (busy) raf = requestAnimationFrame(frame); else last = 0;
  }

  // host: an empty element sized by CSS. opts.base: opacity of the unfilled halo.
  function create(host, opts = {}) {
    const id = "cm" + ++uid, base = opts.base ?? 0.22;
    host.innerHTML = `<svg viewBox="0 0 512 512" width="100%" height="100%" aria-hidden="true" focusable="false" style="display:block">
      <defs><clipPath id="${id}f"><rect width="512" height="512"/></clipPath><clipPath id="${id}v"><path d="${VOID}"/></clipPath></defs>
      <g clip-path="url(#${id}f)">
        <circle class="cm-base" cx="256" cy="222" r="176" fill="none" stroke="${BONE}" stroke-width="14"/>
        <circle class="cm-halo" cx="256" cy="222" r="176" fill="none" stroke="${BONE}" stroke-width="14" transform="rotate(-90 256 222)"/>
        <path d="${HOOD}" fill="${BONE}" stroke="${NIGHT}" stroke-width="14" stroke-linejoin="round"/>
        <g fill="none" stroke="${NIGHT}" stroke-width="6" stroke-linecap="round" opacity=".55"><path d="M256,372 V530"/><path d="M196,390 C184,430 172,470 164,530"/><path d="M316,390 C328,430 340,470 348,530"/></g>
        <g class="cm-face"><path d="${VOID}" fill="${NIGHT}"/><g clip-path="url(#${id}v)"><circle class="cm-eye" cx="256" cy="262" r="22" fill="${BLUE}"/></g></g>
      </g></svg>`;
    const svg = host.firstElementChild;
    const [baseRing, halo] = svg.querySelectorAll("circle");
    const face = svg.querySelector(".cm-face"), eye = svg.querySelector(".cm-eye");
    let p = 0, gx = 0, gy = 0, paying = null;

    const dash = (len, off = 0) => { halo.setAttribute("stroke-dasharray", `${len.toFixed(2)} ${CIRC.toFixed(2)}`); halo.setAttribute("stroke-dashoffset", off.toFixed(2)); };
    const look = (x, y) => {
      face.setAttribute("transform", `translate(${(x * 9).toFixed(2)} ${(y * 7).toFixed(2)})`);
      eye.setAttribute("transform", `translate(${(x * 24).toFixed(2)} ${(y * 30).toFixed(2)})`);
    };

    const m = {
      el: svg,
      // 0..1 through the round.
      progress(v) { p = Math.max(0, Math.min(1, v)); if (!paying && !reduce.matches) dash(p * CIRC); },
      // The payout. Resolves when the halo has emptied and the new round's arc is back.
      pay() {
        if (reduce.matches) return Promise.resolve();
        if (paying) return paying.done;
        let res; const done = new Promise((r) => (res = r));
        paying = { t0: performance.now(), p0: p, res, done };
        wake();
        return done;
      },
      reset() {
        paying?.res(); paying = null; gx = gy = 0; look(0, 0);
        eye.setAttribute("r", 22);
        halo.setAttribute("stroke", BONE);
        if (reduce.matches) { baseRing.setAttribute("opacity", 0); halo.removeAttribute("stroke-dasharray"); halo.removeAttribute("stroke-dashoffset"); }
        else { baseRing.setAttribute("opacity", base); dash(p * CIRC); }
      },
      step(t, dt) {
        if (reduce.matches) return false;
        let busy = false;
        // Gaze: ease toward the pointer's direction, further the further away it is.
        let tx = 0, ty = 0;
        if (ptr) {
          const r = svg.getBoundingClientRect();
          if (r.width) {
            const dx = ptr[0] - (r.left + r.width / 2), dy = ptr[1] - (r.top + r.height * (262 / 512)), d = Math.hypot(dx, dy);
            if (d > 1) { const k = Math.min(1, d / (r.width * 1.5 + 120)); tx = (dx / d) * k; ty = (dy / d) * k; }
          }
        }
        const a = 1 - Math.exp(-dt / 120);
        gx += (tx - gx) * a; gy += (ty - gy) * a;
        if (Math.abs(tx - gx) + Math.abs(ty - gy) > 0.002) busy = true; else { gx = tx; gy = ty; }
        look(gx, gy);
        // Payout: close the ring and turn it blue (0-200ms), empty it clockwise (200-1400), grow the new round back (1400-1900).
        if (paying) {
          const e = t - paying.t0;
          if (e < 200) { halo.setAttribute("stroke", BLUE); dash((paying.p0 + (1 - paying.p0) * ease(e / 200)) * CIRC); }
          else if (e < 1400) { const s = ease((e - 200) / 1200) * CIRC; dash(CIRC - s, -s); }
          else { halo.setAttribute("stroke", BONE); dash(p * CIRC * ease((e - 1400) / 500)); }
          eye.setAttribute("r", (e < 200 ? 22 - 10 * ease(e / 200) : e < 500 ? 12 : 12 + 10 * ease((e - 500) / 800)).toFixed(2));
          if (e >= 1900) { const r = paying.res; paying = null; dash(p * CIRC); eye.setAttribute("r", 22); r(); }
          else busy = true;
        }
        return busy;
      },
    };
    marks.add(m);
    m.reset();
    wake();
    return m;
  }
  return { create, reduce, HOOD };
})();
