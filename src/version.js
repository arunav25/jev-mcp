/** Package version, read once at startup. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let resolved = "0.0.0";
try {
  const manifest = fileURLToPath(new URL("../package.json", import.meta.url));
  resolved = JSON.parse(readFileSync(manifest, "utf8")).version ?? resolved;
} catch {
  // Running from a bundle without the manifest; the default stands.
}

export const version = resolved;
