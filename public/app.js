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
    .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw Object.assign(new Error(j.error || "Something went wrong. Try again."), { status: r.status }); return j; });

  function toast(text) {
    if ($("tradeDlg").open) return say(text); // a toast would sit behind the open dialog
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
    const live = S.live, tax = S.sellTaxBps / 100, T = S.ticker;
    const every = S.dropMinutes === 60 ? "hour" : S.dropMinutes + " minutes";
    $("howDrop").textContent = `Every ${every}, the pot is swapped to USDC and split by holdings.`;
    $("dropsLead").textContent = `One every ${every}. Every payment is an on-chain transaction you can check.`;
    $("net").hidden = S.cluster !== "devnet" && !S.demo;
    $("net").textContent = S.demo ? "sample data" : "devnet";
    // The USDC icon in the HTML stands in for the word (screen readers still read "USDC"); keep it, swap the text around it.
    const usdcIcon = $("line").querySelector(".usdc")?.outerHTML || "USDC";
    $("line").innerHTML = `Sellers pay a ${tax}% fee, which is accumulated and airdropped every ${S.dropMinutes === 60 ? "hour" : S.dropMinutes + "&nbsp;minutes"} to holders in&nbsp;${usdcIcon}` + (live ? "" : " Opening soon.");
    $("howHold").textContent = `Hold $${S.minHoldUsd} or more to be counted. Stay longer and your devotion earns up to ${Math.max(...S.streaks.map((s) => s.mult))}× the cut.`;
    $("rules").innerHTML = [
      `Joining (buying) is free, and so is sending $${T} to another wallet. Leaving (selling) pays ${tax}% of the $${T} you sell: the exit tithe.`,
      `$${T} holds back ${tax}% of every transfer. When it lands in a wallet (a buy or a send), the cult sends it straight back within seconds. When it lands in a pool (a sale), it's kept as the tithe.`,
      `Every ${S.dropMinutes} minutes the tithe is sold for USDC, and members holding at least $${S.minHoldUsd} of $${T} are counted and paid.`,
      `Your cut is your balance times your devotion boost, out of every member counted.`,
      `Devotion (days without selling): ${S.streaks.map((s) => `${s.days} days ${s.mult}×`).join(", ")}. Any sell resets it to 1×.`,
      `The pool, team wallets and the payout wallet are never paid. Liquidity is locked and the tithe can never change.`,
      `Payouts come only from people leaving. If nobody sells, nobody gets paid. This is a game, not an investment.`,
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
    $("tDrops").hidden = !(S.totals.drops > 0);
    renderPrice();
    renderCurve();
    $("paidN").textContent = usdRound(S.totals.paidUsdc);
    $("tHolders").hidden = !(S.totals.holders > 0);
    $("holdersN").textContent = S.totals.holders.toLocaleString("en-US");
    $("dropsN").textContent = S.totals.drops.toLocaleString("en-US");
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

  function renderDrops() {
    $("dropList").innerHTML = S.drops.map((d) => `<a class="row"${d.tx ? ` data-tx="${esc(d.tx)}"` : ""}>
      <div class="body"><div class="t">#${d.n.toLocaleString("en-US")}</div><div class="d">${d.holders.toLocaleString("en-US")} members paid</div></div>
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
  // The bonding curve, from the cron's last look (state.pool). Nothing when that's unknown or stale.
  const sol1 = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 1 });
  function renderCurve() {
    const c = S.pool, st = c?.stage;
    $("curve").hidden = !["curve", "graduating", "graduated"].includes(st);
    if ($("curve").hidden) return;
    $("curveBar").hidden = st !== "curve";
    $("curveFill").style.width = Math.min(100, (c.progressBps || 0) / 100) + "%";
    $("curveT").innerHTML = st === "curve"
      ? `<span class="n">${sol1(Math.floor(c.raisedSol * 10) / 10)}</span> of <span class="n">${sol1(c.thresholdSol)}</span> SOL raised on the bonding curve. When it's full, $${esc(S.ticker)} graduates to a Meteora pool.`
      : st === "graduating" ? `The bonding curve is full. $${esc(S.ticker)} is moving to its Meteora pool now.`
      : `$${esc(S.ticker)} has graduated from the bonding curve and trades on its Meteora pool, with the liquidity locked.`;
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
    say("");
    setSide(s);
    $("tradeDlg").showModal();
    $("amtIn").focus();
  }
  document.querySelectorAll("[data-trade]").forEach((b) => b.addEventListener("click", () => openTrade(b.dataset.trade)));
  function setSide(s) {
    side = s;
    $("sideSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === s));
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
  $("chips").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; const v = Number(b.dataset.v); $("amtIn").value = side === "buy" ? String(v) : String(Math.floor(v)); say(""); requote(); });
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
      q.innerHTML = `<div class="n">~${(Number(quote.outAmount) / 1e9).toFixed(4)} SOL</div><div class="muted"><span class="accent mono">${compact(coins(quote.tax.amount))} $${T}</span> of what you sell goes to the cult.</div>${imp}`;
    }
  }
  $("sideSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { say(""); setSide(b.dataset.v); } });
  $("amtIn").addEventListener("input", () => { say(""); requote(); });
  $("tradeX").addEventListener("click", () => $("tradeDlg").close());
  $("tradeDlg").addEventListener("click", (e) => { if (e.target === $("tradeDlg")) $("tradeDlg").close(); });
  $("tradeDlg").addEventListener("close", () => { clearTimeout(qT); qSeq++; }); // no quotes for a closed dialog

  // Trade messages show in the dialog, under its button. With the dialog closed they fall back to a toast.
  let msgN = 0;
  function say(text, note = "") {
    msgN++;
    if (text && !$("tradeDlg").open) { toast(text); return msgN; }
    const m = $("tradeMsg");
    m.textContent = text || "";
    if (note) m.insertAdjacentHTML("beforeend", `<span class="msg-note">${esc(note)}</span>`);
    m.hidden = !text;
    return msgN;
  }

  // Selling takes two presses: the first arms it ("Leave anyway, pay 10%"), the second sells.
  let armed = false;
  const goLabel = () => (side === "buy" ? "Buy" : armed ? `Leave anyway, pay ${S.sellTaxBps / 100}%` : "Sell");
  function disarm() {
    armed = false;
    $("streakWarn").classList.remove("armed");
    $("tradeGo").classList.add("accent");
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
    say("");
    if (side === "sell" && !armed) {
      armed = true;
      $("streakWarn").classList.add("armed");
      $("tradeGo").classList.remove("accent"); // the bright button is for holding, not for this
      $("tradeGo").textContent = goLabel();
      return;
    }
    if (S.demo) { toast(`Sample data. On launch this trades against the $${S.ticker} pool.`); disarm(); return; }
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
    const before = W?.balance || 0, n = say(`Welcome to the cult. You bought ${got}: about ${100 - tax}% is in your wallet and the last ${tax}% is landing now.`, slow);
    for (const end = Date.now() + 30_000; Date.now() < end;) {
      await new Promise((r) => setTimeout(r, 5000));
      if (n === msgN) await loadMine();
      if (n !== msgN) return; // something newer is showing
      if (W?.balance >= before + all * 0.99) return say(`Welcome to the cult. All ${got} is in your wallet.`, slow);
    }
    say(`Welcome to the cult. You bought ${got}. The last ${tax}% is sent back seconds after a buy, so it should be in your wallet now.`, slow);
  }

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
