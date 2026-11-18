import { buildCurve, curvePlan } from "../../scripts/lib/curve.mjs";
for (const [a, b] of [[30, 400], [0.04, 0.045]]) {
  const p = curvePlan(buildCurve({ startMcap: a, gradMcap: b }));
  const o = Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  console.log(a, b, o);
}
