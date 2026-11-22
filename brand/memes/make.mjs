// CULT memes for X: 1200x1200, on brand (Night/Bone/USDC blue, Inter Tight + JetBrains Mono, hooded mark).
//   node brand/memes/make.mjs  -> brand/memes/<name>.html, then rendered to <name>.png with headless Edge.
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const dir = resolve("brand/memes");
mkdirSync(dir, { recursive: true });
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const USDC = `<img class="usdc" src="../../public/usdc.svg" alt="USDC">`;
const SOL = `<svg class="sol" viewBox="0 0 397.7 311.7" aria-label="Solana"><defs><linearGradient id="sg" x1="360.9" y1="351.5" x2="141.2" y2="-69.3" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#00ffa3"/><stop offset="1" stop-color="#dc1fff"/></linearGradient></defs><path fill="url(#sg)" d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7zM64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8zM333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z"/></svg>`;
const MARK = `<img class="mark" src="../hooded/cult-transparent.svg" alt="">`;

const css = `
:root{--bg:#0d0e10;--surface:#15171a;--line:#24272c;--text:#eceae4;--muted:#868b94;--dim:#5d626b;--blue:#2775ca;--ink:#4b8fd8;--red:#e5484d}
*{box-sizing:border-box}html,body{margin:0;width:1200px;height:1200px;background:var(--bg);color:var(--text);font-family:"Inter Tight",sans-serif;overflow:hidden}
.glow{position:absolute;inset:0;background:radial-gradient(600px 520px at 50% 46%,rgba(39,117,202,.10),transparent 70%)}
.wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:90px}
.foot{position:absolute;left:0;right:0;bottom:64px;display:flex;align-items:center;justify-content:center;gap:14px;font:700 26px "Inter Tight";letter-spacing:.14em}
.foot .mark{width:38px;height:38px}.foot span{color:var(--muted);font:500 22px "JetBrains Mono";letter-spacing:0;margin-left:6px}
h1{margin:0;font:700 96px/1.02 "Inter Tight";letter-spacing:-.04em}
h2{margin:0;font:700 64px/1.05 "Inter Tight";letter-spacing:-.035em}
em{font-style:normal;color:var(--blue)}
.mono{font-family:"JetBrains Mono",monospace}
.muted{color:var(--muted)}
.usdc{width:1em;height:1em;vertical-align:-.14em}
.sol{width:1.1em;height:.86em;vertical-align:-.08em}
`;
const page = (name, body) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=block" rel="stylesheet"><style>${css}${body.css || ""}</style></head><body><div class="glow"></div>${body.html}<div class="foot">${MARK}CULT<span>cults.bid</span></div></body></html>`;
  writeFileSync(`${dir}/${name}.html`, html);
  return name;
};

