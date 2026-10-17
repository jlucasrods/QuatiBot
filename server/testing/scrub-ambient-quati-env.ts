// Side-effect import that scrubs ambient QUATI env before a module snapshots it (scripts/mcp-server.ts reads
// QUATIBOT_URL / QUATI_PORT at evaluation). Import order is the contract: keep it above the module under test.
import { isAmbientQuatiKey } from "./quati-env.ts";

for (const key of Object.keys(process.env)) {
  if (isAmbientQuatiKey(key)) delete process.env[key];
}
