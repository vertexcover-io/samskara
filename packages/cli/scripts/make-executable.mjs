// Cross-platform replacement for `chmod +x dist/main.js`.
// The exec bit only matters for the Unix `bin` symlink (its shebang runs it
// directly). On Windows the file is invoked via a generated .cmd/.ps1 shim, so
// chmod is meaningless there and its absence must not fail the build.
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") process.exit(0);

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "dist", "main.js");

try {
  chmodSync(target, 0o755);
} catch (err) {
  console.error(`make-executable: could not chmod ${target}: ${err.message}`);
  process.exit(1);
}
