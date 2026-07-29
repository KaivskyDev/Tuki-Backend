import { existsSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
for (const relative of ["node_modules", "coverage"]) {
  const target = resolve(root, relative);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error(`Refusing to remove path outside Tuki Core: ${target}`);
  }
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log(`Removed ${relative}`);
  }
}
