import { expect, it } from "vitest";
import { FIXTURE_STARTER_BOT_NAME, launchVerificationServer } from "../scripts/control-quati.ts";

it("pins the fixture starter bot's name deterministically (#1257)", async () => {
  // The first-run seed draws a random name from server/names.ts, which includes "Quill": both launches must see the pinned name.
  for (let launch = 0; launch < 2; launch++) {
    const fixture = await launchVerificationServer({});
    try {
      const response = await fetch(fixture.info.url + "/api/bots", {
        headers: { origin: fixture.info.url },
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.ok).toBe(true);
      const bots = ((await response.json()) as { bots: Array<{ name: string }> }).bots;
      expect(bots).toHaveLength(1);
      expect(bots[0].name).toBe(FIXTURE_STARTER_BOT_NAME);
    } finally {
      await fixture.close();
    }
  }
});

it("keeps the fixture blind to this machine's installed CLIs (#2035)", async () => {
  const fixture = await launchVerificationServer({});
  try {
    const get = async (path: string) => {
      const response = await fetch(fixture.info.url + path, {
        headers: { origin: fixture.info.url },
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.ok).toBe(true);
      return response.json() as Promise<Record<string, any>>;
    };
    const { instances } = await get("/api/instances") as { instances: Array<{ instanceId: string; snapshot: { state: string } }> };
    expect(instances.map((instance) => instance.instanceId)).toEqual(["opencodeGo"]);
    expect(instances.filter((instance) => instance.snapshot.state === "available").map((instance) => instance.instanceId))
      .toEqual(["opencodeGo"]);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await get("/api/cli-candidates?name=opencode")).candidates).toEqual([]);
    }
  } finally {
    await fixture.close();
  }
});
