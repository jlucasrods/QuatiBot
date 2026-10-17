// What crosses from the launching shell into a fixture server: only what a
// test scripted on purpose. A real OpenAI key must never reach a fixture that
// could send it to OpenAI.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { verificationServerEnvironment } from "./control-quati.ts";

const childEnv = (parentEnv: NodeJS.ProcessEnv) => verificationServerEnvironment(parentEnv, join(tmpdir(), "quati-fixture-env"), 9100);

describe("a fixture driven from a real browser", () => {
  it("trusts this machine's browsers as `pnpm dev` does, unless the caller tests the sign-in", () => {
    expect(childEnv({}).QUATI_DEV_TRUST_LOCAL_BROWSER).toBe("1");
    expect(childEnv({ QUATI_DEV_TRUST_LOCAL_BROWSER: "0" })).not.toHaveProperty("QUATI_DEV_TRUST_LOCAL_BROWSER");
  });
});

describe("the fixture's fake engine knobs", () => {
  it("passes ACP fixture settings without forwarding unrelated secrets or dump destinations", () => {
    const env = childEnv({
      FAKE_ACP_MODE: "interleave", FAKE_ACP_MODELS: "fixture/scripted",
      FAKE_ACP_DUMP: "/tmp/unsafe-dump.json", SOME_SECRET: "x",
    });
    expect(env).toMatchObject({ FAKE_ACP_MODE: "interleave", FAKE_ACP_MODELS: "fixture/scripted" });
    expect(env.FAKE_ACP_DUMP).toBe(join(tmpdir(), "quati-fixture-env", "fake-acp-dump.json"));
    expect(env).not.toHaveProperty("SOME_SECRET");
  });
});

describe("the fixture's Live call environment", () => {
  it("passes a loopback fake GPT-Live and its key through", () => {
    expect(childEnv({ QUATI_OPENAI_LIVE_URL: " http://127.0.0.1:4100 ", QUATI_OPENAI_LIVE_KEY: "sk-fake" }))
      .toMatchObject({ QUATI_OPENAI_LIVE_URL: "http://127.0.0.1:4100", QUATI_OPENAI_LIVE_KEY: "sk-fake" });
    const noKey = childEnv({ QUATI_OPENAI_LIVE_URL: "http://127.0.0.1:4100" });
    expect(noKey.QUATI_OPENAI_LIVE_URL).toBe("http://127.0.0.1:4100");
    expect(noKey).not.toHaveProperty("QUATI_OPENAI_LIVE_KEY");
  });

  it("drops any other Live URL, and never lets the key cross without the fake", () => {
    for (const url of ["https://api.openai.com", "http://localhost:4100", "http://127.0.0.1:4100/v1", "http://192.0.2.1:4100", "http://127.0.0.1", ""]) {
      const env = childEnv({ QUATI_OPENAI_LIVE_URL: url, QUATI_OPENAI_LIVE_KEY: "sk-real" });
      expect(env, url).not.toHaveProperty("QUATI_OPENAI_LIVE_URL");
      expect(env, url).not.toHaveProperty("QUATI_OPENAI_LIVE_KEY");
    }
    expect(childEnv({ QUATI_OPENAI_LIVE_KEY: "sk-real" })).not.toHaveProperty("QUATI_OPENAI_LIVE_KEY");
  });

  it("lets the Pro answer cross only as QUATI_PRO_PLAN=1", () => {
    expect(childEnv({ QUATI_PRO_PLAN: "1" })).toMatchObject({ QUATI_PRO_PLAN: "1" });
    for (const value of [undefined, "", "0", "true", "yes"]) expect(childEnv({ QUATI_PRO_PLAN: value }), String(value)).not.toHaveProperty("QUATI_PRO_PLAN");
  });
});
