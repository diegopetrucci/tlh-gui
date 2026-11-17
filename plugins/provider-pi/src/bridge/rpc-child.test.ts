import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_BRIDGE_OPTIONS_BY_FLAVOR } from "../bridge-options.js";
import {
  PI_BRIDGE_ARGS_ENV,
  PI_BRIDGE_COMMAND_ENV,
  PiRpcChild,
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

describe("PiRpcChild launch", () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "starts a tlh-flavor wrapper launcher with the bridge channel env and ignores BB_PI_BRIDGE_COMMAND",
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "bb-pi-wrapper-"));
      directories.push(directory);
      const envDump = path.join(directory, "env.txt");
      const wrapper = path.join(directory, "tlh-wrapper");
      writeFileSync(
        wrapper,
        `#!/bin/sh\nprintf '%s\\n%s\\n' "$BB_PI_BRIDGE_CHANNEL" "$BB_PI_BRIDGE_CHANNEL_TOKEN" > "${envDump}"\n`,
      );
      chmodSync(wrapper, 0o755);
      vi.stubEnv(PI_BRIDGE_COMMAND_ENV, "/nonexistent/should-not-be-used");
      const child = new PiRpcChild({
        cwd: directory,
        env: { ...process.env },
        args: [],
        onEvent: () => undefined,
        onChannelMessage: () => undefined,
        onExit: () => undefined,
        recordThreadId: null,
        bridgeOptions: {
          ...PI_BRIDGE_OPTIONS_BY_FLAVOR.tlh,
          command: wrapper,
        },
      });
      await child.waitForExit();
      const [address, token] = readFileSync(envDump, "utf8").split("\n");
      expect(address).toBeTruthy();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    },
  );
});
