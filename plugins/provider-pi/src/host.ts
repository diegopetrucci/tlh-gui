import { homedir } from "node:os";
import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { PI_FLAVORS, type PiFlavor } from "./bridge-options.js";
import { resolvePiNativeRoots } from "./native-roots.js";

export { experimental_providerBridge } from "./bridge/bridge.js";

function flavorForProviderId(providerId: string): PiFlavor {
  const flavor = PI_FLAVORS.find((candidate) => candidate === providerId);
  if (flavor === undefined) {
    throw new Error(
      `provider-pi cannot resolve native roots for "${providerId}"`,
    );
  }
  return flavor;
}

export default experimental_defineHostEntry({
  contract: experimental_nativeRootsHostContract,
  handlers: {
    resolveNativeRoots: ({ providerId }) =>
      resolvePiNativeRoots({
        homeDir: homedir(),
        env: process.env,
        flavor: flavorForProviderId(providerId),
      }),
  },
});
