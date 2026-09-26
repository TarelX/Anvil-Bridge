const esbuild = require("esbuild");
const watch = process.argv.includes("--watch");
const options = {
  entryPoints: ["src/extension.js"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  target: "node18",
  format: "cjs",
  external: ["vscode", "node-pty"],
  minify: !watch,
  sourcemap: watch,
  logLevel: "info",
};
(async () => {
  if (watch) await (await esbuild.context(options)).watch();
  else await esbuild.build(options);
})().catch(() => process.exit(1));
