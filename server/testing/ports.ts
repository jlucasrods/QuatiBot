// Ports for suites that boot real servers: probe first, so two suites at once never lose an unchecked bind.
import { createServer } from "node:http";

const isFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

/** A base where every `base + offset` is free (the harness also opens a webhook receiver one above
 * itself). A probe, not a reservation: the ports are released before they are returned. */
export async function freePortBlock(offsets: number[], from = 19_600, span = 3_000): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = from + Math.floor(Math.random() * span);
    const checks = await Promise.all(offsets.map((offset) => isFree(base + offset)));
    if (checks.every(Boolean)) return base;
  }
  throw new Error(`no free port block for offsets ${offsets.join(",")} in ${from}..${from + span}`);
}
