/**
 * 统一门禁第一段：对全部源文件执行 `node --check`（语法检查）。
 *
 *   node tools/check.mjs
 *
 * 覆盖：index.js / client.js / test-ui-server.mjs / lib/**（含 routes、store、
 * ui/pages、db/migrations）/ test/** / tools/**。
 * 新增源文件自动纳入，无需修改本文件（BLUEPRINT §12 门禁）。
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function collect(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) collect(full, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(full);
  }
}

const files = [];
for (const entry of ["index.js", "client.js", "test-ui-server.mjs"]) {
  files.push(join(ROOT, entry));
}
for (const dir of ["lib", "test", "tools"]) collect(join(ROOT, dir), files);

const failures = [];
for (const file of files) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (r.status !== 0) {
    failures.push(`${file}\n${r.stderr || r.stdout}`);
  }
}

if (failures.length) {
  console.error(`node --check 失败 ${failures.length} 个文件：\n\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log(`node --check 通过：${files.length} 个源文件`);