const memes = [
  // 1. The two charts
  page("1-two-charts", {
    css: `.cols{display:grid;grid-template-columns:1fr 1fr;width:1000px;border:1px solid var(--line);border-radius:28px;overflow:hidden;background:var(--surface)}
.cols>div{padding:56px 48px;text-align:left}.cols>div+div{border-left:1px solid var(--line)}
.lbl{font:500 24px "JetBrains Mono";color:var(--muted);letter-spacing:.02em}.big{margin-top:26px;font:700 78px/1 "JetBrains Mono";letter-spacing:-.03em}
.red{color:var(--red)}.blue{color:var(--blue)}svg.ch{display:block;margin-top:40px;width:100%;height:190px}.cap{margin-top:30px;font:500 26px "Inter Tight";color:var(--muted)}`,
    html: `<div class="wrap" style="padding-bottom:150px"><h2 style="margin-bottom:56px">Two charts. Pick one.</h2><div class="cols">
<div><div class="lbl">YOUR BAGS</div><div class="big red">−63%</div><svg class="ch" viewBox="0 0 400 190" preserveAspectRatio="none"><path d="M0 20 L40 35 L70 28 L110 70 L150 62 L190 110 L230 98 L270 140 L320 132 L360 170 L400 182" fill="none" stroke="#e5484d" stroke-width="5" stroke-linejoin="round"/></svg><div class="cap">panic selling</div></div>
<div><div class="lbl">THE CULT</div><div class="big blue">+${USDC}USDC</div><svg class="ch" viewBox="0 0 400 190" preserveAspectRatio="none"><path d="M0 180 L40 180 L40 160 L80 160 L80 142 L120 142 L120 118 L160 118 L160 100 L200 100 L200 84 L240 84 L240 66 L280 66 L280 50 L320 50 L320 34 L360 34 L360 18 L400 18" fill="none" stroke="#2775ca" stroke-width="5" stroke-linejoin="round"/></svg><div class="cap">getting paid, every 10 minutes</div></div>
</div></div>`,
  }),
  // 2. Paper hands pay
  page("2-paper-hands-pay", {
    html: `<div class="wrap"><h1>Paper hands pay.</h1><h1><em>Diamond hands get paid.</em></h1>
<p class="muted" style="font:500 36px/1.4 'Inter Tight';margin:56px 0 0;max-width:820px">Sellers pay 10% in ${SOL} SOL.<br>Holders get it back in ${USDC} USDC, every 10 minutes.</p></div>`,
  }),
  // 3. The ritual
  page("3-the-ritual", {
    css: `.steps{list-style:none;margin:60px 0 0;padding:0;text-align:left;font:600 58px/1.15 "Inter Tight";letter-spacing:-.03em}
.steps li{display:flex;align-items:center;gap:34px;padding:22px 0}.steps li+li{border-top:1px solid var(--line)}
.steps .n{font:500 30px "JetBrains Mono";color:var(--dim);width:52px}`,
    html: `<div class="wrap" style="padding-bottom:160px"><div class="mono muted" style="font-size:28px;letter-spacing:.18em">THE RITUAL</div><ol class="steps">
<li><span class="n">01</span>Join with ${SOL} <span class="muted" style="font-weight:500">(0% fee)</span></li>
<li><span class="n">02</span>Hold.</li>
<li><span class="n">03</span>Receive ${USDC} <em>every 10 min</em></li>
<li><span class="n">04</span>Repeat. Forever.</li></ol></div>`,
  }),
  // 4. The notification
  page("4-notification", {
    css: `.toast{width:860px;display:flex;gap:26px;align-items:center;text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:30px;padding:34px 38px;box-shadow:0 30px 80px rgba(0,0,0,.45)}
.toast .ic{width:92px;height:92px;flex:none}.toast .t{font:600 34px "Inter Tight"}.toast .s{margin-top:6px;font:500 28px "JetBrains Mono";color:var(--muted)}.toast .a{margin-left:auto;font:700 40px "JetBrains Mono";color:var(--blue)}
.stack .toast+.toast{margin-top:22px;opacity:.55;transform:scale(.96)}.stack .toast+.toast+.toast{opacity:.25;transform:scale(.92)}`,
    html: `<div class="wrap" style="padding-bottom:170px"><h2 style="margin-bottom:64px">Market is nuking.<br><span class="muted">My phone:</span></h2><div class="stack">
<div class="toast"><img class="ic" src="../../public/usdc.svg" alt=""><div><div class="t">Received USDC</div><div class="s">from CULT · now</div></div><div class="a">+4.20</div></div>
<div class="toast"><img class="ic" src="../../public/usdc.svg" alt=""><div><div class="t">Received USDC</div><div class="s">from CULT · 10m ago</div></div><div class="a">+3.86</div></div>
<div class="toast"><img class="ic" src="../../public/usdc.svg" alt=""><div><div class="t">Received USDC</div><div class="s">from CULT · 20m ago</div></div><div class="a">+5.11</div></div></div></div>`,
  }),
  // 5. WIF had the hat
  page("5-hat-and-hood", {
    html: `<div class="wrap"><img src="../hooded/cult-transparent.svg" alt="" style="width:260px;height:260px;margin-bottom:56px"><h1>$WIF had the hat.</h1><h1><em>$CULT has the hood.</em></h1>
<p class="muted" style="font:500 34px/1.4 'Inter Tight';margin:48px 0 0">Same ${SOL} trenches. One difference:<br>the cult pays you in ${USDC} to keep it on.</p></div>`,
  }),
  // 6. Leaving costs 10%
  page("6-leaving", {
    css: `.clock{font:500 220px/1 "JetBrains Mono";letter-spacing:-.04em}.bar{width:360px;height:4px;background:var(--line);border-radius:4px;margin:26px auto 60px;overflow:hidden}.bar>div{width:72%;height:100%;background:var(--muted)}`,
    html: `<div class="wrap" style="padding-bottom:150px"><div class="muted" style="font-size:30px">The cult gets paid in</div><div class="clock">02:47</div><div class="bar"><div></div></div>
<h2>You can leave whenever you want.</h2><h2 class="muted" style="margin-top:10px">It just costs 10% in ${SOL}.<br><em>Paid to everyone who stayed.</em></h2></div>`,
  }),
];

for (const m of memes) {
  execFileSync(EDGE, ["--headless", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${process.env.TEMP}\\cult-edge-${m}-${Date.now()}`, "--window-size=1200,1200", "--virtual-time-budget=6000", `--screenshot=${dir}\\${m}.png`, `file:///${dir.replace(/\\/g, "/")}/${m}.html`], { stdio: "ignore" });
  console.log("rendered", m);
}
