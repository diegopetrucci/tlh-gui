import { describe, expect, it } from "vitest";
import { PI_BRIDGE_OPTIONS_BY_FLAVOR } from "../bridge-options.js";
import {
  PI_BRIDGE_ARGS_ENV,
  PI_BRIDGE_COMMAND_ENV,
  resolvePiLaunch,
} from "./rpc-child.js";

describe("resolvePiLaunch", () => {
  it("returns the flavor default command with no args when env is empty", () => {
    expect(resolvePiLaunch({})).toEqual({ command: "pi", args: [] });
    expect(resolvePiLaunch({}, PI_BRIDGE_OPTIONS_BY_FLAVOR.tlh)).toEqual({
      command: "tlh",
      args: [],
    });
    expect(
      resolvePiLaunch({}, PI_BRIDGE_OPTIONS_BY_FLAVOR["tlh-main"]),
    ).toEqual({ command: "tlh-main", args: [] });
  });

  it("applies the BB_PI_BRIDGE_* override only to the pi flavor", () => {
    const env = {
      [PI_BRIDGE_COMMAND_ENV]: "/opt/fake-pi",
      [PI_BRIDGE_ARGS_ENV]: JSON.stringify(["--x"]),
    };
    expect(resolvePiLaunch(env, PI_BRIDGE_OPTIONS_BY_FLAVOR.pi)).toEqual({
      command: "/opt/fake-pi",
      args: ["--x"],
    });
    expect(resolvePiLaunch(env, PI_BRIDGE_OPTIONS_BY_FLAVOR.tlh)).toEqual({
      command: "tlh",
      args: [],
    });
    expect(
      resolvePiLaunch(env, PI_BRIDGE_OPTIONS_BY_FLAVOR["tlh-main"]),
    ).toEqual({ command: "tlh-main", args: [] });
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
