import { mkdir } from "node:fs/promises";

// Fresh checkouts have no ignored .local tree; every test worker must be ready before mkdtemp.
await mkdir(new URL("../../.local/tmp/", import.meta.url), { recursive: true, mode: 0o700 });
