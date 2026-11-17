import { describe, expect, it } from "vitest";
import { piProviderDeclaration } from "./declaration.js";

describe("provider icon declarations", () => {
  it.each(["tlh", "tlh-main"] as const)(
    "%s uses the untinted tlh mark",
    (flavor) => {
      const declaration = piProviderDeclaration(flavor);
      expect(declaration.icon).toBe("./icons/tlh.svg");
      expect(declaration.strings?.iconTint).toBeUndefined();
    },
  );

  it("keeps the tinted pi icon for pi", () => {
    const declaration = piProviderDeclaration("pi");
    expect(declaration.icon).toBe("./icons/pi.svg");
    expect(declaration.strings?.iconTint).toEqual({
      light: "#6D5DFB",
      dark: "#6D5DFB",
    });
  });
});
