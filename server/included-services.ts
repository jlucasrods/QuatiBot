import { JEV_DEFAULT_BASE_URL } from "./decider/jev.ts";
export const ELEVENLABS_API_DEFAULT = "https://api.elevenlabs.io/v1";
/** Must also be on WORKSPACE_CREDENTIAL_ENV. */
export const INCLUDED_TOKEN_ENV = ["QUATI_CLOUD_BOAT_TOKEN", "QUATI_CLOUD_VOICE_TOKEN", "QUATI_CLOUD_DECIDER_TOKEN", "QUATI_CLOUD_AI_TOKEN"] as const;

export interface ServiceCredential {
  token: string;
  /** The only base URL this token is ever sent to. */
  api: string;
  included: boolean;
}

interface Included {
  voice: ServiceCredential | null;
  decider: ServiceCredential | null;
}

function includedService(url: string | undefined, token: string | undefined): ServiceCredential | null {
  const api = url?.trim().replace(/\/+$/, "");
  const secret = token?.trim();
  return api && secret ? { token: secret, api, included: true } : null;
}

const includedFrom = (env: NodeJS.ProcessEnv): Included => ({
  voice: includedService(env.QUATI_CLOUD_VOICE_URL, env.QUATI_CLOUD_VOICE_TOKEN),
  decider: includedService(env.QUATI_CLOUD_DECIDER_URL, env.QUATI_CLOUD_DECIDER_TOKEN),
});

let held: Included | null = null;

/** Dropped from the environment at startup so nothing the server starts can inherit them. */
export function holdIncludedServices(env: NodeJS.ProcessEnv = process.env): void {
  held = includedFrom(env);
  for (const name of INCLUDED_TOKEN_ENV) delete env[name];
}

function resolve(own: string | undefined, providerApi: string, included: ServiceCredential | null): ServiceCredential | null {
  if (own) {
    // A leased computer hands the included token back as a plain one; it still goes only to its relay.
    if (included && own === included.token) return included;
    return { token: own, api: providerApi, included: false };
  }
  return included;
}
export const elevenLabsProviderApi = (env: NodeJS.ProcessEnv = process.env): string =>
  env.QUATI_ELEVENLABS_API || ELEVENLABS_API_DEFAULT;

export function voiceCredential(own: string | undefined, env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return resolve(own, elevenLabsProviderApi(env), (held ?? includedFrom(env)).voice);
}

export function deciderCredential(
  own: string | undefined,
  ownBaseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ServiceCredential | null {
  return resolve(own?.trim(), ownBaseUrl?.trim() || JEV_DEFAULT_BASE_URL, (held ?? includedFrom(env)).decider);
}
