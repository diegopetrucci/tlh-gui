import { describe, expect, it } from "vitest";
import {
  PI_BRIDGE_OPTIONS_BY_FLAVOR,
  PI_FLAVORS,
  parsePiBridgeOptions,
} from "./bridge-options.js";
import { piProviderDeclarations } from "./declaration.js";

describe("parsePiBridgeOptions", () => {
  it("returns null when no flavor is present", () => {
    expect(parsePiBridgeOptions(undefined)).toBeNull();
    expect(
      parsePiBridgeOptions({ additionalWorkspaceWriteRoots: [] }),
    ).toBeNull();
  });

  it("round-trips every declared flavor and drops unrelated keys", () => {
    for (const flavor of PI_FLAVORS) {
      expect(
        parsePiBridgeOptions({
          ...PI_BRIDGE_OPTIONS_BY_FLAVOR[flavor],
          additionalWorkspaceWriteRoots: ["/x"],
        }),
      ).toEqual(PI_BRIDGE_OPTIONS_BY_FLAVOR[flavor]);
    }
  });

  it("throws on malformed options", () => {
    expect(() => parsePiBridgeOptions({ piFlavor: "nope" })).toThrow(
      "Invalid provider-pi bridge options",
    );
    expect(() =>
      parsePiBridgeOptions({ ...PI_BRIDGE_OPTIONS_BY_FLAVOR.tlh, command: "" }),
    ).toThrow("command");
  });
});

describe("piProviderDeclarations", () => {
  const declarations = piProviderDeclarations();

  it("registers TLH first, then TLH main, then Pi", () => {
    expect(declarations.map((d) => [d.id, d.displayName])).toEqual([
      ["tlh", "TLH"],
      ["tlh-main", "TLH main"],
      ["pi", "Pi"],
    ]);
  });

  it("only lists TLH always", () => {
    expect(declarations.map((d) => d.experimental_visibility)).toEqual([
      "always",
      "installed",
      "installed",
    ]);
  });

  it("carries parseable per-flavor bridge options and sign-in hints", () => {
    for (const declaration of declarations) {
      const options = parsePiBridgeOptions(
        declaration.experimental_bridgeOptions,
      );
      expect(options?.piFlavor).toBe(declaration.id);
      expect(declaration.strings?.signInHint).toContain(
        `\`${options?.loginCommand}\``,
      );
    }
    expect(declarations[2]?.strings?.installUrl).toBe("https://pi.dev");
  });
});
