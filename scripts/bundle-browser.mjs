/**
 * 浏览器产物打包：用 esbuild 把 src/browser 及其 shared 依赖打成自包含 IIFE。
 *
 * 输出：dist/browser.bundle.js，挂到 window.TabnabbingGuard，
 * 可直接用普通 <script> 加载，无需打包器或 importmap。
 */
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

await build({
  entryPoints: [resolve(root, "src/browser/index.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "TabnabbingGuard",
  target: ["es2020"],
  outfile: resolve(root, "dist/browser.bundle.js"),
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
});
