#!/usr/bin/env bash
# T-0 for $CULT, in order, stopping at the first failure:  bash scripts/go-live.sh <MINT>
#   1. verify-launch: the mint is our coin (10% fee, payout wallet withdraws, our config, frz's creator wallet)
#   2. deploy the production Worker with the mint and the live settings
#   3. point a Helius webhook at the mint (refunds within seconds; the every-minute tick is the fallback)
#   4. read https://cults.bid/api/state back
# Prints no secret. Safe to run again: the deploy is the same, and an existing webhook for the mint is reused.
set -euo pipefail
MINT="${1:?usage: go-live.sh <MINT>}"
CREATOR="DRQRU9Z7vRFHD9s43TQX2BePp35HoWpNVPqN31ijTow6"
CONFIG="3jUuWLhrdao4upGuvC3muRN9cZtP7bSAqDaXsY6QsUfK"
cd "$(dirname "$0")/.."
RPC=$(grep -E '^SOLANA_RPC_URL' ~/.coined-preview/prod.vars | head -1 | sed -E 's/^[^=]*= *//; s/^"//; s/"$//; s/devnet/mainnet/')
KEY=$(echo "$RPC" | sed -E 's/.*api-key=([A-Za-z0-9-]+).*/\1/')
hide() { sed -E 's/api-key=[A-Za-z0-9-]+/api-key=HIDDEN/g'; }

echo "== 1. verify"
node scripts/verify-launch.mjs --rpc "$RPC" --mint "$MINT" --config "$CONFIG" --creator "$CREATOR" 2>&1 | hide

echo "== 2. deploy"
npx wrangler deploy --var "MINT:$MINT" --var "CREATOR:$CREATOR" --var "DBC_CONFIG:$CONFIG" --var DRY_RUN:0 --var REFUNDS_DRY_RUN:0 \
  --var REBROADCAST_MS:16000 --var FEE_PRIORITY_MICROLAMPORTS:1000000 2>&1 | grep -E "cults.bid|Version|rror" | hide

echo "== 3. webhook"
MINT="$MINT" KEY="$KEY" node -e '
const fs = require("fs"), os = require("os"), { MINT, KEY } = process.env, base = "https://api.helius.xyz/v0/webhooks";
(async () => {
  const all = await (await fetch(`${base}?api-key=${KEY}`)).json();
  const have = all.find((w) => w.webhookURL === "https://cults.bid/api/hook");
  const body = { webhookURL: "https://cults.bid/api/hook", accountAddresses: [MINT], transactionTypes: ["ANY"], webhookType: "enhanced",
    authHeader: fs.readFileSync(os.homedir() + "/.cult/prod-webhook-secret.txt", "utf8").trim() };
  const r = await fetch(have ? `${base}/${have.webhookID}?api-key=${KEY}` : `${base}?api-key=${KEY}`, { method: have ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok || !j.webhookID) throw new Error("Helius said " + r.status + ": " + JSON.stringify(j).slice(0, 200));
  fs.writeFileSync(os.homedir() + "/.cult/prod-webhook-id.txt", j.webhookID);
  console.log(have ? "updated" : "created", j.webhookID, "->", j.webhookURL, j.accountAddresses.join(","));
})().catch((e) => { console.error(e.message); process.exit(1); });'

echo "== 4. live state"
curl -s --doh-url https://1.1.1.1/dns-query --max-time 20 https://cults.bid/api/state | head -c 400; echo
