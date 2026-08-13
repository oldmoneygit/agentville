const esbuild = require("esbuild");

const args = process.argv.slice(2);
const isWatch = args.includes("--watch");
const isMinify = args.includes("--minify");

const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  minify: isMinify,
  sourcemap: !isMinify,
  logLevel: "info",
};

async function run() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await esbuild.build(buildOptions);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
