import fs from "node:fs/promises";
import path from "node:path";

const cjsDir = path.resolve("dist/cjs");
const indexJs = path.join(cjsDir, "index.js");
const indexCjs = path.join(cjsDir, "index.cjs");

await fs.rm(indexCjs, { force: true });
await fs.rename(indexJs, indexCjs);
await fs.writeFile(path.join(cjsDir, "package.json"), JSON.stringify({ type: "commonjs" }) + "\n", "utf8");
