import type { AnyProviderDriver } from "../contracts.ts";
import { OpenCodeDriver } from "./acp/opencode-go.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [OpenCodeDriver];
