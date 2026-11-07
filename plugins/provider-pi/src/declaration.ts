import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { piExtensionKinds } from "./extension-kinds.js";
import {
  PI_BRIDGE_OPTIONS_BY_FLAVOR,
  PI_FLAVORS,
  type PiFlavor,
} from "./bridge-options.js";
import { piNativeRootsDeclaration } from "./native-roots.js";

const TLH_INSTALL_URL = "https://github.com/diegopetrucci/the-last-harness";
const ICON_TINT = { light: "#6D5DFB", dark: "#6D5DFB" };

function flavorStrings(flavor: PiFlavor): PluginProviderDeclaration["strings"] {
  const { loginCommand, displayName } = PI_BRIDGE_OPTIONS_BY_FLAVOR[flavor];
  return {
    signInHint: `Run \`${loginCommand}\` on the machine to sign in.`,
    expiredHint: `Your ${displayName} session expired. Run \`${loginCommand}\`, then reload.`,
    installUrl: flavor === "pi" ? "https://pi.dev" : TLH_INSTALL_URL,
    iconTint: ICON_TINT,
  };
}

export function piProviderDeclarations(): PluginProviderDeclaration[] {
  return PI_FLAVORS.map((flavor) => piProviderDeclaration(flavor));
}

export function piProviderDeclaration(
  flavor: PiFlavor,
): PluginProviderDeclaration {
  const options = PI_BRIDGE_OPTIONS_BY_FLAVOR[flavor];
  return {
    id: flavor,
    displayName: options.displayName,
    icon: "./icons/pi.svg",
    strings: flavorStrings(flavor),
    experimental_visibility: flavor === "tlh" ? "always" : "installed",
    experimental_bridgeOptions: { ...options },
    maintenance: { health: true, usage: false, installation: true },
    env: { passthrough: ["BB_PI_BRIDGE_COMMAND", "BB_PI_BRIDGE_ARGS"] },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    reasoningLevels: [
      { id: "none", label: "None" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
    ...piNativeRootsDeclaration(flavor),
    composerActions: [],
    extensionKinds: piExtensionKinds,
  };
}
