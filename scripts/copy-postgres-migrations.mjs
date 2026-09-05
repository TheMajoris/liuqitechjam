import { cp, mkdir } from "node:fs/promises";
const source = new URL("../apps/server/src/persistence/migrations/", import.meta.url);
const target = new URL("../apps/server/dist/persistence/migrations/", import.meta.url);
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
