import { afterEach, describe, expect, it, vi } from "vitest";

import { jevEndpoint } from "./decider/jev.ts";
import { deciderCredential, voiceCredential } from "./included-services.ts";

const RELAY_VOICE = "https://cloud.example.test/api/cloud/services/voice/v1";
// A Jev base URL: the relay's one route is <this>/v1/systemone.
const RELAY_DECIDER = "https://cloud.example.test/api/cloud/services/decider";
const cloud = {
  QUATI_CLOUD_VOICE_URL: RELAY_VOICE,
  QUATI_CLOUD_VOICE_TOKEN: "quati_voice_included",
  QUATI_CLOUD_DECIDER_URL: RELAY_DECIDER,
  QUATI_CLOUD_DECIDER_TOKEN: "quati_decide_included",
};

describe("ElevenLabs credential", () => {
  it("falls back to the included token, sent only to the relay, when there is no own key", () => {
    expect(voiceCredential(undefined, cloud)).toEqual({ token: "quati_voice_included", api: RELAY_VOICE, included: true });
    expect(voiceCredential(undefined, { QUATI_CLOUD_VOICE_TOKEN: "quati_voice_included" })).toBeNull();
  });

  it("uses the person's own key, sent only to ElevenLabs", () => {
    expect(voiceCredential("sk-own", cloud)).toEqual({ token: "sk-own", api: "https://api.elevenlabs.io/v1", included: false });
    expect(voiceCredential("sk-own", { ...cloud, QUATI_ELEVENLABS_API: "http://127.0.0.1:9/v1" }))
      .toEqual({ token: "sk-own", api: "http://127.0.0.1:9/v1", included: false });
  });

  it("never mixes the two services' tokens", () => {
    expect(voiceCredential("box_omb_included", cloud)).toMatchObject({ api: "https://api.elevenlabs.io/v1", included: false });
  });
});

describe("Jev credential", () => {
  // `api` is a Jev base URL: the backend adds /v1/systemone.
  const endpoint = (credential: ReturnType<typeof deciderCredential>) => String(jevEndpoint(credential?.api));

  it("falls back to the included token, sent only to the relay's one route, when there is no own key", () => {
    for (const own of [undefined, "", "   "]) {
      const credential = deciderCredential(own, undefined, cloud);
      expect(credential).toEqual({ token: "quati_decide_included", api: RELAY_DECIDER, included: true });
      expect(endpoint(credential)).toBe(`${RELAY_DECIDER}/v1/systemone`);
    }
  });

  it("uses the person's own key, sent only to Jev or their own base URL", () => {
    const own = deciderCredential(" tsk_own ", undefined, cloud);
    expect(own).toEqual({ token: "tsk_own", api: "https://api.typesafe.ai", included: false });
    expect(endpoint(own)).toBe("https://api.typesafe.ai/v1/systemone");
    const local = deciderCredential("tsk_own", "http://127.0.0.1:9", cloud);
    expect(local).toEqual({ token: "tsk_own", api: "http://127.0.0.1:9", included: false });
    expect(endpoint(local)).toBe("http://127.0.0.1:9/v1/systemone");
  });

  it("sends the included token only to the relay, whatever base URL is set for own keys", () => {
    expect(deciderCredential(undefined, "http://127.0.0.1:9", cloud)).toMatchObject({ token: "quati_decide_included", included: true });
    expect(endpoint(deciderCredential(undefined, "http://127.0.0.1:9", cloud))).toBe(`${RELAY_DECIDER}/v1/systemone`);
    expect(endpoint(deciderCredential("quati_decide_included", undefined, cloud))).toBe(`${RELAY_DECIDER}/v1/systemone`);
  });

  it("is included only when both the relay URL and the token are set", () => {
    expect(deciderCredential(undefined, undefined, {})).toBeNull();
    expect(deciderCredential(undefined, undefined, { QUATI_CLOUD_DECIDER_TOKEN: "quati_decide_included" })).toBeNull();
    expect(deciderCredential(undefined, undefined, { QUATI_CLOUD_DECIDER_URL: RELAY_DECIDER })).toBeNull();
    expect(deciderCredential(undefined, undefined, { QUATI_CLOUD_DECIDER_URL: RELAY_DECIDER, QUATI_CLOUD_DECIDER_TOKEN: "  " })).toBeNull();
    const slashed = deciderCredential(undefined, undefined, { QUATI_CLOUD_DECIDER_URL: `${RELAY_DECIDER}/`, QUATI_CLOUD_DECIDER_TOKEN: " quati_decide_included " });
    expect(slashed).toEqual({ token: "quati_decide_included", api: RELAY_DECIDER, included: true });
  });

  it("uses the relay URL as it is: the final URL is exactly <QUATI_CLOUD_DECIDER_URL>/v1/systemone", () => {
    for (const url of [RELAY_DECIDER, "https://relay.example.test/v1", "https://relay.example.test/a/v1/b"]) {
      const credential = deciderCredential(undefined, undefined, { QUATI_CLOUD_DECIDER_URL: url, QUATI_CLOUD_DECIDER_TOKEN: "quati_decide_included" });
      expect(credential?.api).toBe(url);
      expect(endpoint(credential)).toBe(`${url}/v1/systemone`);
    }
  });

  it("never takes another service's relay token", () => {
    const { QUATI_CLOUD_DECIDER_URL: _url, QUATI_CLOUD_DECIDER_TOKEN: _token, ...others } = cloud;
    expect(deciderCredential(undefined, undefined, others)).toBeNull();
  });
});

describe("holdIncludedServices", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps the tokens in memory and removes them from the environment, so nothing started later inherits them", async () => {
    for (const [name, value] of Object.entries(cloud)) vi.stubEnv(name, value);
    // A fresh module: the hold is process-wide state.
    vi.resetModules();
    const services = await import("./included-services.ts");
    vi.stubEnv("QUATI_CLOUD_AI_URL", "https://cloud.example.test/api/cloud/services/ai");
    vi.stubEnv("QUATI_CLOUD_AI_TOKEN", `quati_ai_${"a".repeat(43)}`);
    services.holdIncludedServices();
    expect(process.env.QUATI_CLOUD_AI_TOKEN).toBeUndefined();
    expect(process.env.QUATI_CLOUD_BOAT_TOKEN).toBeUndefined();
    expect(process.env.QUATI_CLOUD_VOICE_TOKEN).toBeUndefined();
    expect(process.env.QUATI_CLOUD_DECIDER_TOKEN).toBeUndefined();
    expect(process.env.QUATI_CLOUD_DECIDER_URL).toBe(RELAY_DECIDER);
    expect(services.voiceCredential(undefined)).toEqual({ token: "quati_voice_included", api: RELAY_VOICE, included: true });
    expect(services.deciderCredential(undefined, undefined)).toEqual({ token: "quati_decide_included", api: RELAY_DECIDER, included: true });
    expect(services.voiceCredential("sk-own")).toMatchObject({ token: "sk-own", included: false });
    expect(services.deciderCredential("tsk_own", undefined)).toEqual({ token: "tsk_own", api: "https://api.typesafe.ai", included: false });
  });
});
