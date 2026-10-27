// Type-checks test/types against the built package. Schema.create only exists
// in Mongoose 9, so its check is added only when that major is installed.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("mongoose/package.json");
const major = Number(version.split(".")[0]);
const project = major >= 9 ? "test/types/tsconfig.v9.json" : "test/types/tsconfig.json";

// Mongoose 7's own cursor.d.ts no longer matches current @types/node, so its
// declaration files can't be checked; the test files still are.
const args = ["tsc", "-p", project, ...(major < 8 ? ["--skipLibCheck"] : [])];

console.log(`Type-checking ${project} against mongoose ${version}`);
execFileSync("npx", args, { stdio: "inherit" });
