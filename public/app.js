// $PAPER site. Connecting a wallet only reads its address; trades are built by the Worker and signed by you.
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
  function show(tab) {
    if (!["home", "wall", "drops"].includes(tab)) tab = "home";
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    document.querySelectorAll("section.view").forEach((v) => v.classList.toggle("on", v.id === "view-" + tab));
    window.scrollTo(0, 0);
  }
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    history.replaceState(null, "", b.dataset.tab === "home" ? location.pathname + location.search : "#" + b.dataset.tab);
    show(b.dataset.tab);
  });
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));

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
    $("line").textContent = `Paper hands pay ${tax}%. Diamond hands split it in USDC every ${S.dropMinutes === 60 ? "hour" : S.dropMinutes + " minutes"}. A ponzi game. No promised returns.` + (live ? "" : " Launching soon.");
    $("howHold").textContent = `Hold $${S.minHoldUsd} or more to get paid. Hold longer for up to ${Math.max(...S.streaks.map((s) => s.mult))}× the cut.`;
    $("rules").innerHTML = [
      `Buys have no tax. Sells pay ${tax}% of the SOL you receive, straight to the payout wallet.`,
      `Every ${S.dropMinutes} minutes, holders with at least $${S.minHoldUsd} of $${S.ticker} are snapshotted and paid in USDC.`,
      `Your cut is your balance times your streak boost, out of everyone eligible.`,
      `Streak boosts for not selling: ${S.streaks.map((s) => `${s.days} days ${s.mult}×`).join(", ")}. Any sell resets it.`,
      `The pool, team wallets and the payout wallet never get airdrops. Liquidity is locked and the tax can never change.`,
      `Airdrops come only from sells. If nobody sells, nobody gets paid. This is a game, not an investment.`,
      ...(S.cluster === "devnet" ? ["This is the devnet test launch: trades use devnet SOL and airdrops run as a dry run."] : []),
    ].map((t) => `<li>${esc(t)}</li>`).join("");

    const canTrade = S.trade || S.demo;
    $("cta").hidden = !canTrade;
    $("dock").hidden = !canTrade;
    $("walletBtn").hidden = !live;
    document.querySelector('#tabs [data-tab="wall"]').hidden = !(live && S.wall.top.length);
    document.querySelector('#tabs [data-tab="drops"]').hidden = !(live && S.drops.length);
    $("tabs").style.visibility = live && (S.wall.top.length || S.drops.length) ? "" : "hidden"; // one tab alone is no menu
    if (!live) return;

    $("pot").hidden = !(S.pending > 0);
    setPot(S.pending);
    $("totals").hidden = !(S.totals.paidUsdc > 0);
    $("paidN").textContent = usdRound(S.totals.paidUsdc);
    $("tHolders").hidden = !(S.totals.holders > 0);
    $("holdersN").textContent = S.totals.holders.toLocaleString("en-US");
    $("dropsN").textContent = S.totals.drops.toLocaleString("en-US");
    $("calc").hidden = !(S.avgDrop24 > 0 && S.eligibleSupply > 0) || !!W?.eligible;
    tick();
    renderTicker();
    renderWall();
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
      $("eyebrow").textContent = "Airdrop";
      $("clock").classList.add("paid");
      $("clock").textContent = pot > 0 ? `Paying ${usd(pot)} to holders` : "Nothing sold this round";
      setTimeout(() => { celebrating = false; $("clock").classList.remove("paid"); $("eyebrow").textContent = "Next airdrop in"; load(); }, 4000);
    }
  }

  function renderTicker() {
    const list = S.wall.latest.slice(0, 12);
    $("ticker").hidden = !list.length;
    if (!list.length) return;
    const item = (x) => `<span><span class="w">${esc(short(x.wallet))}</span> sold · paid holders <b>${usd(x.paidUsdc)}</b> · ${ago(x.at)}</span>`;
    const html = list.map(item).join("");
    $("track").innerHTML = html + html; // doubled for a seamless loop
    $("track").style.animationDuration = Math.max(30, list.length * 7) + "s";
  }

  const avatar = (w) => { const h = hue(w); return `<div class="av" style="background:hsl(${h} 30% 50% / .14);color:hsl(${h} 45% 72%)">${esc(w.slice(0, 2))}</div>`; };
  let wallMode = "top", seen = new Set();
  function renderWall() {
    const list = wallMode === "top" ? S.wall.top : S.wall.latest;
    const first = !seen.size;
    $("wallList").innerHTML = list.map((x, i) => {
      const id = wallMode + x.wallet + x.at;
      const fresh = !first && !seen.has(id);
      seen.add(id);
      const desc = wallMode === "top" ? `${x.sells} sell${x.sells === 1 ? "" : "s"} · last ${ago(x.at)}` : `sold ${usd(x.soldUsd)} · ${ago(x.at)}`;
      return `<a class="row${fresh ? " fresh" : ""}" data-acct="${esc(x.wallet)}">
        ${wallMode === "top" ? `<div class="rank">${i + 1}</div>` : ""}${avatar(x.wallet)}
        <div class="body"><div class="t">${esc(short(x.wallet))}</div><div class="d">${desc}</div></div>
        <div class="end"><div class="a">${usd(x.paidUsdc)}</div></div></a>`;
    }).join("");
  }
  $("wallSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    wallMode = b.dataset.v;
    $("wallSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    renderWall();
  });

  function renderDrops() {
    $("dropList").innerHTML = S.drops.map((d) => `<a class="row"${d.tx ? ` data-tx="${esc(d.tx)}"` : ""}>
      <div class="body"><div class="t">#${d.n.toLocaleString("en-US")}</div><div class="d">${d.holders.toLocaleString("en-US")} holders paid</div></div>
      <div class="end"><div class="a">${usd(d.usdc)}</div><div class="w">${ago(d.at)}</div></div></a>`).join("");
  }

  document.addEventListener("click", (e) => {
    const r = e.target.closest("a.row"); if (!r || !(r.dataset.acct || r.dataset.tx)) return;
    if (S?.demo) { toast("Sample data. On launch this opens Solscan."); return; }
    const url = (r.dataset.acct ? "https://solscan.io/account/" + r.dataset.acct : "https://solscan.io/tx/" + r.dataset.tx) + (S.cluster === "devnet" ? "?cluster=devnet" : "");
    window.open(url, "_blank", "noopener");
  });

  /* ---------- earnings calculator (until your own wallet says it) ---------- */
  function renderCalc() {
    const amt = Number($("calcIn").value.replace(/[^\d.]/g, ""));
    const out = $("calcOut");
    if (!amt || !S.eligibleSupply) { out.innerHTML = ""; return; }
    if (amt * S.price < S.minHoldUsd) { out.innerHTML = `<div class="muted">That's about ${tiny(amt * S.price)}. Hold $${S.minHoldUsd} or more to get paid.</div>`; return; }
    const per = S.avgDrop24 * (amt / (S.eligibleSupply + amt));
    out.innerHTML = `<div class="n">~${tiny(per * (60 / S.dropMinutes) * 24)} a day</div>
      <div class="muted" style="font-size:13px">At the last 24 hours of sells, before streak boosts. If nobody sells, nobody gets paid.</div>`;
  }
  $("calcIn").addEventListener("input", (e) => {
    const d = e.target.value.replace(/[^\d]/g, "");
    e.target.value = d ? Number(d).toLocaleString("en-US") : "";
    renderCalc();
  });

  /* ---------- wallet ---------- */
  const provider = () => window.phantom?.solana || window.solflare || window.backpack?.solana || window.solana || null;
  async function connect() {
    const p = provider();
    if (!p) { toast("Install Phantom, Solflare or Backpack to connect."); return; }
    try {
      const res = await p.connect();
      wallet = (res?.publicKey || p.publicKey).toString();
      try { localStorage.setItem("paper:wallet", wallet); } catch {}
      await loadMine();
    } catch { toast("Wallet connection was cancelled."); }
  }
  function disconnect() {
    wallet = null; W = null;
    try { localStorage.removeItem("paper:wallet"); } catch {}
    try { provider()?.disconnect?.(); } catch {}
    renderMine();
  }
  $("walletBtn").addEventListener("click", () => (wallet ? (confirm("Disconnect " + short(wallet) + "?") && disconnect()) : connect()));

  async function loadMine() {
    if (!wallet || !S?.live) return renderMine();
    try { W = await api("/api/wallet/" + wallet + DEMO_Q); } catch { W = null; }
    renderMine();
    if (S) $("calc").hidden = !(S.avgDrop24 > 0 && S.eligibleSupply > 0) || !!W?.eligible;
  }
  function renderMine() {
    $("walletBtn").textContent = wallet ? short(wallet) : "Connect";
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
    $("streakT").textContent = `${W.streakDays}d without selling`;
    $("streakN").textContent = !W.eligible ? `hold $${S.minHoldUsd}+ to qualify` : nx ? `${nx.days - W.streakDays}d to ${nx.mult}×` : "top boost";
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
    if (S.demo) return { solReserve: 1_200_000_000_000n, tokenReserve: 600_000_000_000_000n, feeBps: 1500, decimals: 6 };
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
  function renderQuote() {
    const q = $("quoteOut"), amt = Number($("amtIn").value.replace(/,/g, ""));
    $("tradeGo").disabled = !(amt > 0 && pool);
    // Selling resets the streak: say what that costs before they do it.
    const warn = $("streakWarn");
    warn.hidden = !(side === "sell" && W?.streakDays > 0);
    if (!warn.hidden) warn.textContent = `Selling resets your ${W.streakDays}-day streak${W.multiplier > 1 ? ` and your ${W.multiplier}× boost` : ""}. You start again at 1×.`;
    if (!(amt > 0) || !pool) { q.innerHTML = ""; return; }
    const sol = Number(pool.solReserve) / 1e9, tok = Number(pool.tokenReserve) / 10 ** pool.decimals;
    if (side === "buy") {
      const imp = (amt / (sol + amt)) * 100;
      q.innerHTML = `<div class="n">~${compact((amt * tok) / (sol + amt))} $${esc(S.ticker)}</div><div class="muted">No tax on buys.</div>${impact(imp)}`;
    } else {
      const gross = (amt * sol) / (tok + amt), fee = (gross * pool.feeBps) / 10_000;
      const imp = (amt / (tok + amt)) * 100;
      q.innerHTML = `<div class="n">~${(gross - fee).toFixed(4)} SOL</div><div class="muted"><span class="mint mono">${fee.toFixed(4)} SOL</span> of it goes to the holders.</div>${impact(imp)}`;
    }
  }
  $("sideSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSide(b.dataset.v); });
  $("amtIn").addEventListener("input", renderQuote);
  $("tradeX").addEventListener("click", () => $("tradeDlg").close());
  $("tradeDlg").addEventListener("click", (e) => { if (e.target === $("tradeDlg")) $("tradeDlg").close(); });

  $("tradeGo").addEventListener("click", async () => {
    if (S.demo) { toast("Sample data. On launch this trades against the $PAPER pool."); return; }
    if (!wallet) { await connect(); if (!wallet) return; }
    const go = $("tradeGo"), label = go.textContent;
    const amt = Number($("amtIn").value.replace(/,/g, ""));
    const body = { wallet, side, amount: (side === "buy" ? units(amt, 9) : units(amt, pool.decimals)).toString(), slippageBps: 100 };
    go.disabled = true;
    try {
      go.textContent = "Preparing…";
      if (S.clientRpc) {
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
        if (st === "confirmed") { toast(side === "buy" ? "Bought. Welcome, diamond hands." : "Sold. Your 15% just went to the holders."); $("tradeDlg").close(); load(); return; }
        if (st === "failed") throw new Error("Solana refused the trade. Nothing was spent.");
      }
      toast("Not confirmed yet. Check your wallet's activity before trying again.");
    } catch (e) {
      toast(/rejected|cancel/i.test(e.message) ? "Cancelled in your wallet." : e.message);
    } finally { go.disabled = false; go.textContent = label; }
  });

  /* ---------- boot ---------- */
  async function load() {
    try { S = await api("/api/state" + DEMO_Q); } catch { toast("Couldn't load the latest numbers."); return; }
    render();
    loadMine();
  }
  show(location.hash.slice(1));
  load();
  setInterval(tick, 1000);
  setInterval(load, 20_000);
})();
