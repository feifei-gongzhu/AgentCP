import fsp from "node:fs/promises";
import path from "node:path";
import { paths } from "./env.js";

export interface RuntimeReportWriteOptions {
  dir?: string;
}

export const report = {
  async writeMarkdown(name: string, content: string, options: RuntimeReportWriteOptions = {}): Promise<string> {
    const safeName = path.basename(name);
    if (!safeName || safeName === "." || safeName === "..") {
      throw new Error("report name must be a file name");
    }
    const dir = options.dir ?? paths.workspace;
    await fsp.mkdir(dir, { recursive: true });
    const reportPath = path.join(dir, safeName);
    await fsp.writeFile(reportPath, content, "utf8");
    return reportPath;
  },
};
