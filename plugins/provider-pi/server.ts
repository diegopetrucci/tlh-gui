import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { piProviderDeclarations } from "./src/declaration.js";

export default function plugin(bb: BbPluginApi): void {
  for (const declaration of piProviderDeclarations()) {
    const registered = bb.providers.register(declaration);
    bb.onDispose(() => {
      registered.dispose();
    });
  }
}
