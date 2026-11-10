/**
 * 确定性对比度检查（tools/contrast-check.mjs；M1 新增，蓝图 P0-1①）。
 *
 *   node tools/contrast-check.mjs
 *
 * 以 lib/ui/theme.mjs 的 TOKENS + CONTRAST_PAIRS 为单一真值源，对浅/深两主题
 * 逐对以 WCAG 相对亮度公式计算对比度；输出每个 token 对的实测对比率，
 * 任一对低于其声明下限（文本 ≥4.5，正文/标题目标 ≥7，非文本组件 ≥3）
 * 即以非零码退出。node 直接运行，无浏览器依赖。
 *
 * 该脚本与 test/ui-design.test.mjs 共用同一公式实现（theme.mjs 导出），
 * 保证「脚本检查」与「测试闸」永不分叉。
 */
import { evaluateContrast, CONTRAST_PAIRS, TOKENS } from "../lib/ui/theme.mjs";

const themes = ["light", "dark"];
let failures = 0;

console.log(`Sorne 主题 token 对比度检查（WCAG 2.x 相对亮度公式；token ${TOKENS.length} 个 / 对比度契约 ${CONTRAST_PAIRS.length} 对）\n`);

for (const theme of themes) {
  console.log(`── ${theme === "light" ? "浅色主题" : "深色主题"}（data-sorne-theme="${theme}"）──`);
  console.log("前景 token                          背景 token                          实测     要求  判定");
  for (const r of evaluateContrast(theme)) {
    const mark = r.pass ? "通过" : "不通过";
    if (!r.pass) failures += 1;
    console.log(
      `${r.fg.padEnd(36)}${r.bg.padEnd(36)}${String(r.ratio).padEnd(9)}${(`≥${r.min}`).padEnd(6)}${mark}  ${r.note}`,
    );
  }
  console.log("");
}

if (failures > 0) {
  console.error(`对比度检查失败：${failures} 对不达标（文本 ≥4.5、正文/标题目标 ≥7、非文本组件 ≥3）。`);
  console.error("调整 lib/ui/theme.mjs 中的 token 值后重跑；不得降低阈值、不得删除契约对。");
  process.exit(1);
}
console.log("对比度检查通过：全部 token 对达标。");
