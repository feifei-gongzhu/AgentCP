import fs from "node:fs/promises";

await fs.rm("dist", { recursive: true, force: true });
