import {
  type ApiProvider,
  registerApiProvider,
  unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FAUX_PROVIDER_BRIDGE_KEY = Symbol.for("pi-subagents:test-faux-provider");
const SOURCE_ID = "pi-subagents-test-faux-provider";

export default function fauxProviderExtension(pi: ExtensionAPI): void {
  const provider = (globalThis as Record<symbol, unknown>)[FAUX_PROVIDER_BRIDGE_KEY] as
    | ApiProvider
    | undefined;
  if (!provider) {
    throw new Error("Faux provider bridge was loaded without a provider");
  }

  registerApiProvider(provider, SOURCE_ID);
  pi.on("session_shutdown", async () => {
    unregisterApiProviders(SOURCE_ID);
  });
}
