// `pnpm dev:server`: the harness from a source checkout, whose UI reaches it through Vite's dev proxy in a browser on
// this machine. QUATI_DEV_TRUST_LOCAL_BROWSER=0 tries the sign-in a self-hosted server asks a browser for.
process.env.QUATI_DEV_TRUST_LOCAL_BROWSER ??= "1";
await import("./index.ts");
