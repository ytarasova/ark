import { join } from "path";

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "src/App.tsx")],
  outdir: join(import.meta.dir, "dist"),
  naming: "app.js",
  minify: true,
  target: "browser",
  format: "esm",
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Copy static files
const { copyFileSync, mkdirSync } = await import("fs");
mkdirSync(join(import.meta.dir, "dist"), { recursive: true });
copyFileSync(
  join(import.meta.dir, "src/index.html"),
  join(import.meta.dir, "dist/index.html"),
);
copyFileSync(
  join(import.meta.dir, "src/styles.css"),
  join(import.meta.dir, "dist/styles.css"),
);

console.log("Build complete: packages/web/dist/");
