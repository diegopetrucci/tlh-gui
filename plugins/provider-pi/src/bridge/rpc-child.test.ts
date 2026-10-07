import { describe, expect, it } from "vitest";
import {
  PI_BRIDGE_ARGS_ENV,
  PI_BRIDGE_COMMAND_ENV,
  resolvePiLaunch,
} from "./rpc-child.js";

describe("resolvePiLaunch", () => {
  it("returns tlh with no args when env is empty", () => {
    expect(resolvePiLaunch({})).toEqual({ command: "tlh", args: [] });
  });

  it("uses BB_PI_BRIDGE_COMMAND when set, with no args", () => {
    expect(resolvePiLaunch({ [PI_BRIDGE_COMMAND_ENV]: "pi" })).toEqual({
      command: "pi",
      args: [],
    });
  });

  it("parses BB_PI_BRIDGE_ARGS when BB_PI_BRIDGE_COMMAND is set", () => {
    expect(
      resolvePiLaunch({
        [PI_BRIDGE_COMMAND_ENV]: "pi",
        [PI_BRIDGE_ARGS_ENV]: JSON.stringify(["--x"]),
      }),
    ).toEqual({ command: "pi", args: ["--x"] });
  });
});
