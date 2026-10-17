// A shell exporting QUATI_* / QUATIBOT_* leaks them into every child and import-time env snapshot.

const AMBIENT_PREFIXES = ["QUATI_", "QUATIBOT_"] as const;

export function isAmbientQuatiKey(key: string): boolean {
  return AMBIENT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function stripQuatiEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isAmbientQuatiKey(key)) clean[key] = value;
  }
  return clean;
}

export function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...stripQuatiEnv(process.env), ...overrides };
}
