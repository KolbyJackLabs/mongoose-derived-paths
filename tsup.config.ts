import { readFile, writeFile } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  // Ignore-list our sources so DevTools attributes the manual-set warning to the caller's frame, not to this package
  // (node_modules is ignore-listed by default, but `npm link` resolves outside it)
  async onSuccess() {
    for (const file of ["dist/index.js.map", "dist/index.mjs.map"]) {
      const map = JSON.parse(await readFile(file, "utf8"));
      const all = map.sources.map((_: string, i: number) => i);
      await writeFile(file, JSON.stringify({ ...map, ignoreList: all, x_google_ignoreList: all }));
    }
  },
});
