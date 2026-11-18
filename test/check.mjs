// npm run check: every source and test file parses (there is no TypeScript here, so this is the cheap gate).
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
const files = ["src", "test"].flatMap((d) => readdirSync(d).filter((f) => /.(js|mjs)$/.test(f)).map((f) => d + "/" + f));
for (const f of files) execFileSync(process.execPath, ["--check", f], { stdio: "inherit" });
console.log("checked", files.length, "files");
