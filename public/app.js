// CULT site. Connecting a wallet only reads its address; trades are built by the Worker and signed by you.
(() => {
  const $ = (id) => document.getElementById(id);
  const short = (w) => (w ? w.slice(0, 4) + "…" + w.slice(-4) : "");
  const usd = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usdRound = (n) => (n >= 10_000 ? "$" + Math.round(n).toLocaleString("en-US") : usd(n));
  const tiny = (n) => (n >= 0.01 ? usd(n) : n > 0 ? "<$0.01" : "$0.00");
  const compact = (n) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 60 ? Math.floor(s) + "s ago" : s < 3600 ? Math.floor(s / 60) + "m ago" : s < 86400 ? Math.floor(s / 3600) + "h ago" : Math.floor(s / 86400) + "d ago";
  };
  const hue = (w) => [...w].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const api = (p, body) => fetch(p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
    .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(j.error || "Something went wrong. Try again."); return j; });

  function toast(text) {
    const el = $("toast");
    el.textContent = text; el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 4200);
  }

  let S = null, W = null; // site state, my wallet info
  const DEMO_Q = /[?&]demo\b/.test(location.search) ? "?demo=1" : "";
  let wallet = null;
  try { wallet = localStorage.getItem("paper:wallet"); } catch {}

  /* ---------- tabs (hash routed) ---------- */
  // #profile is your own profile; #u/<wallet> is anyone's public one.
  let viewing = null;
  function show(tab) {
    const m = /^u\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(tab || "");
    viewing = m ? m[1] : tab === "profile" ? "me" : null;
    if (viewing) tab = "profile";
    else if (!["home", "members", "wall", "drops"].includes(tab)) tab = "home";
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    document.querySelectorAll("section.view").forEach((v) => v.classList.toggle("on", v.id === "view-" + tab));
    if (viewing) renderProfile();
    if (tab === "drops") revealCumulative();
    window.scrollTo(0, 0);
  }
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    history.replaceState(null, "", b.dataset.tab === "home" ? location.pathname + location.search : "#" + b.dataset.tab);
    show(b.dataset.tab);
  });
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));
  // The logo is the way home (there's no Home tab): switch views in place instead of reloading.
  document.querySelector(".logo").addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; // let new-tab clicks through
    e.preventDefault();
    history.replaceState(null, "", location.pathname + location.search);
    show("home");
  });

  /* ---------- the pot rolls up instead of jumping ---------- */
  let potShown = null;
  function setPot(v) {
    const el = $("potN");
    if (potShown === null || matchMedia("(prefers-reduced-motion: reduce)").matches) { potShown = v; el.textContent = usd(v); return; }
    const from = potShown, t0 = performance.now();
    potShown = v;
    if (v - from >= 0.01) { const b = $("potBump"); b.textContent = "+" + usd(v - from); b.classList.remove("show"); void b.offsetWidth; b.classList.add("show"); }
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 600), e = 1 - (1 - k) ** 3;
      el.textContent = usd(from + (v - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------- render ---------- */
  function render() {
    const live = S.live, tax = S.sellTaxBps / 100;
    const every = S.dropMinutes === 60 ? "hour" : S.dropMinutes + " minutes";
    $("howDrop").textContent = `Every ${every}, the pot is swapped to USDC and split by holdings.`;
    $("dropsLead").textContent = `One every ${every}. Every payment is an on-chain transaction you can check.`;
    $("net").hidden = S.cluster !== "devnet" && !S.demo;
    $("net").textContent = S.demo ? "sample data" : "devnet";
    // The USDC icon in the HTML stands in for the word (screen readers still read "USDC"); keep it, swap the text around it.
    const usdcIcon = $("line").querySelector(".usdc")?.outerHTML || "USDC";
    $("line").innerHTML = `Sellers pay a ${tax}% fee, which is accumulated and airdropped every ${S.dropMinutes === 60 ? "hour" : S.dropMinutes + "&nbsp;minutes"} to holders in&nbsp;${usdcIcon}` + (live ? "" : " Opening soon.");
    $("howHold").textContent = `Hold $${S.minHoldUsd} or more to be counted. Stay longer and your devotion earns up to ${Math.max(...S.streaks.map((s) => s.mult))}× the cut.`;
    const met = S.venue === "meteora";
    $("howJoin").textContent = met ? `Join by buying $${S.ticker}. Joining is free: the ${tax}% buy fee is sent back to your wallet within seconds.` : `Join by buying $${S.ticker}. Joining is free: no tax on buys.`;
    $("howLeave").textContent = `Leaving costs ${tax}%: the exit tithe, taken in SOL so it never dumps the chart.`;
    $("rules").innerHTML = [
      ...(met ? [
        `Every trade pays a ${tax}% fee in SOL, on Meteora. Buy anywhere (Axiom, GMGN, Jupiter or here) and the cult sends your whole ${tax}% back to the wallet that got the $${S.ticker}, usually within seconds.`,
        `Selling pays ${tax}% of the sale: the exit tithe. Meteora keeps a fifth of every fee; the rest goes to the cult treasury.`,
      ] : [`Joining (buying) has no tax. Leaving (selling) pays ${tax}% of the SOL you receive: the exit tithe, straight to the payout wallet.`]),
      `Every ${S.dropMinutes} minutes, members holding at least $${S.minHoldUsd} of $${S.ticker} are counted and paid in USDC.`,
      `Your cut is your balance times your devotion boost, out of every member counted.`,
      `Devotion (days without selling): ${S.streaks.map((s) => `${s.days} days ${s.mult}×`).join(", ")}. Any sell resets it to 1×.`,
      met ? `The pool, team wallets and the treasury are never paid. After graduation all liquidity is permanently locked and the ${tax}% fee carries over to the new pool.`
        : `The pool, team wallets and the payout wallet are never paid. Liquidity is locked and the tithe can never change.`,
      met ? `Payouts come only from people leaving, minus Meteora's cut of the buy refunds. If nobody sells, nobody gets paid. This is a game, not an investment.`
        : `Payouts come only from people leaving. If nobody sells, nobody gets paid. This is a game, not an investment.`,
      ...(S.cluster === "devnet" ? ["This is the devnet test launch: trades use devnet SOL and payouts use a test stand-in for USDC."] : []),
    ].map((t) => `<li>${esc(t)}</li>`).join("");

    const canTrade = S.trade || S.demo;
    $("cta").hidden = !canTrade;
    $("dock").hidden = !canTrade;
    $("walletBtn").hidden = !live;
    document.querySelector('#tabs [data-tab="wall"]').hidden = !(live && S.wall.top.length);
    document.querySelector('#tabs [data-tab="drops"]').hidden = !(live && S.drops.length);
    document.querySelector('#tabs [data-tab="members"]').hidden = !(live && S.members?.length);
    $("tabs").style.visibility = live && (S.wall.top.length || S.drops.length || S.members?.length) ? "" : "hidden"; // one tab alone is no menu
    if (!live) return;

    $("pot").hidden = !(S.pending > 0);
    setPot(S.pending);
    $("totals").hidden = !(S.totals.paidUsdc > 0 || S.totals.volumeUsd > 0);
    $("tVol").hidden = !(S.totals.volumeUsd > 0);
    $("volN").textContent = usdRound(S.totals.volumeUsd || 0);
    $("tPaid").hidden = !(S.totals.paidUsdc > 0);
    $("tRefund").hidden = !(S.totals.refundedUsd > 0);
    $("refundN").textContent = usdRound(S.totals.refundedUsd || 0);
    $("tDrops").hidden = !(S.totals.drops > 0);
    renderPrice();
    $("paidN").textContent = usdRound(S.totals.paidUsdc);
    $("tHolders").hidden = !(S.totals.holders > 0);
    $("holdersN").textContent = S.totals.holders.toLocaleString("en-US");
    $("dropsN").textContent = S.totals.drops.toLocaleString("en-US");
    $("dropsL").textContent = S.totals.drops === 1 ? "round paid" : "rounds paid";
    $("calc").hidden = !(S.avgDrop24 > 0 && S.eligibleSupply > 0) || !!W?.eligible;
    tick();
    renderWall();
    renderMembers();
    renderDrops();
    renderCalc();
  }

  // The clock. When it hits zero it shows the payout for a few seconds, then reloads the numbers.
  let celebrating = false;
  function tick() {
    if (!S?.live || celebrating) return;
    const ms = Math.max(0, Date.parse(S.nextDropAt) - Date.now());
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    $("clock").textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    $("hourFill").style.width = (100 - (ms / (S.dropMinutes * 60_000)) * 100).toFixed(2) + "%";
    if (ms === 0) {
      celebrating = true;
      const pot = potShown || 0;
      $("eyebrow").textContent = "Payout";
      $("clock").classList.add("paid");
      $("clock").textContent = pot > 0 ? `Paying ${usd(pot)} to the cult` : "Nobody left this round";
      setTimeout(() => { celebrating = false; $("clock").classList.remove("paid"); $("eyebrow").textContent = "The cult gets paid in"; load(); }, 4000);
    }
  }

  // A member with a linked X shows their X picture and name; everyone else gets initials and a short address.
  const xOf = (w) => S?.profiles?.[w] || null;
  const avatar = (w, size = "") => {
    const x = xOf(w);
    if (x?.pfp) return `<img class="av pfp${size}" src="${esc(x.pfp)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    const h = hue(w);
    return `<div class="av${size}" style="background:hsl(${h} 30% 50% / .14);color:hsl(${h} 45% 72%)">${esc(w.slice(0, 2))}</div>`;
  };
  const nameOf = (w) => { const x = xOf(w); return x ? `<span class="xn">${esc(x.name)}</span>` : esc(short(w)); };
  let wallMode = "top", seen = new Set();
  function renderWall() {
    const list = wallMode === "top" ? S.wall.top : S.wall.latest;
    const first = !seen.size;
    $("wallList").innerHTML = list.map((x, i) => {
      const id = wallMode + x.wallet + x.at;
      const fresh = !first && !seen.has(id);
      seen.add(id);
      const desc = wallMode === "top" ? `left ${x.sells} time${x.sells === 1 ? "" : "s"} · last ${ago(x.at)}` : `sold ${usd(x.soldUsd)} · ${ago(x.at)}`;
      return `<a class="row${fresh ? " fresh" : ""}" data-acct="${esc(x.wallet)}">
        ${wallMode === "top" ? `<div class="rank">${i + 1}</div>` : ""}${avatar(x.wallet)}
        <div class="body"><div class="t">${nameOf(x.wallet)}</div><div class="d">${desc}</div></div>
        <div class="end"><div class="a">${usd(x.paidUsdc)}</div></div></a>`;
    }).join("");
  }
  $("wallSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    wallMode = b.dataset.v;
    $("wallSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    renderWall();
  });

  // The faithful: most USDC received. Your own row is marked.
  function renderMembers() {
    $("memberList").innerHTML = (S.members || []).map((x, i) => {
      const held = x.devotionDays == null ? "has left the cult" : `held ${x.devotionDays}d · ${x.multiplier}×`;
      const you = wallet && x.wallet === wallet;
      return `<a class="row${you ? " you" : ""}" data-acct="${esc(x.wallet)}">
        <div class="rank">${i + 1}</div>${avatar(x.wallet)}
        <div class="body"><div class="t">${nameOf(x.wallet)}${you ? ' <span class="me">you</span>' : ""}</div><div class="d">${held} · paid in ${x.rounds.toLocaleString("en-US")} rounds</div></div>
        <div class="end"><div class="a">${usd(x.receivedUsdc)}</div></div></a>`;
    }).join("");
  }

  // Payouts: running total of USDC paid to members. Counts up and draws in the first time you see it.
  const cumChart = window.PaperChart.create($("cumChart"), $("cumTable"), {
    fmt: (v) => usd(v), fromZero: true, animate: true, pulse: true,
    note: (p) => (p[2] ? ` · +${usd(p[2])} that round` : ""),
  });
  let cum = null, cumShown = false;
  async function loadCumulative() {
    try { cum = await api("/api/payouts/chart" + DEMO_Q); } catch { return; }
    $("paidChart").hidden = !(cum.total > 0);
    if (!(cum.total > 0)) return;
    $("cumSub").textContent = `across ${cum.rounds.toLocaleString("en-US")} rounds · ${usd(cum.total / cum.rounds)} a round on average`;
    $("cumChart").hidden = cum.points.length < 2;
    $("cumChart").setAttribute("aria-label", `${usd(cum.total)} paid to members in ${cum.rounds} rounds. Use arrow keys to read points.`);
    if (document.getElementById("view-drops").classList.contains("on")) revealCumulative();
  }
  // Only animate once the Payouts tab is actually on screen, so people see it happen.
  function revealCumulative() {
    if (!cum || !(cum.total > 0)) return;
    if (cumShown) { $("cumN").textContent = usd(cum.total); cumChart.set(cum.points); return; }
    cumShown = true;
    cumChart.set(cum.points);
    const el = $("cumN"), end = cum.total, t0 = performance.now(), dur = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1400;
    const step = (t) => { const k = dur ? Math.min(1, (t - t0) / dur) : 1; el.textContent = usd(end * (1 - (1 - k) ** 4)); if (k < 1) requestAnimationFrame(step); };
    if (document.hidden || !dur) el.textContent = usd(end); // a background tab pauses animation frames: show the real total
    else requestAnimationFrame(step);
    setTimeout(() => (el.textContent = usd(cum.total)), dur + 300); // and never leave it mid-count
  }

  function renderDrops() {
    loadCumulative();
    $("dropList").innerHTML = S.drops.map((d) => `<a class="row"${d.tx ? ` data-tx="${esc(d.tx)}"` : ""}>
      <div class="body"><div class="t">#${d.n.toLocaleString("en-US")}</div><div class="d">${d.holders.toLocaleString("en-US")} member${d.holders === 1 ? "" : "s"} paid</div></div>
      <div class="end"><div class="a">${usd(d.usdc)}</div><div class="w">${ago(d.at)}</div></div></a>`).join("");
  }

  document.addEventListener("click", (e) => {
    const r = e.target.closest("a.row"); if (!r || !(r.dataset.acct || r.dataset.tx)) return;
    if (S?.demo) { toast("Sample data. On launch this opens the member's profile."); return; }
    if (r.dataset.acct) { location.hash = "u/" + r.dataset.acct; return; }
    const url = "https://solscan.io/tx/" + r.dataset.tx + (S.cluster === "devnet" ? "?cluster=devnet" : "");
    window.open(url, "_blank", "noopener");
  });

  /* ---------- price chart ---------- */
  const chart = window.PaperChart.create($("chart"), $("chartTable"));
  let range = "24h", chartPts = [], chartAt = 0;
  function renderPrice() {
    $("market").hidden = !(S.price > 0);
    if (!(S.price > 0)) return;
    $("priceN").innerHTML = window.PaperChart.fmtPrice(S.price).html;
    if (Date.now() - chartAt > 60_000) loadChart();
  }
  async function loadChart() {
    chartAt = Date.now();
    try {
      const r = await api("/api/chart?range=" + range + (DEMO_Q ? "&demo=1" : ""));
      chartPts = r.points || [];
    } catch { return; }
    $("chart").hidden = chartPts.length < 2; // one trade isn't a line yet; the price above still shows
    chart.set(chartPts);
    const first = chartPts[0]?.[1], last = chartPts.at(-1)?.[1];
    const pct = first > 0 && chartPts.length > 1 ? ((last - first) / first) * 100 : null;
    $("priceChg").textContent = pct == null ? "" : `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(pct >= 10 || pct <= -10 ? 0 : 1)}% ${range === "all" ? "all time" : range}`;
    $("chart").setAttribute("aria-label", `$${S.ticker} price, ${range === "all" ? "all time" : "last " + range}${pct == null ? "" : `, ${pct >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}%`}. Use arrow keys to read points.`);
  }
  $("rangeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || b.dataset.r === range) return;
    range = b.dataset.r;
    $("rangeSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    loadChart();
  });

  /* ---------- earnings calculator (until your own wallet says it) ---------- */
  function renderCalc() {
    const amt = Number($("calcIn").value.replace(/[^\d.]/g, ""));
    const out = $("calcOut");
    if (!amt || !S.eligibleSupply) { out.innerHTML = ""; return; }
    if (amt * S.price < S.minHoldUsd) { out.innerHTML = `<div class="muted">That's about ${tiny(amt * S.price)}. Hold $${S.minHoldUsd} or more to be counted.</div>`; return; }
    const per = S.avgDrop24 * (amt / (S.eligibleSupply + amt));
    out.innerHTML = `<div class="n">~${tiny(per * (60 / S.dropMinutes) * 24)} a day</div>
      <div class="muted" style="font-size:13px">At the last 24 hours of people leaving, before devotion boosts. If nobody leaves, nobody gets paid.</div>`;
  }
  $("calcIn").addEventListener("input", (e) => {
    const d = e.target.value.replace(/[^\d]/g, "");
    e.target.value = d ? Number(d).toLocaleString("en-US") : "";
    renderCalc();
  });

  /* ---------- wallet ---------- */
  const provider = () => window.phantom?.solana || window.solflare || window.backpack?.solana || window.solana || null;
  // Connecting signs you in too: one free signature (not a transaction) proves the wallet is yours.
  let ME = null;
  async function connect() {
    const p = provider();
    if (!p) { toast("Install Phantom, Solflare or Backpack to connect."); return; }
    try {
      const res = await p.connect();
      wallet = (res?.publicKey || p.publicKey).toString();
      try { localStorage.setItem("paper:wallet", wallet); } catch {}
    } catch { toast("Wallet connection was cancelled."); return; }
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
      toast(/reject|cancel/i.test(e.message) ? "Sign-in cancelled. You can still trade; sign in from your profile." : e.message);
      return false;
    }
  }
  async function disconnect() {
    await api("/api/auth/signout", {}).catch(() => {});
    wallet = null; W = null; ME = null;
    try { localStorage.removeItem("paper:wallet"); } catch {}
    try { provider()?.disconnect?.(); } catch {}
    renderMine(); renderHeader(); renderProfile();
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
  }
  $("walletBtn").addEventListener("click", () => (wallet ? (location.hash = "profile") : connect()));
  // Launch isn't built yet: a tap shows the same "Coming soon" as hovering (phones have no hover).
  $("launchBtn").addEventListener("click", (e) => { const b = e.currentTarget; b.classList.add("tipping"); clearTimeout(b._t); b._t = setTimeout(() => b.classList.remove("tipping"), 1600); });

  async function loadMine() {
    if (!wallet || !S?.live) return renderMine();
    try { W = await api("/api/wallet/" + wallet + DEMO_Q); } catch { W = null; }
    renderMine();
    if (S) $("calc").hidden = !(S.avgDrop24 > 0 && S.eligibleSupply > 0) || !!W?.eligible;
  }
  function renderMine() {
    if (!ME?.x) $("walletBtn").textContent = wallet ? short(wallet) : "Connect";
    const show = !!(wallet && W && W.balance > 0);
    $("mine").hidden = !show;
    $("line").hidden = show;
    if (!show) return;
    $("mEst").textContent = W.eligible ? "~" + tiny(W.estNext) : "—";
    $("mBal").textContent = compact(W.balance);
    $("mMult").textContent = W.multiplier + "×";
    $("mGot").textContent = usd(W.receivedUsdc);
    const nx = W.nextStreak;
    $("streakBar").style.width = (nx ? Math.min(100, (W.streakDays / nx.days) * 100) : 100) + "%";
    $("streakT").textContent = `${W.streakDays}d of devotion`;
    $("streakN").textContent = !W.eligible ? `hold $${S.minHoldUsd}+ to be counted` : nx ? `${nx.days - W.streakDays}d to ${nx.mult}×` : "full devotion";
  }

  /* ---------- trading ---------- */
  const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const standardWallets = [];
  const registry = { register: (...ws) => { standardWallets.push(...ws); return () => {}; } };
  window.addEventListener("wallet-standard:register-wallet", (e) => { try { e.detail(registry); } catch {} });
  try { window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: registry })); } catch {}

  async function signTx(b64) {
    const chain = S.cluster === "devnet" ? "solana:devnet" : "solana:mainnet";
    for (const w of standardWallets.filter((w) => w.features?.["solana:signTransaction"])) {
      let account = w.accounts.find((a) => a.address === wallet);
      if (!account && w.features["standard:connect"]) {
        const r = await w.features["standard:connect"].connect().catch(() => null);
        account = (r?.accounts || w.accounts).find((a) => a.address === wallet);
      }
      if (!account) continue;
      const [out] = await w.features["solana:signTransaction"].signTransaction({ account, chain, transaction: fromB64(b64) });
      return toB64(out.signedTransaction);
    }
    throw new Error("Open the wallet you connected (" + short(wallet) + ") and try again.");
  }

  // With clientRpc set (devnet), the page reads the chain and sends trades itself; the Worker only builds them.
  const rpc = async (method, params) => {
    const r = await fetch(S.clientRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json().catch(() => ({}));
    if (j.error || !r.ok) throw new Error(j.error?.message || "The network is busy. Try again.");
    return j.result;
  };
  const u64 = (b, o) => new DataView(b.buffer, b.byteOffset).getBigUint64(o, true);
  async function readPool() {
    if (S.venue === "meteora" && !S.demo) return { meteora: true, feeBps: S.feeBps, decimals: 6 };
    if (S.demo) return { solReserve: 1_200_000_000_000n, tokenReserve: 600_000_000_000_000n, feeBps: S.sellTaxBps || 1000, decimals: 6 };
    if (!S.clientRpc) { const p = await api("/api/pool"); return { solReserve: BigInt(p.solReserve), tokenReserve: BigInt(p.tokenReserve), feeBps: p.feeBps, decimals: p.decimals }; }
    const r = await rpc("getMultipleAccounts", [[S.accounts.pool, S.accounts.vault, S.mint], { encoding: "base64" }]);
    const [p, v, m] = r.value.map((a) => fromB64(a.data[0]));
    return { solReserve: u64(p, 106), tokenReserve: u64(v, 64), feeBps: new DataView(p.buffer).getUint16(104, true), decimals: m[44] };
  }

  let side = "buy", pool = null;
  const units = (n, d) => BigInt(Math.floor(n * 10 ** Math.min(d, 9))) * 10n ** BigInt(Math.max(0, d - 9));
  async function openTrade(s) {
    setSide(s);
    $("tradeDlg").showModal();
    $("amtIn").focus();
    try { pool = await readPool(); } catch { pool = null; toast("Couldn't read the pool. Try again in a moment."); }
    renderQuote();
  }
  document.querySelectorAll("[data-trade]").forEach((b) => b.addEventListener("click", () => openTrade(b.dataset.trade)));
  function setSide(s) {
    side = s;
    $("sideSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === s));
    $("amtL").textContent = s === "buy" ? "You pay" : "You sell";
    $("amtUnit").textContent = s === "buy" ? "SOL" : "$" + S.ticker;
    $("tradeGo").textContent = s === "buy" ? "Buy" : "Sell";
    renderChips();
    $("amtIn").value = "";
    renderQuote();
  }
  // Quick amounts: SOL sizes for buys, a share of your bag for sells.
  function renderChips() {
    const bal = W?.balance > 0 ? W.balance : 0;
    const opts = side === "buy" ? [["0.1 SOL", 0.1], ["0.5 SOL", 0.5], ["1 SOL", 1], ["5 SOL", 5]]
      : bal ? [["25%", bal / 4], ["50%", bal / 2], ["Max", bal]] : [];
    $("chips").innerHTML = opts.map(([l, v]) => `<button type="button" data-v="${v}">${l}</button>`).join("");
  }
  $("chips").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; const v = Number(b.dataset.v); $("amtIn").value = side === "buy" ? String(v) : String(Math.floor(v)); renderQuote(); });
  const impact = (p) => (p < 0.5 ? "" : `<div class="impact${p >= 10 ? " high" : ""}">Price impact ${p.toFixed(p < 10 ? 1 : 0)}%</div>`);
  // Meteora: quotes come from the Worker (the curve isn't a simple x*y pool). Debounced while typing.
  let qTimer, qSeq = 0, mq = null;
  function meteoraQuote(amt) {
    clearTimeout(qTimer); mq = null;
    if (!(amt > 0)) return;
    const seq = ++qSeq;
    qTimer = setTimeout(async () => {
      try {
        const raw = (side === "buy" ? units(amt, 9) : units(amt, 6)).toString();
        const r = await api(`/api/quote?side=${side}&amount=${raw}`);
        if (seq !== qSeq) return;
        mq = { out: Number(r.out) / (side === "buy" ? 1e6 : 1e9), fee: Number(r.fee) / 1e9, impact: r.impactPct || 0 };
      } catch { mq = null; }
      renderQuote(true);
    }, 250);
  }
  function renderQuote(fromQuote) {
    const q = $("quoteOut"), amt = Number($("amtIn").value.replace(/,/g, ""));
    if (pool?.meteora && fromQuote !== true) meteoraQuote(amt);
    $("tradeGo").disabled = !(amt > 0 && pool);
    // Selling costs the exit fee and resets the streak: say so before they do it, every time.
    disarm();
    const warn = $("streakWarn"), tax = (pool?.feeBps ?? S.sellTaxBps) / 100;
    warn.hidden = side !== "sell";
    if (!warn.hidden) {
      const sol = pool && !pool.meteora ? Number(pool.solReserve) / 1e9 : 0, tok = pool && !pool.meteora ? Number(pool.tokenReserve) / 10 ** pool.decimals : 0;
      const fee = pool?.meteora ? (amt > 0 && mq ? mq.fee : 0) : amt > 0 && pool ? ((amt * sol) / (tok + amt)) * (tax / 100) : 0;
      const streak = W?.streakDays > 0 ? ` It also resets your ${W.streakDays} days of devotion${W.multiplier > 1 ? ` and your ${W.multiplier}× boost` : ""}.` : "";
      warn.innerHTML = `<b>Leaving costs ${tax}%.</b> ${fee > 0 ? `${fee.toFixed(4)} SOL of this sale` : "It"} goes to the members who stay. Stay, and you're the one getting paid.${esc(streak)}`;
    }
    if (!(amt > 0) || !pool) { q.innerHTML = ""; return; }
    if (pool.meteora) {
      if (!mq) { q.innerHTML = `<div class="muted">Getting a price…</div>`; return; }
      q.innerHTML = side === "buy"
        ? `<div class="n">~${compact(mq.out)} $${esc(S.ticker)}</div><div class="muted">Joining is free: the <span class="accent mono">${mq.fee.toFixed(4)} SOL</span> fee comes back to you in seconds.</div>${impact(mq.impact)}`
        : `<div class="n">~${mq.out.toFixed(4)} SOL</div><div class="muted"><span class="accent mono">${mq.fee.toFixed(4)} SOL</span> of it goes to the cult.</div>${impact(mq.impact)}`;
      return;
    }
    const sol = Number(pool.solReserve) / 1e9, tok = Number(pool.tokenReserve) / 10 ** pool.decimals;
    if (side === "buy") {
      const imp = (amt / (sol + amt)) * 100;
      q.innerHTML = `<div class="n">~${compact((amt * tok) / (sol + amt))} $${esc(S.ticker)}</div><div class="muted">Joining is free: no tax on buys.</div>${impact(imp)}`;
    } else {
      const gross = (amt * sol) / (tok + amt), fee = (gross * pool.feeBps) / 10_000;
      const imp = (amt / (tok + amt)) * 100;
      q.innerHTML = `<div class="n">~${(gross - fee).toFixed(4)} SOL</div><div class="muted"><span class="accent mono">${fee.toFixed(4)} SOL</span> of it goes to the cult.</div>${impact(imp)}`;
    }
  }
  $("sideSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSide(b.dataset.v); });
  $("amtIn").addEventListener("input", renderQuote);
  $("tradeX").addEventListener("click", () => $("tradeDlg").close());
  $("tradeDlg").addEventListener("click", (e) => { if (e.target === $("tradeDlg")) $("tradeDlg").close(); });

  // Selling takes two presses: the first arms it ("Leave anyway, pay 10%"), the second sells.
  let armed = false;
  function disarm() {
    armed = false;
    $("streakWarn").classList.remove("armed");
    $("tradeGo").classList.add("accent");
    if (side === "sell") $("tradeGo").textContent = "Sell";
  }
  $("tradeGo").addEventListener("click", async () => {
    if (side === "sell" && !armed) {
      armed = true;
      $("streakWarn").classList.add("armed");
      $("tradeGo").classList.remove("accent"); // the bright button is for holding, not for this
      $("tradeGo").textContent = `Leave anyway, pay ${(pool?.feeBps ?? S.sellTaxBps) / 100}%`;
      return;
    }
    if (S.demo) { toast(`Sample data. On launch this trades against the $${S.ticker} pool.`); disarm(); return; }
    if (!wallet) { await connect(); if (!wallet) return; }
    const go = $("tradeGo"), label = go.textContent;
    const amt = Number($("amtIn").value.replace(/,/g, ""));
    const body = { wallet, side, amount: (side === "buy" ? units(amt, 9) : units(amt, pool.decimals)).toString(), slippageBps: 100 };
    go.disabled = true;
    try {
      go.textContent = "Preparing…";
      if (S.clientRpc && !pool?.meteora) {
        const fresh = await readPool();
        body.pool = { solReserve: fresh.solReserve.toString(), tokenReserve: fresh.tokenReserve.toString(), feeBps: fresh.feeBps };
        body.blockhash = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
      }
      const prep = await api("/api/trade", body);
      go.textContent = "Approve in your wallet…";
      const signed = await signTx(prep.transaction);
      go.textContent = "Sending…";
      const sig = S.clientRpc ? await rpc("sendTransaction", [signed, { encoding: "base64", maxRetries: 3 }]) : (await api("/api/send", { signed })).signature;
      go.textContent = "Confirming…";
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        let st = "sent";
        try {
          if (S.clientRpc) { const v = (await rpc("getSignatureStatuses", [[sig]])).value[0]; st = !v ? "sent" : v.err ? "failed" : ["confirmed", "finalized"].includes(v.confirmationStatus) ? "confirmed" : "sent"; }
          else st = (await api("/api/tx/" + sig)).status;
        } catch {}
        if (st === "confirmed") { toast(side === "buy" ? (S.refunds ? "Welcome to the cult. Your buy fee is on its way back." : "Welcome to the cult.") : `You left. Your ${S.sellTaxBps / 100}% just paid the members.`); $("tradeDlg").close(); load(); return; }
        if (st === "failed") throw new Error("Solana refused the trade. Nothing was spent.");
      }
      toast("Not confirmed yet. Check your wallet's activity before trying again.");
    } catch (e) {
      toast(/rejected|cancel/i.test(e.message) ? "Cancelled in your wallet." : e.message);
    } finally { go.disabled = false; go.textContent = label; }
  });

  /* ---------- profiles ---------- */
  let pubCache = {};
  async function renderProfile() {
    const el = $("pcard");
    if (!viewing) return;
    const mine = viewing === "me" || viewing === wallet;
    if (mine && !wallet) {
      el.innerHTML = `<div class="pempty"><h1>Your profile</h1><p class="lead">Connect the wallet you hold $${esc(S?.ticker || "CULT")} in. Link your X and your name and picture show on the boards, and stay in sync with X.</p><button class="btn accent" id="pConnect">Connect wallet</button></div>`;
      $("pConnect").onclick = connect;
      return;
    }
    const target = mine ? wallet : viewing;
    let p = mine && ME?.signedIn ? ME : pubCache[target];
    if (!p) {
      el.innerHTML = `<div class="muted">Loading…</div>`;
      try { p = pubCache[target] = await api("/api/profile/" + target); } catch { el.innerHTML = `<div class="muted">Couldn't load this profile.</div>`; return; }
      if (viewing !== (mine ? "me" : target) && !(mine && viewing === wallet)) return; // moved on while loading
    }
    const x = p.x, sol = "https://solscan.io/account/" + target + (S?.cluster === "devnet" ? "?cluster=devnet" : "");
    const devotion = p.devotionDays == null ? (p.sells ? "left the cult" : "—") : `${p.devotionDays}d · ${p.multiplier}×`;
    const stats = [
      [compact(p.balance || 0), `$${esc(S?.ticker || "CULT")} held`],
      [usd(p.receivedUsdc || 0), "USDC received", "accent"],
      [devotion, "devotion"],
      [p.rank ? "#" + p.rank : "—", "rank among members"],
    ];
    let actions = "";
    if (mine) {
      if (!ME?.signedIn) actions = `<button class="btn accent" id="pSign">Sign in to edit</button><span class="pnote">One free signature proves the wallet is yours.</span>`;
      else if (!ME.holds) actions = `<button class="btn accent" data-trade="buy" id="pJoin">Join to create a profile</button><span class="pnote">Profiles are for members holding $${esc(S?.ticker || "CULT")}.</span>`;
      else if (!ME.xEnabled) actions = `<span class="pnote">Linking X opens soon.</span>`;
      else if (!x) actions = `<a class="btn accent" href="/api/x/connect">Link X</a><span class="pnote">Your X name and picture become your profile, and stay in sync with X.</span>`;
      else actions = `<button class="btn" id="pUnlink">Unlink X</button>`;
      actions += `<button class="btn ghost" id="pOut">Sign out</button>`;
    }
    el.innerHTML = `
      <div class="phead">${x?.pfp ? `<img class="ppfp" src="${esc(x.pfp)}" alt="" referrerpolicy="no-referrer">` : avatar(target, " big")}
        <div class="pid"><h1>${x ? esc(x.name) : esc(short(target))}</h1>
          <div class="psub">${x ? `<a href="https://x.com/${esc(x.handle)}" target="_blank" rel="noopener">@${esc(x.handle)}</a> · <a class="mono" href="${sol}" target="_blank" rel="noopener">${esc(short(target))}</a>` : `<a href="${sol}" target="_blank" rel="noopener">View on Solscan</a>`}${mine ? ' <span class="me">you</span>' : ""}</div></div></div>
      <div class="pstats">${stats.map(([n, l, c]) => `<div><div class="n ${c || ""}">${n}</div><div class="l">${l}</div></div>`).join("")}</div>
      ${actions ? `<div class="pactions">${actions}</div>` : ""}`;
    if ($("pSign")) $("pSign").onclick = async () => { if (await signInWallet()) loadMe(); };
    if ($("pJoin")) $("pJoin").onclick = () => openTrade("buy");
    if ($("pUnlink")) $("pUnlink").onclick = async () => { await api("/api/x/disconnect", {}).catch((e) => toast(e.message)); delete pubCache[wallet]; await loadMe(); toast("X unlinked."); };
    if ($("pOut")) $("pOut").onclick = async () => { await disconnect(); location.hash = ""; };
  }

  // Back from X: say how it went, then tidy the URL.
  const X_RESULT = { connected: "X linked. Your name and picture now show across CULT.", cancelled: "X linking cancelled.", expired: "That X link expired. Try again.", signin: "Sign in with the same wallet, then link X again.", taken: "That X account is already linked to another wallet.", failed: "X didn't respond. Try again." };
  const xr = new URLSearchParams(location.search).get("x");
  if (xr) { toast(X_RESULT[xr] || X_RESULT.failed); history.replaceState(null, "", location.pathname + (DEMO_Q ? "?demo" : "") + location.hash); }

  /* ---------- boot ---------- */
  async function load() {
    try { S = await api("/api/state" + DEMO_Q); } catch { toast("Couldn't load the latest numbers."); return; }
    render();
    loadMine();
  }
  loadMe();
  show(location.hash.slice(1));
  load();
  setInterval(tick, 1000);
  setInterval(load, 20_000);
})();
