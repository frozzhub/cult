// CULT v2: the round as a ceremony, on the same API as the main site. No backend changes.
// The wallet, sign-in, trade and profile code is app.js's (public/app.js), copied with its logic unchanged. The
// one difference: messages show inline, in the open dialog or under the header button, instead of in a toast.
(() => {
  const $ = (id) => document.getElementById(id);
  const short = (w) => (w ? w.slice(0, 4) + "…" + w.slice(-4) : "");
  const usd = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usdRound = (n) => (n >= 10_000 ? "$" + Math.round(n).toLocaleString("en-US") : usd(n));
  const tiny = (n) => (n >= 0.01 ? usd(n) : n > 0 ? "<$0.01" : "$0.00");
  const compact = (n) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const int = (n) => Math.round(Number(n || 0)).toLocaleString("en-US");
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + " min ago" : s < 86400 ? Math.floor(s / 3600) + "h ago" : Math.floor(s / 86400) + "d ago";
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const hash = (s) => [...s].reduce((a, c) => Math.imul(a ^ c.charCodeAt(0), 2654435761) >>> 0, 2166136261);
  const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const api = (p, body) => fetch(p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
    .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw Object.assign(new Error(j.error || "Something went wrong. Try again."), { status: r.status }); return j; });
  const still = () => window.CultMark.reduce.matches;

  let S = null, W = null, ME = null; // site state, my wallet's numbers, my sign-in
  const DEMO_Q = /[?&]demo\b/.test(location.search) ? "?demo=1" : "";
  let wallet = null;
  try { wallet = localStorage.getItem("paper:wallet"); } catch {} // shared with the main site, so a connection carries over

  // Messages sit next to what caused them: in the open dialog, else under the header button. A note is a second, quieter line.
  let msgN = 0;
  function say(text, where, note) {
    const id = where || ($("tradeDlg").open ? "tradeMsg" : $("profDlg").open ? "profMsg" : "note");
    $(id).textContent = text || "";
    if (note) $(id).insertAdjacentHTML("beforeend", `<span class="msg-note">${esc(note)}</span>`);
    $(id).hidden = !text;
    return ++msgN;
  }
  document.addEventListener("pointerdown", (e) => { if (!$("note").hidden && !e.target.closest("#walletBtn")) $("note").hidden = true; });

  /* ---------- the marks ---------- */
  const headMark = window.CultMark.create($("headMark"), { base: 0.32 });
  const heroMark = window.CultMark.create($("heroMark"));

  /* ---------- the stage: one dot per member, seated round the hooded member as a second halo ---------- */
  const stage = (() => {
    const box = $("stage"), canvas = $("seats"), fig = $("heroMark"), cap = $("stageCap");
    const ctx = canvas.getContext("2d"), probe = document.createElement("canvas").getContext("2d");
    const HOOD = new Path2D(window.CultMark.HOOD);
    const SEAT = "rgba(233, 228, 216, .5)", RING = "rgba(233, 228, 216, .8)", BLUE = "#2775ca", TITHE = "#e9e4d8", TAU = Math.PI * 2;
    let w = 0, h = 0, dpr = 1, cx = 0, cy = 0, eyeY = 0, haloR = 0, R = 0, band = 16, fb = [0, 0, 0], occl = null, capB = null;
    let seats = [], gap = 12, dot = 3, each = 1, n = 0, nextN = null;
    const out = new Map(); // those who left this round: key -> { key, t0, to, seat }
    let flights = [], wave = null, fade = null, after = null, raf = 0;

    function measure() {
      const b = box.getBoundingClientRect(), f = fig.getBoundingClientRect(), c = cap.getBoundingClientRect();
      w = b.width; h = b.height; dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      const fx = f.left - b.left, fy = f.top - b.top, s = f.width / 512;
      cx = fx + 256 * s; cy = fy + 222 * s; eyeY = fy + 262 * s; haloR = 183 * s;
      fb = [fx + 62 * s, fy + 62 * s, fx + 450 * s];
      occl = new Path2D(); occl.addPath(HOOD, new DOMMatrix([s, 0, 0, s, fx, fy]));
      capB = c.width && cap.textContent ? [c.left - b.left, c.top - b.top, c.right - b.left, c.bottom - b.top + 4] : null;
      // The congregation is a disc round the halo; the band outside it is where those who left stand.
      band = Math.max(12, Math.min(26, w * 0.04));
      R = Math.max(0, Math.min(cx, w - cx, cy) - 6 - band);
    }
    // Behind the figure (or touching it): the hood is drawn over the canvas, so no seat goes there.
    const behind = (x, y, m) => x > fb[0] - m && x < fb[2] + m && y > fb[1] - m &&
      (probe.isPointInPath(occl, x, y) || probe.isPointInPath(occl, x - m, y) || probe.isPointInPath(occl, x + m, y) || probe.isPointInPath(occl, x, y - m));
    // Seats in rings round the halo, inner ring first; a part-filled ring fills from the top down both sides.
    // Rings sit a little further apart than the seats in them, so they read as rows.
    function plan(g, need) {
      const list = [], pad = Math.max(4, g * 0.5), m = g * 0.55 + 4, gr = g * 1.2, ga = g * 0.86;
      for (let ring = 0, r = haloR + gr * 1.25; r <= R && list.length < need; ring++, r += gr) {
        const count = Math.max(6, Math.floor((TAU * r) / ga)), row = [];
        for (let i = 0; i < count; i++) {
          let a = ((i + (ring % 2) * 0.5) / count) * TAU;
          if (a > Math.PI) a -= TAU;
          const x = cx + r * Math.sin(a), y = cy - r * Math.cos(a);
          if (y > h - pad) continue;
          if (capB && x > capB[0] - m && x < capB[2] + m && y > capB[1] - m && y < capB[3] + m) continue;
          if (behind(x, y, m)) continue;
          row.push({ x, y, r, a, gone: false });
        }
        row.sort((p, q) => Math.abs(p.a) - Math.abs(q.a) || p.a - q.a);
        for (const s of row) list.push(s);
      }
      return list;
    }
    function layout() {
      measure();
      seats = []; each = 1;
      if (w && h && n) {
        // Biggest seats that still fit everyone. Past ~5,000 members a dot stands for several, and the caption says so.
        let g = Math.min(34, Math.sqrt((Math.PI * R * R * 0.6) / n) * 1.3), list = [];
        for (; g >= 4.2; g *= 0.95) { list = plan(g, n); if (list.length >= n) break; }
        if (list.length < n) { g = 4.2; list = plan(g, Infinity); each = Math.ceil(n / Math.max(1, list.length)); }
        seats = list.slice(0, Math.ceil(n / each));
        gap = g; dot = Math.min(6, Math.max(1.1, g * 0.3));
      }
      for (const L of out.values()) L.to = null;
      for (const L of out.values()) place(L);
    }
    // Where someone who left stands: just outside the circle, at an angle set by their wallet.
    const ringR = () => Math.max(4, dot + 1.6);
    function spotAt(a) {
      const rLast = seats.length ? seats[seats.length - 1].r : haloR + gap * 2, sx = Math.sin(a), sy = Math.cos(a), pad = 6;
      let r = rLast + Math.max(gap * 1.6, band * 0.65);
      if (sx > 0.01) r = Math.min(r, (w - pad - cx) / sx);
      if (sx < -0.01) r = Math.min(r, (cx - pad) / -sx);
      if (sy > 0.01) r = Math.min(r, (cy - pad) / sy);
      return { x: cx + r * sx, y: cy - r * sy, a };
    }
    function place(L) {
      // Try the wallet's own angle, then step out either side until the ring is clear of the caption and the others.
      const a0 = ((hash(L.key) % 1000) / 999 - 0.5) * 2.5, clear = ringR() * 5;
      let p = null;
      for (let i = 0; i < 60 && !p; i++) {
        const a = a0 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.08;
        if (Math.abs(a) > 1.5) continue;
        const q = spotAt(a);
        if (capB && q.x > capB[0] - 8 && q.x < capB[2] + 8 && q.y > capB[1] - 8 && q.y < capB[3] + 8) continue;
        let near = false;
        for (const o of out.values()) if (o !== L && o.to && Math.hypot(o.to.x - q.x, o.to.y - q.y) < clear) near = true;
        if (!near) p = q;
      }
      L.to = p || spotAt(a0);
      const a = L.to.a;
      // They take a seat from the outer rings with them.
      const rLast = seats.length ? seats[seats.length - 1].r : 0;
      let best = null, bd = Infinity;
      for (const s of seats) if (!s.gone && s.r >= rLast - gap * 1.5) { const d = Math.abs(s.a - a); if (d < bd) { bd = d; best = s; } }
      if (best) best.gone = true;
      L.seat = best;
    }

    function draw(t = performance.now()) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      let busy = false;
      const base = new Path2D();
      for (const s of seats) if (!s.gone) { base.moveTo(s.x + dot, s.y); base.arc(s.x, s.y, dot, 0, TAU); }
      ctx.fillStyle = SEAT;
      ctx.fill(base);
      // The split: USDC blue runs out from the dot under the hood through every seat, inner ring first.
      if (wave) {
        const e = t - wave.t0, r0 = seats.length ? seats[0].r : 0, span = Math.max(1, (seats.length ? seats[seats.length - 1].r : 1) - r0);
        const lv = Array.from({ length: 6 }, () => new Path2D());
        for (const s of seats) {
          if (s.gone) continue;
          const u = e - ((s.r - r0) / span) * 1000;
          const k = u <= 0 ? 0 : u < 140 ? u / 140 : u < 420 ? 1 : u < 1700 ? 1 - ease((u - 420) / 1280) : 0;
          if (k <= 0.03) continue;
          const rr = dot * (1 + 0.5 * k), b = lv[Math.min(5, Math.floor(k * 6))];
          b.moveTo(s.x + rr, s.y); b.arc(s.x, s.y, rr, 0, TAU);
        }
        ctx.fillStyle = BLUE;
        lv.forEach((b, i) => { ctx.globalAlpha = (i + 1) / 6; ctx.fill(b); });
        ctx.globalAlpha = 1;
        if (e < 2750) busy = true; else { const r = wave.res; wave = null; r(); }
      }
      // Those who left this round: the seat walks out and turns into a hollow ring.
      const fk = fade ? Math.max(0, 1 - (t - fade.t0) / 500) : 1;
      for (const L of out.values()) {
        const k = ease((t - L.t0) / 750), from = L.seat || L.to;
        if (k < 1) busy = true;
        const x = from.x + (L.to.x - from.x) * k, y = from.y + (L.to.y - from.y) * k;
        if (k < 1 && L.seat) { ctx.globalAlpha = fk * (1 - k); ctx.fillStyle = SEAT; ctx.beginPath(); ctx.arc(x, y, dot, 0, TAU); ctx.fill(); }
        ctx.globalAlpha = fk * k; ctx.strokeStyle = RING; ctx.lineWidth = 1.25;
        ctx.beginPath(); ctx.arc(x, y, ringR(), 0, TAU); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Their tithe, on its way into the hooded member.
      flights = flights.filter((f) => {
        const k = (t - f.t0) / 900;
        if (k >= 1) { f.done?.(); return false; }
        busy = true;
        if (k < 0) return true;
        const q = k * k;
        ctx.fillStyle = TITHE; ctx.beginPath();
        ctx.arc(f.L.to.x + (cx - f.L.to.x) * q, f.L.to.y + (eyeY - f.L.to.y) * q, Math.max(2, dot * 0.9), 0, TAU); ctx.fill();
        return true;
      });
      if (fade) {
        if (fk > 0) busy = true;
        else { fade = null; out.clear(); seats.forEach((s) => (s.gone = false)); if (nextN != null) { n = nextN; nextN = null; layout(); } const fn = after; after = null; fn?.(); busy = true; }
      }
      return busy;
    }
    function kick() { if (!raf) raf = requestAnimationFrame(loop); }
    function loop(t) { raf = 0; if (draw(t)) kick(); }
    let rs = 0;
    new ResizeObserver(() => { cancelAnimationFrame(rs); rs = requestAnimationFrame(() => { layout(); draw(); }); }).observe(box);

    return {
      get each() { return each; },
      get left() { return out.size; },
      has: (k) => out.has(k),
      members(N) {
        N = Math.max(0, Math.round(N || 0));
        if (wave || fade) { nextN = N; return; }
        if (N === n && seats.length) return;
        box.parentElement.classList.toggle("empty", !N); // no circle yet: a shorter stage, just the figure
        n = N; layout(); draw();
      },
      // Someone left: their seat walks out (after `delay` ms) and their tithe flies into the figure; then onLand().
      leave(key, delay, onLand) {
        if (out.has(key)) return;
        const L = { key, t0: delay == null || still() ? -1e9 : performance.now() + delay };
        place(L);
        out.set(key, L);
        if (L.t0 < 0) { onLand?.(); draw(); return; }
        flights.push({ L, t0: L.t0 + 650, done: onLand });
        kick();
      },
      // The split. Resolves when the blue has run through every seat and faded.
      wave() {
        if (still() || !seats.length) return Promise.resolve();
        return new Promise((res) => { wave = { t0: performance.now() + 140, res }; kick(); });
      },
      // The round is over: the hollow rings go (they're in the Left the cult register now) and the circle re-forms.
      clear(fn) {
        if (still() || !out.size) { out.clear(); seats.forEach((s) => (s.gone = false)); if (nextN != null) { n = nextN; nextN = null; layout(); } draw(); fn?.(); return; }
        fade = { t0: performance.now() }; after = fn; kick();
      },
      redraw() { layout(); draw(); },
    };
  })();

  /* ---------- the round ---------- */
  const per = () => (S?.dropMinutes || 10) * 60_000;
  let nextAt = Math.ceil((Date.now() + 1) / 600_000) * 600_000; // the site's 10-minute grid until /api/state says otherwise
  let closing = null, lastKey = null, sec = -1, ceremony = false;
  const dropKey = (d) => (d ? d.at + "#" + d.n : "");
  const keyOf = (x) => x.wallet + ":" + x.soldUsd; // stable for one sale (sample data re-times its sales on every call)
  const thisRound = () => (S?.wall?.latest || []).filter((x) => Date.parse(x.at) >= nextAt - per());

  // Every quarter second: the clock, the halos, and the round closing.
  function tick() {
    const now = Date.now();
    if (now >= nextAt) closeRound(nextAt);
    const ms = Math.max(0, nextAt - now), s = Math.floor(ms / 1000);
    if (s === sec) return;
    sec = s;
    if (!S || S.live) {
      const txt = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
      $("clock").textContent = txt;
      if (s % 15 === 0) $("clockSr").textContent = `${Math.floor(s / 60)} minutes ${s % 60} seconds until the cult gets paid`;
    }
    // The halo holds whole while the last round is being paid, then follows the new one.
    if (S?.live && !ceremony) { const p = closing ? 1 : 1 - ms / per(); heroMark.progress(p); headMark.progress(p); }
    if (s % 10 === 0 && S && !ceremony) renderLast(); // refresh "4 min ago", but not over the split's count-up
  }

  // The clock hit zero. The split itself lands when the airdrop shows up in /api/state (at once on sample data,
  // within a few minutes live), so poll faster until it does.
  function closeRound(at) {
    // Woken from a background tab rounds later: catch the clock up quietly; load() still plays the latest split.
    if (Date.now() - at > 30_000) { nextAt = Math.ceil((Date.now() + 1) / per()) * per(); if (S) load(); return; }
    nextAt = at + per();
    if (!S?.live) return;
    const pot = potShown || 0;
    closing = pot >= 0.01 ? { at, pot, key: lastKey, until: Date.now() + 6 * 60_000 } : null;
    renderRound();
    if (closing) poll();
  }
  let pollT = 0;
  function poll() {
    clearTimeout(pollT);
    if (!closing) return;
    if (Date.now() > closing.until) { closing = null; renderRound(); return; } // it'll be in the Payouts list when it lands
    load().finally(() => { if (closing) pollT = setTimeout(poll, Date.now() - closing.at < 15_000 ? 1500 : 5000); });
  }

  // The signature moment: the halo turns blue and empties, and the blue runs out through the congregation.
  async function payout(d) {
    closing = null;
    ceremony = true;
    $("rLast").classList.remove("fresh"); void $("rLast").offsetWidth;
    renderLast(d, true);
    $("rLast").classList.add("fresh");
    // The split counts up as the blue runs out (and the pot above has rolled down to the new round's).
    if (!still()) {
      const t0 = performance.now(), el = $("lastN");
      const up = (t) => { const k = Math.min(1, (t - t0) / 1300); el.textContent = usd(d.usdc * (1 - (1 - k) ** 3)); if (k < 1) requestAnimationFrame(up); };
      requestAnimationFrame(up);
    }
    const p = 1 - Math.max(0, nextAt - Date.now()) / per();
    const marks = Promise.all([heroMark.pay(), headMark.pay()]);
    heroMark.progress(p); headMark.progress(p);
    await Promise.all([marks, stage.wave()]);
    ceremony = false;
    stage.clear(() => { stage.members(S.totals.holders); syncLeavers(false); renderCap(); });
    renderRound();
  }

  /* ---------- load + render ---------- */
  async function load() {
    let next;
    try { next = await api("/api/state" + DEMO_Q); } catch { if (!S) say("Couldn't load the latest numbers. Trying again shortly."); return; }
    const first = !S;
    S = next;
    const srv = Date.parse(S.nextDropAt);
    if (srv > nextAt && srv - nextAt <= per() && S.live && !first) closeRound(nextAt); // the server's clock got there first
    nextAt = srv;
    sec = -1;
    const k = dropKey(S.drops?.[0]);
    const paid = !first && S.live && k && lastKey !== null && k !== lastKey;
    lastKey = k;
    render(first);
    if (paid) payout(S.drops[0]);
    loadMine();
  }

  function render(first) {
    const live = S.live, tax = S.sellTaxBps / 100, every = S.dropMinutes === 60 ? "hour" : S.dropMinutes + " minutes", T = S.ticker;
    $("mech").textContent = `Joining is free. Leaving costs ${tax}%, and every ${every} the cult splits it between its members in USDC.`;
    const fill = { tax, keep: 100 - tax, every: every.replace(" ", " "), min: S.minHoldUsd }; // the hero explainer's figures
    document.querySelectorAll("[data-fill]").forEach((e) => (e.textContent = fill[e.dataset.fill]));
    $("net").hidden = S.cluster !== "devnet" && !S.demo;
    $("net").textContent = S.demo ? "sample data" : "devnet";
    $("footNote").textContent = S.demo ? "Sample data: every number on this page is made up until launch." : S.cluster === "devnet" ? "Devnet test launch: devnet SOL and a test stand-in for USDC." : "";
    if (S.xHandle) { $("xLink").href = "https://x.com/" + encodeURIComponent(S.xHandle); $("xHandle").textContent = "@" + S.xHandle; $("xLink").setAttribute("aria-label", `CULT on X, @${S.xHandle}`); }
    const canTrade = S.trade || S.demo;
    $("cta").hidden = $("dock").hidden = !canTrade;
    $("walletBtn").hidden = !live;
    $("actFine").innerHTML = canTrade ? `Joining is free. Leaving costs ${tax}%.` : `Trading opens at launch.${S.xHandle ? ` Launch news is on X, <a href="https://x.com/${esc(S.xHandle)}" target="_blank" rel="noopener">@${esc(S.xHandle)}</a>.` : ""}`;
    $("rulesList").innerHTML = [
      `Joining (buying) is free, and so is sending $${T} to another wallet. Leaving (selling) pays ${tax}% of the $${T} you sell: the exit tithe.`,
      `$${T} holds back ${tax}% of every transfer. When it lands in a wallet (a buy or a send), the cult sends it straight back within seconds. When it lands in a pool (a sale), it's kept as the tithe.`,
      `Every ${S.dropMinutes} minutes the tithe is sold for USDC, and members holding at least $${S.minHoldUsd} of $${T} are counted and paid.`,
      `Your cut is your balance times your devotion boost, out of every member counted.`,
      `Devotion (days without selling): ${S.streaks.map((s) => `${s.days} days ${s.mult}×`).join(", ")}. Any sell resets it to 1×.`,
      `The pool, team wallets and the payout wallet are never paid. Liquidity is locked and the tithe can never change.`,
      `Payouts come only from people leaving. If nobody sells, nobody gets paid. This is a game, not an investment.`,
      ...(S.cluster === "devnet" ? ["This is the devnet test launch: trades use devnet SOL and payouts use a test stand-in for USDC."] : []),
    ].map((t) => `<li>${esc(t)}</li>`).join("");
    $("regs").hidden = !live;
    if (!live) { stage.members(0); renderRound(); renderCap(); return; }
    stage.members(S.totals.holders);
    const fresh = syncLeavers(!first);
    // The pot rolls up when the first new tithe lands in the figure, not before.
    if (!fresh) setPot(S.pending);
    renderRound();
    renderPrice();
    renderRegs();
  }

  // Seats walk out for anyone who left this round; returns true if any were new (and animated).
  function syncLeavers(animate) {
    if (closing || ceremony) return false; // the last round's rings stay until its split
    const fresh = thisRound().filter((x) => !stage.has(keyOf(x))).reverse(); // oldest first
    const pot = S.pending;
    fresh.forEach((x, i) => stage.leave(keyOf(x), animate ? i * 700 : null, i === 0 && animate ? () => { setPot(pot); renderPot(); renderMine(); } : null));
    renderCap();
    return animate && fresh.length > 0 && !still();
  }

  // The four lines under the clock: the pot, the members, the last split, and your cut once connected.
  function renderRound() {
    if (!S) return;
    const clockRow = $("clock");
    if (!S.live) {
      clockRow.classList.add("words");
      clockRow.textContent = "The first round opens at launch.";
      clockRow.removeAttribute("aria-hidden");
      $("clockL").textContent = `Then the cult gets paid every ${S.dropMinutes} minutes.`;
      $("h1").textContent = "The cult gets paid in USDC";
    } else {
      clockRow.classList.remove("words");
      clockRow.setAttribute("aria-hidden", "true");
      $("clockL").textContent = "";
      $("h1").textContent = "The cult gets paid in";
    }
    renderPot(); renderMembers(); renderLast(); renderMine(); renderCurve();
  }
  const line = (row, num, words) => {
    $(row).classList.toggle("only", num == null);
    $(row).querySelector(".n").textContent = num ?? "";
    $(row).querySelector(".w").innerHTML = words;
  };
  function renderPot() {
    const tax = S.sellTaxBps / 100, k = thisRound().length;
    if (!S.live) return line("rPot", null, `The pot fills from the first person who leaves after launch. Every sale pays ${tax}% into it.`);
    if (closing) return line("rPot", usd(potShown), "in the pot. The last round's tithe is being split between the members now.");
    if (!(potShown > 0)) return line("rPot", null, `The pot is empty until someone leaves. Every sale pays ${tax}% into it.`);
    line("rPot", usd(potShown), "in the pot." + (k ? ` ${k >= 25 ? "25 or more" : k} left this round.` : ` Every sale pays ${tax}% into it.`));
  }
  function renderMembers() {
    if (!S.live) return line("rMem", null, `Members are counted at the first split, ${S.dropMinutes} minutes after launch.`);
    const n = S.totals.holders;
    if (!n) return line("rMem", null, `Members holding $${S.minHoldUsd} or more are counted at the end of this round.`);
    line("rMem", int(n), "members in the circle at the last split.");
  }
  function renderLast(d = S?.drops?.[0], fresh = false) {
    if (!S) return;
    if (!S.live) return line("rLast", null, `The first split is ${S.dropMinutes} minutes after launch.`);
    if (!d) return line("rLast", null, "The first split is at the end of this round.");
    const tx = d.tx && !S.demo ? ` <a href="https://solscan.io/tx/${esc(d.tx)}${S.cluster === "devnet" ? "?cluster=devnet" : ""}" target="_blank" rel="noopener">See it on Solscan</a>` : "";
    line("rLast", usd(d.usdc), `split between <b>${int(d.holders)}</b> members ${fresh ? "just now" : ago(d.at)}.${tx}`);
  }
  function renderMine() {
    renderHeader();
    const show = !!(wallet && W && S?.live);
    $("rMine").hidden = !show;
    if (!show) return;
    const nx = W.nextStreak, d = W.streakDays;
    const boost = `at ${W.multiplier}× devotion${nx ? ` (${nx.mult}× in ${nx.days - d} day${nx.days - d === 1 ? "" : "s"})` : ""}`;
    const fresh = got && got.round === nextAt ? `<b>${tiny(got.usdc)}</b> came to you at the last split. ` : "";
    // Your share of the pot as it stands: the pot times your weight from the last count. It grows as people leave.
    const mine = (potShown || 0) * (W.share || 0);
    $("mineN").classList.toggle("blue", W.balance > 0 && W.eligible); // blue is for USDC coming to you, not for what you hold
    if (W.balance > 0 && W.eligible && mine >= 0.01) line("rMine", "~" + usd(mine), `of it is yours so far, ${boost}. ${fresh}<b>${usd(W.receivedUsdc)}</b> paid to you in all.`);
    else if (W.balance > 0 && W.eligible) line("rMine", null, `You're in the circle. Your share fills as people leave, ${boost}. ${fresh}${usd(W.receivedUsdc)} paid to you in all.`);
    else if (W.balance > 0) line("rMine", usd(W.usd), `of $${esc(S.ticker)} in your wallet. Hold $${S.minHoldUsd} or more to be counted in the split.`);
    else line("rMine", null, `${esc(short(wallet))} isn't a member yet. Join and you're counted at the next split.`);
  }
  // The bonding curve, from the cron's last look (state.pool): the SOL in it against what it takes to graduate. Its rule
  // fills as it goes. Nothing when the look is unknown or stale, or before launch.
  const sol1 = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 1 });
  function renderCurve() {
    const c = S.live ? S.pool : null, st = c?.stage, T = esc(S.ticker);
    $("rCurve").hidden = !["curve", "graduating", "graduated"].includes(st);
    if ($("rCurve").hidden) return;
    $("rCurve").style.setProperty("--p", st === "curve" ? Math.min(100, (c.progressBps || 0) / 100) + "%" : "0%");
    if (st === "curve") line("rCurve", sol1(Math.floor(c.raisedSol * 10) / 10), `of <b class="mono">${sol1(c.thresholdSol)}</b> SOL raised on the bonding curve. When it's full, $${T} graduates to a Meteora pool.`);
    else line("rCurve", null, st === "graduating" ? `The bonding curve is full. $${T} is moving to its Meteora pool now.` : `$${T} has graduated from the bonding curve and trades on its Meteora pool, with the liquidity locked.`);
  }
  function renderCap() {
    const c = $("stageCap");
    if (!S) { c.textContent = ""; return; }
    const n = S.live ? S.totals.holders : 0;
    const text = !S.live ? "The circle forms at the first split." : !n ? "The circle forms at the end of this round, when the members are first counted."
      : `${stage.each > 1 ? `Each dot is ${stage.each} of the ${int(n)} members` : `One dot for each of the ${int(n)} members`} paid at the last split.${stage.left ? ` Hollow rings: ${stage.left === 1 ? "the one" : `the ${stage.left}`} who left this round.` : ""}`;
    if (c.textContent !== text) { c.textContent = text; stage.redraw(); }
  }

  // The pot rolls up instead of jumping (app.js's setPot).
  let potShown = null;
  function setPot(v) {
    const el = $("potN");
    if (potShown === null || still()) { potShown = v; if (el.textContent) el.textContent = usd(v); return; }
    const from = potShown, t0 = performance.now();
    potShown = v;
    if (v - from >= 0.01) { const b = $("potBump"); b.textContent = "+" + usd(v - from); b.classList.remove("show"); void b.offsetWidth; b.classList.add("show"); }
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 600), e = 1 - (1 - k) ** 3;
      if (!$("rPot").classList.contains("only")) el.textContent = usd(from + (v - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------- registers ---------- */
  const xOf = (w) => S?.profiles?.[w] || null;
  const who = (w) => {
    const x = xOf(w);
    return x ? `<span class="nm x">${x.pfp ? `<img class="pfp" src="${esc(x.pfp)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}<span>${esc(x.name)}</span></span>` : `<span class="nm"><span>${esc(short(w))}</span></span>`;
  };
  const SHOW = 8, more = { members: false, left: false, payouts: false };
  let leftMode = "latest";
  function moreBtn(key, total) {
    const b = document.querySelector(`[data-more="${key}"]`);
    b.hidden = total <= SHOW;
    b.textContent = more[key] ? "Show fewer" : `Show all ${total}`;
  }
  function renderRegs() {
    const mem = S.members || [];
    $("memberList").innerHTML = mem.slice(0, more.members ? mem.length : SHOW).map((x, i) => {
      const you = wallet && x.wallet === wallet;
      const held = x.devotionDays == null ? "has left the cult" : `held ${x.devotionDays}d · ${x.multiplier}×`;
      return `<li><button type="button" class="row${you ? " you" : ""}" data-acct="${esc(x.wallet)}" data-from="members" data-i="${i}"><span class="rk">${i + 1}</span>
        <span class="who">${who(x.wallet)}<span class="meta">${you ? "you · " : ""}${held} · paid in ${int(x.rounds)} rounds</span></span><span class="amt blue">${usd(x.receivedUsdc)}</span></button></li>`;
    }).join("");
    moreBtn("members", mem.length);

    const top = leftMode === "top", L = (top ? S.wall.top : S.wall.latest) || [];
    $("leftList").innerHTML = L.slice(0, more.left ? L.length : SHOW).map((x, i) => `<li><button type="button" class="row${top ? "" : " plain"}" data-acct="${esc(x.wallet)}" data-from="${leftMode}" data-i="${i}">${top ? `<span class="rk">${i + 1}</span>` : ""}
        <span class="who">${who(x.wallet)}<span class="meta">${top ? `left ${x.sells} time${x.sells === 1 ? "" : "s"} · last ${ago(x.at)}` : `sold ${usdRound(x.soldUsd)} · ${ago(x.at)}`}</span></span><span class="amt">${usd(x.paidUsdc)}</span></button></li>`).join("");
    moreBtn("left", L.length);

    const D = S.drops || [];
    $("payoutsSub").textContent = S.totals.drops > 0 ? `${usdRound(S.totals.paidUsdc)} paid to members over ${int(S.totals.drops)} rounds. Every payment is an on-chain transaction you can check.` : "The first payout lands at the end of this round.";
    $("dropList").innerHTML = D.slice(0, more.payouts ? D.length : SHOW).map((d) => {
      const link = d.tx && !S.demo ? `https://solscan.io/tx/${esc(d.tx)}${S.cluster === "devnet" ? "?cluster=devnet" : ""}` : "";
      const inner = `<span class="who"><span class="nm"><span>Round ${int(d.n)}</span></span><span class="meta">${int(d.holders)} members · ${ago(d.at)}</span></span><span class="amt blue">${usd(d.usdc)}${link ? '<span class="arr" aria-hidden="true">↗</span>' : ""}</span>`;
      return `<li>${link ? `<a class="row plain" href="${link}" target="_blank" rel="noopener">${inner}</a>` : `<div class="row plain">${inner}</div>`}</li>`;
    }).join("");
    moreBtn("payouts", D.length);
  }
  document.querySelectorAll("[data-more]").forEach((b) => b.addEventListener("click", () => { more[b.dataset.more] = !more[b.dataset.more]; renderRegs(); }));
  $("leftSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || b.dataset.v === leftMode) return;
    leftMode = b.dataset.v;
    $("leftSeg").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderRegs();
  });
  document.addEventListener("click", (e) => {
    const r = e.target.closest("button.row[data-acct]"); if (!r) return;
    const src = r.dataset.from, list = src === "members" ? S.members : src === "top" ? S.wall.top : S.wall.latest;
    openProfile(r.dataset.acct, { src, row: list?.[Number(r.dataset.i)] });
  });

  /* ---------- price chart (chart.js, shared with the main site) ---------- */
  const chart = window.PaperChart.create($("chart"), $("chartTable"));
  let range = "24h", chartAt = 0;
  function renderPrice() {
    $("market").hidden = !(S.price > 0);
    if (!(S.price > 0)) return;
    $("priceN").innerHTML = window.PaperChart.fmtPrice(S.price).html;
    if (Date.now() - chartAt > 60_000) loadChart();
  }
  async function loadChart() {
    chartAt = Date.now();
    let pts;
    try { pts = (await api("/api/chart?range=" + range + (DEMO_Q ? "&demo=1" : ""))).points || []; } catch { return; }
    $("chart").hidden = pts.length < 2; // one trade isn't a line yet; the price above still shows
    chart.set(pts);
    const first = pts[0]?.[1], last = pts.at(-1)?.[1];
    const pct = first > 0 && pts.length > 1 ? ((last - first) / first) * 100 : null;
    $("priceChg").textContent = pct == null ? "" : `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(pct >= 10 || pct <= -10 ? 0 : 1)}% ${range === "all" ? "all time" : range}`;
    $("chart").setAttribute("aria-label", `$${S.ticker} price, ${range === "all" ? "all time" : "last " + range}${pct == null ? "" : `, ${pct >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}%`}. Use arrow keys to read points.`);
  }
  $("rangeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || b.dataset.r === range) return;
    range = b.dataset.r;
    $("rangeSeg").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    loadChart();
  });

  /* ---------- wallet (app.js) ---------- */
  const provider = () => window.phantom?.solana || window.solflare || window.backpack?.solana || window.solana || null;
  // Connecting signs you in too: one free signature (not a transaction) proves the wallet is yours.
  async function connect() {
    const p = provider();
    if (!p) { say("Install Phantom, Solflare or Backpack to connect."); return; }
    try {
      const res = await p.connect();
      wallet = (res?.publicKey || p.publicKey).toString();
      try { localStorage.setItem("paper:wallet", wallet); } catch {}
    } catch { say("Wallet connection was cancelled."); return; }
    await signInWallet();
    await Promise.all([loadMine(), loadMe()]);
  }
  async function signInWallet() {
    const p = provider();
    if (!p?.signMessage || !wallet) return false;
    try {
      const { nonce, message } = await api("/api/auth/challenge", { wallet });
      const out = await p.signMessage(new TextEncoder().encode(message), "utf8");
      const sig = out?.signature || out;
      await api("/api/auth/signin", { wallet, nonce, signature: toB64(new Uint8Array(sig)) });
      return true;
    } catch (e) {
      say(/reject|cancel/i.test(e.message) ? "Sign-in cancelled. You can still trade; sign in from your profile." : e.message);
      return false;
    }
  }
  async function disconnect() {
    await api("/api/auth/signout", {}).catch(() => {});
    wallet = null; W = null; ME = null;
    try { localStorage.removeItem("paper:wallet"); } catch {}
    try { provider()?.disconnect?.(); } catch {}
    renderMine(); renderProfile();
    if (S?.live) renderRegs();
  }
  async function loadMe() {
    try { ME = await api("/api/me"); } catch { ME = null; }
    if (ME?.signedIn && ME.wallet !== wallet) ME = { signedIn: false, xEnabled: ME.xEnabled }; // a different wallet is connected now
    renderHeader();
    if (viewing) renderProfile();
  }
  function renderHeader() {
    const b = $("walletBtn"), x = ME?.signedIn ? ME.x : null;
    b.innerHTML = x ? `<img class="hpfp" src="${esc(x.pfp || "")}" alt="" referrerpolicy="no-referrer">${esc(x.name)}` : wallet ? esc(short(wallet)) : "Connect";
    b.classList.toggle("has-pfp", !!x);
    fitHeader();
  }
  // The X handle stays beside its glyph unless that would push Connect onto a second line (narrow phones, sample data).
  function fitHeader() {
    const bar = document.querySelector(".bar"), acts = document.querySelector(".acts"), brand = document.querySelector(".brand");
    bar.classList.remove("tight");
    if (acts.offsetTop > brand.offsetTop + brand.offsetHeight / 2) bar.classList.add("tight");
  }
  addEventListener("resize", fitHeader);
  document.fonts?.ready.then(fitHeader);
  $("walletBtn").addEventListener("click", () => (wallet ? openProfile("me") : connect()));
  // What the last split paid you: the rise in your USDC received, kept for the round it landed in.
  let gotBefore = null, got = null;
  async function loadMine() {
    if (!wallet || !S?.live) return renderMine();
    const was = wallet;
    try { W = await api("/api/wallet/" + wallet + DEMO_Q); } catch { W = null; }
    if (was !== wallet) return; // disconnected or switched while loading
    if (W && gotBefore != null && W.receivedUsdc - gotBefore >= 0.005) got = { usdc: W.receivedUsdc - gotBefore, round: nextAt };
    if (W) gotBefore = W.receivedUsdc;
    renderMine();
  }

  /* ---------- profiles (app.js's, in a dialog; #profile and #u/<wallet> open it) ---------- */
  let viewing = null, viewingRow = null;
  const pubCache = {};
  function openProfile(target, row = null) {
    viewing = target || "me"; viewingRow = row;
    say("", "profMsg");
    if (!$("profDlg").open) $("profDlg").showModal();
    renderProfile();
  }
  $("profX").addEventListener("click", () => $("profDlg").close());
  $("profDlg").addEventListener("click", (e) => { if (e.target === $("profDlg")) $("profDlg").close(); });
  $("profDlg").addEventListener("close", () => {
    viewing = null;
    if (/^#(profile|u\/)/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
  });
  // Figures in mono; a word standing in for a figure ("not yet") stays in the text face.
  const statGrid = (stats) => `<div class="pstats">${stats.map(([n, l, c]) => `<div><div class="n ${/[0-9]/.test(n) ? "" : "word "}${c || ""}">${n}</div><div class="l">${l}</div></div>`).join("")}</div>`;
  async function renderProfile() {
    const el = $("profBody");
    if (!viewing) return;
    const T = esc(S?.ticker || "CULT");
    const mine = viewing === "me" || viewing === wallet;
    if (mine && !wallet) {
      el.innerHTML = `<h2 class="pname">Your profile</h2><p class="lead">Connect the wallet you hold $${T} in. Link your X and your name and picture show on the boards, and stay in sync with X.</p><button class="btn blue" type="button" id="pConnect">Connect wallet</button>`;
      $("pConnect").onclick = connect;
      return;
    }
    const target = mine ? wallet : viewing;
    const sol = "https://solscan.io/account/" + target + (S?.cluster === "devnet" ? "?cluster=devnet" : "");
    if (S?.demo && !mine && viewingRow?.row) { // sample members have no profile to fetch
      const r = viewingRow.row, member = viewingRow.src === "members";
      const stats = member
        ? [[usd(r.receivedUsdc), "USDC received", "blue"], [r.devotionDays == null ? "left the cult" : `${r.devotionDays}d · ${r.multiplier}×`, "devotion"], [compact(r.balance || 0), `$${T} held`], [int(r.rounds), "rounds paid in"]]
        : [[usd(r.paidUsdc), "tithe paid to the members"], [viewingRow.src === "top" ? int(r.sells) : usdRound(r.soldUsd), viewingRow.src === "top" ? "times left" : "sold"]];
      el.innerHTML = `<div class="phead"><div class="pid"><h2 class="pname addr">${esc(short(target))}</h2><div class="psub">Sample member</div></div></div>
        ${statGrid(stats)}
        <p class="pnote">Sample data. At launch this shows the member's X, and their live numbers from the chain.</p>`;
      return;
    }
    let p = mine && ME?.signedIn ? ME : pubCache[target];
    if (!p) {
      el.innerHTML = `<p class="lead">Loading…</p>`;
      try { p = pubCache[target] = await api("/api/profile/" + target); } catch { el.innerHTML = `<p class="lead">Couldn't load this profile.</p>`; return; }
      if (viewing !== (mine ? "me" : target) && !(mine && viewing === wallet)) return; // moved on while loading
    }
    const x = p.x;
    // Your own numbers come from /api/wallet, the same as the cut line on the page, so the two always agree.
    if (mine && W) p = { ...p, balance: W.balance, receivedUsdc: W.receivedUsdc, devotionDays: W.balance > 0 ? W.streakDays : p.devotionDays, multiplier: W.multiplier };
    const devotion = p.devotionDays == null ? (p.sells ? "left the cult" : "not yet") : `${p.devotionDays}d · ${p.multiplier}×`;
    const stats = [
      [p.balance > 0 ? compact(p.balance) : "none", `$${T} held`],
      [p.receivedUsdc > 0 ? usd(p.receivedUsdc) : "nothing yet", "USDC received", p.receivedUsdc > 0 ? "blue" : ""],
      [devotion, "devotion"],
      [p.rank ? "#" + p.rank : "not ranked yet", "rank among members"],
    ];
    let actions = "";
    if (mine) {
      if (!ME?.signedIn) actions = `<button class="btn blue" type="button" id="pSign">Sign in to edit</button><p class="pnote">One free signature proves the wallet is yours.</p>`;
      else if (!ME.holds) actions = `<button class="btn blue" type="button" id="pJoin">Join to create a profile</button><p class="pnote">Profiles are for members holding $${T}.</p>`;
      else if (!ME.xEnabled) actions = `<p class="pnote">Linking X opens soon.</p>`;
      else if (!x) actions = `<a class="btn blue" href="/api/x/connect">Link X</a><p class="pnote">Your X name and picture become your profile, and stay in sync with X.</p>`;
      else actions = `<button class="btn" type="button" id="pUnlink">Unlink X</button>`;
      actions += `<button class="btn ghost" type="button" id="pOut">Sign out</button>`;
    }
    el.innerHTML = `
      <div class="phead">${x?.pfp ? `<img class="ppfp" src="${esc(x.pfp)}" alt="" referrerpolicy="no-referrer">` : ""}
        <div class="pid"><h2 class="pname${x ? "" : " addr"}">${x ? esc(x.name) : esc(short(target))}</h2>
          <div class="psub">${x ? `<a href="https://x.com/${esc(x.handle)}" target="_blank" rel="noopener">@${esc(x.handle)}</a> · <a href="${sol}" target="_blank" rel="noopener">${esc(short(target))}</a>` : `<a href="${sol}" target="_blank" rel="noopener">View on Solscan</a>`}${mine ? " · you" : ""}</div></div></div>
      ${statGrid(stats)}
      ${actions ? `<div class="pactions">${actions}</div>` : ""}`;
    if ($("pSign")) $("pSign").onclick = async () => { if (await signInWallet()) loadMe(); };
    if ($("pJoin")) $("pJoin").onclick = () => { $("profDlg").close(); openTrade("buy"); };
    if ($("pUnlink")) $("pUnlink").onclick = async () => { await api("/api/x/disconnect", {}).catch((e) => say(e.message)); delete pubCache[wallet]; await loadMe(); say("X unlinked."); };
    if ($("pOut")) $("pOut").onclick = async () => { await disconnect(); $("profDlg").close(); };
  }
  function route() {
    const h = location.hash.slice(1), m = /^u\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(h);
    if (m) openProfile(m[1]); else if (h === "profile") openProfile("me");
    else if (h && $(h)?.closest("main")) $(h).scrollIntoView(); // #payouts etc.: the registers only appear after the first load
  }
  addEventListener("hashchange", route);

  /* ---------- trading (app.js) ---------- */
  const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const standardWallets = [];
  const registry = { register: (...ws) => { standardWallets.push(...ws); return () => {}; } };
  window.addEventListener("wallet-standard:register-wallet", (e) => { try { e.detail(registry); } catch {} });
  try { window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: registry })); } catch {}

  // The wallet signs the Worker's transaction and sends it itself: no relay and no RPC of ours. Returns the signature.
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const b58 = (u8) => { let n = 0n, s = ""; for (const b of u8) n = n * 256n + BigInt(b); for (; n > 0n; n /= 58n) s = B58[Number(n % 58n)] + s; for (const b of u8) { if (b) break; s = "1" + s; } return s; };
  async function sendTx(b64) {
    const chain = S.cluster === "devnet" ? "solana:devnet" : "solana:mainnet";
    for (const w of standardWallets.filter((w) => w.features?.["solana:signAndSendTransaction"])) {
      let account = w.accounts.find((a) => a.address === wallet);
      if (!account && w.features["standard:connect"]) {
        const r = await w.features["standard:connect"].connect().catch(() => null);
        account = (r?.accounts || w.accounts).find((a) => a.address === wallet);
      }
      if (!account) continue;
      const [out] = await w.features["solana:signAndSendTransaction"].signAndSendTransaction({ account, chain, transaction: fromB64(b64) });
      return b58(out.signature);
    }
    if (standardWallets.some((w) => w.accounts.some((a) => a.address === wallet))) throw new Error("This wallet can't send a trade from a website. Use Phantom, Solflare or Backpack.");
    throw new Error("Open the wallet you connected (" + short(wallet) + ") and try again.");
  }

  // Prices come from the Worker as the amount changes (GET /api/quote). The page does no price maths of its own.
  let side = "buy", quote = null, qErr = "", qBusy = false, qSeq = 0, qT = 0, mode = null, busy = false;
  const units = (n, d) => BigInt(Math.floor(n * 10 ** Math.min(d, 9))) * 10n ** BigInt(Math.max(0, d - 9));
  const coins = (raw) => Number(raw) / 10 ** (S.decimals ?? 6); // raw coin -> $CULT
  const amtNow = () => Number($("amtIn").value.replace(/,/g, ""));
  function requote() {
    clearTimeout(qT); qSeq++; qErr = ""; mode = null;
    disarm();
    qBusy = amtNow() > 0;
    if (!qBusy) quote = null; // otherwise the last quote stays, dimmed, until the new one lands
    renderQuote();
    if (qBusy) qT = setTimeout(fetchQuote, 350, qSeq);
  }
  async function fetchQuote(seq) {
    const amount = (side === "buy" ? units(amtNow(), 9) : units(amtNow(), S.decimals ?? 6)).toString();
    let q = null, err = "", again = false;
    try { q = await api(`/api/quote?side=${side}&amount=${amount}&slippageBps=100`); }
    catch (e) { err = e.message; again = e.status >= 429 && S.trade; } // busy for a moment, not a bad amount: ask again shortly
    if (seq !== qSeq) return; // the amount changed while this was out
    quote = q; qErr = err; qBusy = false;
    renderQuote();
    if (again) qT = setTimeout(fetchQuote, 5000, seq);
  }
  function openTrade(s) {
    say("", "tradeMsg");
    setSide(s);
    $("tradeDlg").showModal();
    $("amtIn").focus();
  }
  document.querySelectorAll("[data-trade]").forEach((b) => b.addEventListener("click", () => openTrade(b.dataset.trade)));
  function setSide(s) {
    side = s;
    $("sideSeg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === s)));
    $("amtL").textContent = s === "buy" ? "You pay" : "You sell";
    $("amtUnit").textContent = s === "buy" ? "SOL" : "$" + S.ticker;
    renderChips();
    $("amtIn").value = "";
    requote();
  }
  // Quick amounts: SOL sizes for buys, a share of your bag for sells.
  function renderChips() {
    const bal = W?.balance > 0 ? W.balance : 0;
    const opts = side === "buy" ? [["0.1 SOL", 0.1], ["0.5 SOL", 0.5], ["1 SOL", 1], ["5 SOL", 5]]
      : bal ? [["25%", bal / 4], ["50%", bal / 2], ["Max", bal]] : [];
    $("chips").innerHTML = opts.map(([l, v]) => `<button type="button" data-v="${v}">${l}</button>`).join("");
  }
  $("chips").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; const v = Number(b.dataset.v); $("amtIn").value = side === "buy" ? String(v) : String(Math.floor(v)); say("", "tradeMsg"); requote(); });
  const impact = (p) => (p < 0.5 ? "" : `<div class="impact${p >= 10 ? " high" : ""}">Price impact ${p.toFixed(p < 10 ? 1 : 0)}%</div>`);
  function renderQuote() {
    const q = $("quoteOut"), warn = $("streakWarn"), tax = S.sellTaxBps / 100, T = esc(S.ticker);
    $("tradeGo").disabled = busy || qBusy || !quote;
    q.classList.toggle("stale", qBusy);
    warn.classList.toggle("stale", qBusy);
    // Selling costs the tithe and resets the streak: say so before they do it, every time, with this sale's tax.
    warn.hidden = side !== "sell";
    if (!warn.hidden) {
      const cut = quote ? `<span class="mono">${compact(coins(quote.tax.amount))} $${T}</span>${quote.taxUsd > 0 ? ` (about ${tiny(quote.taxUsd)})` : ""} of this sale` : "It";
      const streak = W?.streakDays > 0 ? ` It also resets your ${W.streakDays} days of devotion${W.multiplier > 1 ? ` and your ${W.multiplier}× boost` : ""}.` : "";
      warn.innerHTML = `<b>Leaving costs ${tax}%.</b> ${cut} goes to the members who stay. Stay, and you're the one getting paid.${esc(streak)}`;
    }
    if (qErr) { q.innerHTML = `<div>${esc(qErr)}</div>`; return; }
    if (!quote) { q.innerHTML = ""; return; }
    const imp = impact(quote.priceImpactBps / 100);
    if (quote.side === "buy") {
      // mode is how the built buy gets its hold-back back: "after" (seconds later), "atomic" (in the same transaction),
      // or "none" (an account with a delegate or close authority pays it, like a pool).
      const note = mode === "after" ? `About ${100 - tax}% arrives first. The last ${tax}% lands a few seconds later.`
        : mode === "none" ? `Your $${T} account has a delegate or close authority, so it pays the ${tax}% like a pool does and gets nothing back.`
        : `Joining is free: the ${tax}% the coin holds back comes back to you.`;
      q.innerHTML = `<div class="n">~${compact(coins(mode === "none" ? quote.outAmount : quote.outAfterRefund))} $${T}</div><div class="muted">${note}</div>${imp}`;
    } else {
      q.innerHTML = `<div class="n">~${(Number(quote.outAmount) / 1e9).toFixed(4)} SOL</div><div class="muted"><span class="mono">${compact(coins(quote.tax.amount))} $${T}</span> of what you sell goes to the cult.</div>${imp}`;
    }
  }
  $("sideSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { say("", "tradeMsg"); setSide(b.dataset.v); } });
  $("amtIn").addEventListener("input", () => { say("", "tradeMsg"); requote(); });
  $("tradeX").addEventListener("click", () => $("tradeDlg").close());
  $("tradeDlg").addEventListener("click", (e) => { if (e.target === $("tradeDlg")) $("tradeDlg").close(); });
  $("tradeDlg").addEventListener("close", () => { clearTimeout(qT); qSeq++; }); // no quotes for a closed dialog

  // Selling takes two presses: the first arms it ("Leave anyway, pay 10%"), the second sells.
  let armed = false;
  const goLabel = () => (side === "buy" ? "Buy" : armed ? `Leave anyway, pay ${S.sellTaxBps / 100}%` : "Sell");
  function disarm() {
    armed = false;
    $("streakWarn").classList.remove("armed");
    $("tradeGo").classList.add("blue");
    if (!busy) $("tradeGo").textContent = goLabel();
  }
  // POST /api/trade. What it returns is what the wallet will sign, so the dialog shows those numbers from here on.
  async function build(body) {
    const p = await api("/api/trade", body);
    quote = { ...p, taxUsd: p.taxUsd ?? quote?.taxUsd };
    mode = p.refund;
    renderQuote();
    return p;
  }
  async function settle(sig) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try { const { status } = await api("/api/tx/" + sig); if (status !== "sent") return status; } catch {}
    }
    return "sent";
  }
  $("tradeGo").addEventListener("click", async () => {
    say("", "tradeMsg");
    if (side === "sell" && !armed) {
      armed = true;
      $("streakWarn").classList.add("armed");
      $("tradeGo").classList.remove("blue"); // the bright button is for holding, not for this
      $("tradeGo").textContent = goLabel();
      return;
    }
    if (S.demo) { say(`Sample data. At launch this trades against the $${S.ticker} pool.`, "tradeMsg"); disarm(); return; }
    if (!wallet) { await connect(); if (!wallet) return; }
    const go = $("tradeGo"), s = side, tax = S.sellTaxBps / 100, body = { wallet, side: s, amount: quote.amountIn, slippageBps: 100 };
    busy = true; go.disabled = true;
    try {
      go.textContent = "Preparing…";
      let prep = await build(body), sig;
      go.textContent = "Approve in your wallet…";
      try { sig = await sendTx(prep.transaction); }
      catch (e) {
        // An atomic buy carries the fee key's signature, and a wallet that edits the transaction breaks it: build the plain buy.
        if (prep.refund !== "atomic" || !/signature/i.test(e.message) || !/verif/i.test(e.message)) throw e;
        say(`Your wallet couldn't send the buy with its refund inside. Approve it once more: the last ${tax}% will land seconds after.`);
        prep = await build({ ...body, atomic: false });
        sig = await sendTx(prep.transaction);
      }
      go.textContent = "Confirming…";
      const st = await settle(sig);
      if (st === "failed") throw new Error("Solana refused the trade. Nothing was spent.");
      if (st !== "confirmed") { say("Not confirmed yet. Check your wallet's activity before trying again."); return; }
      $("amtIn").value = "";
      requote();
      if (s === "sell") say(`You left. Your ${tax}% is in the pot for the members who stay.`); else welcome(prep, sig);
      load();
    } catch (e) {
      say(/rejected|cancel/i.test(e.message) ? "Cancelled in your wallet." : e.message);
    } finally { busy = false; renderQuote(); $("tradeGo").textContent = goLabel(); }
  });
  // After a buy. With refund "after", the last part (the coin's hold-back, refunded by the Worker) lands seconds later:
  // say so until the balance shows it or 30 s pass. The balance is the Worker's holder index; the page has no RPC.
  async function welcome(prep, sig) {
    const tax = S.sellTaxBps / 100, all = coins(prep.refund === "none" ? prep.outAmount : prep.outAfterRefund), got = `~${compact(all)} $${S.ticker}`;
    if (prep.refund !== "after") return say(`Welcome to the cult. ${got} is in your wallet.`);
    api("/api/refund/hint", { sig }).catch(() => {}); // a nudge to look now: the Helius webhook usually gets there first
    const slow = `Some wallets are slow to show Token-2022 refunds and may show ${100 - tax}% for a while.`;
    const before = W?.balance || 0, n = say(`Welcome to the cult. You bought ${got}: about ${100 - tax}% is in your wallet and the last ${tax}% is landing now.`, undefined, slow);
    for (const end = Date.now() + 30_000; Date.now() < end;) {
      await new Promise((r) => setTimeout(r, 5000));
      if (n === msgN) await loadMine();
      if (n !== msgN) return; // something newer is showing
      if (W?.balance >= before + all * 0.99) return say(`Welcome to the cult. All ${got} is in your wallet.`, undefined, slow);
    }
    say(`Welcome to the cult. You bought ${got}. The last ${tax}% is sent back seconds after a buy, so it should be in your wallet now.`, undefined, slow);
  }

  /* ---------- boot ---------- */
  loadMe();
  tick();
  load().then(route);
  setInterval(tick, 250);
  setInterval(() => { if (!closing) load(); }, 20_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
})();
