// $PAPER price chart: one series (no legend, the title names it), 2px line, faint area, one hairline baseline,
// crosshair + tooltip that snap to the nearest point, keyboard support, and a table for screen readers.
(() => {
  const SUB = "₀₁₂₃₄₅₆₇₈₉";

  // Tiny prices the way crypto sites write them: $0.000420 -> $0.0₃420
  function fmtPrice(p) {
    if (!(p > 0)) return { text: "$0", html: "$0" };
    if (p >= 1) { const s = "$" + p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return { text: s, html: s }; }
    if (p >= 0.001) { const s = "$" + Number(p.toPrecision(3)); return { text: s, html: s }; }
    const z = Math.floor(-Math.log10(p));
    const digits = String(Math.round(p * 10 ** (z + 3))).slice(0, 3);
    return { text: `$0.0${[...String(z)].map((d) => SUB[d]).join("")}${digits}`, html: `$0.0<sub>${z}</sub>${digits}` };
  }

  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  function timeLabel(t, span) {
    const d = new Date(t);
    if (span <= 86_400_000 * 1.5) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function agoLabel(ms) {
    const h = ms / 3_600_000;
    return h <= 36 ? Math.round(h) + "h ago" : Math.round(h / 24) + "d ago";
  }

  // opts: fmt (value -> text), note (point -> extra tooltip text), fromZero (y axis starts at 0),
  //       animate (line draws itself in the first time), pulse (latest point breathes).
  let uid = 0;
  function create(box, table, opts = {}) {
    const fmt = opts.fmt || ((v) => fmtPrice(v).text), id = "cfill" + uid++;
    const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
    let animated = false;
    const svg = box.querySelector("svg"), tip = box.querySelector(".tip");
    const tipV = tip.querySelector("b"), tipT = tip.querySelector("span");
    let pts = [], geo = null, idx = -1;

    function draw() {
      svg.textContent = "";
      const W = box.clientWidth, H = box.clientHeight;
      if (pts.length < 2 || !W) { geo = null; return; }
      const pad = { t: 34, b: 20 }; // top room for the tooltip, bottom for the time labels
      const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
      let lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
      if (hi - lo < hi * 1e-6) { lo *= 0.95; hi *= 1.05; }
      const head = (hi - lo) * 0.08; lo -= head; hi += head;
      if (opts.fromZero) lo = 0;
      const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W;
      const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
      const base = H - pad.b;
      const xy = pts.map(([t, v]) => [x(t), y(v)]);
      const line = xy.map(([a, b], i) => (i ? "L" : "M") + a.toFixed(1) + " " + b.toFixed(1)).join(" ");

      const defs = el("defs"), grad = el("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.append(el("stop", { offset: "0%", "stop-color": "var(--accent)", "stop-opacity": opts.fromZero ? 0.28 : 0.16 }), el("stop", { offset: "100%", "stop-color": "var(--accent)", "stop-opacity": 0 }));
      defs.append(grad);
      svg.append(defs);
      const area = el("path", { class: "area", d: `${line} L${xy.at(-1)[0].toFixed(1)} ${base} L${xy[0][0].toFixed(1)} ${base} Z`, fill: `url(#${id})` });
      svg.append(area);
      svg.append(el("line", { class: "grid", x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5 }));
      const path = el("path", { class: "line", d: line });
      svg.append(path);
      const a = el("text", { class: "axis", x: 0, y: H - 4 }); a.textContent = agoLabel(t1 - t0);
      const b = el("text", { class: "axis", x: W, y: H - 4, "text-anchor": "end" }); b.textContent = "now";
      svg.append(a, b);
      const cross = el("line", { class: "cross", y1: pad.t - 4, y2: base, visibility: "hidden" });
      if (opts.pulse) svg.append(el("circle", { class: "pulse", cx: xy.at(-1)[0], cy: xy.at(-1)[1], r: 4 }));
      const end = el("circle", { class: "dot", cx: xy.at(-1)[0], cy: xy.at(-1)[1], r: 4 });
      const hov = el("circle", { class: "dot", r: 4, visibility: "hidden" });
      svg.append(cross, end, hov);
      geo = { xy, cross, hov, end, W, span: t1 - t0 };
      // First appearance: the line draws itself left to right and the fill rises after it.
      if (opts.animate && !animated && !calm()) {
        animated = true;
        const len = path.getTotalLength();
        path.style.strokeDasharray = len; path.style.strokeDashoffset = len; area.style.opacity = 0; end.style.opacity = 0;
        requestAnimationFrame(() => requestAnimationFrame(() => { path.classList.add("drawn"); area.classList.add("drawn"); end.classList.add("drawn"); path.style.strokeDashoffset = 0; area.style.opacity = ""; end.style.opacity = ""; }));
      }
      if (idx >= 0) show(Math.min(idx, pts.length - 1));
    }

    function show(i) {
      if (!geo) return;
      idx = i;
      const [px, py] = geo.xy[i];
      geo.cross.setAttribute("x1", px); geo.cross.setAttribute("x2", px); geo.cross.setAttribute("visibility", "visible");
      geo.hov.setAttribute("cx", px); geo.hov.setAttribute("cy", py); geo.hov.setAttribute("visibility", "visible");
      tipV.textContent = fmt(pts[i][1]);
      tipT.textContent = timeLabel(pts[i][0], geo.span) + (opts.note ? opts.note(pts[i]) : "");
      tip.hidden = false;
      const w = tip.offsetWidth / 2;
      tip.style.left = Math.min(geo.W - w, Math.max(w, px)) + "px";
    }
    function hide() { idx = -1; tip.hidden = true; if (geo) { geo.cross.setAttribute("visibility", "hidden"); geo.hov.setAttribute("visibility", "hidden"); } }
    function nearest(clientX) {
      const rx = clientX - box.getBoundingClientRect().left;
      let best = 0, d = Infinity;
      geo.xy.forEach(([px], i) => { const dd = Math.abs(px - rx); if (dd < d) { d = dd; best = i; } });
      return best;
    }

    box.addEventListener("pointermove", (e) => { if (geo) show(nearest(e.clientX)); });
    box.addEventListener("pointerdown", (e) => { if (geo) show(nearest(e.clientX)); });
    box.addEventListener("pointerleave", hide);
    box.addEventListener("blur", hide);
    box.addEventListener("keydown", (e) => {
      if (!geo) return;
      const last = pts.length - 1;
      if (e.key === "ArrowLeft") show(Math.max(0, (idx < 0 ? last : idx) - 1));
      else if (e.key === "ArrowRight") show(Math.min(last, (idx < 0 ? last : idx) + 1));
      else if (e.key === "Home") show(0);
      else if (e.key === "End") show(last);
      else if (e.key === "Escape") hide();
      else return;
      e.preventDefault();
    });
    new ResizeObserver(() => draw()).observe(box);

    return {
      set(points) {
        pts = points || [];
        hide();
        draw();
        const tb = table.querySelector("tbody");
        tb.textContent = "";
        const span = pts.length > 1 ? pts.at(-1)[0] - pts[0][0] : 0;
        for (const [t, v] of pts) {
          const tr = document.createElement("tr");
          const a = document.createElement("td"); a.textContent = timeLabel(t, span);
          const b = document.createElement("td"); b.textContent = fmt(v);
          tr.append(a, b); tb.append(tr);
        }
      },
    };
  }

  window.PaperChart = { create, fmtPrice };
})();
