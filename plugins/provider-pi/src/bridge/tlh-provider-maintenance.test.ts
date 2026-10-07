import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  command: "pi",
  executablePath: "/usr/local/bin/pi",
}));

vi.mock("@get-bb/plugin-sdk/provider-bridge", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@get-bb/plugin-sdk/provider-bridge")>();
  return {
    ...original,
    experimental_commandOutput: vi.fn(async () => ""),
    experimental_npmLatestVersion: vi.fn(async () => "0.85.0"),
    experimental_probeNpmGlobalPackage: vi.fn(async () => ({
      npmBin: path.join(path.sep, "npm", "bin"),
      npmGlobalPackageVersion: null,
    })),
    experimental_resolveExecutablePath: vi.fn(
      async () => mockState.executablePath,
    ),
  };
});

vi.mock("./rpc-child.js", () => ({
  resolvePiLaunch: () => ({ command: mockState.command, args: [] }),
}));

import {
  getPiProviderInstallationRun,
  getPiProviderInstallationStatus,
  piHealthResult,
} from "./provider-maintenance.js";

afterEach(() => {
  mockState.command = "pi";
  mockState.executablePath = "/usr/local/bin/pi";
  vi.clearAllMocks();
});

describe("non-tlh command keeps upstream npm behavior", () => {
  it("uses executableName=pi and npmPackageName when command is pi", async () => {
    mockState.command = "pi";
    mockState.executablePath = "/usr/local/bin/pi";
    const status = await getPiProviderInstallationStatus(false);
    expect(status).toMatchObject({
      executableName: "pi",
      npmPackageName: "@earendil-works/pi-coding-agent",
      installed: true,
    });
  });

  it("produces an npm update command when command is pi", async () => {
    mockState.command = "pi";
    mockState.executablePath = "/usr/local/bin/pi";
    const status = await getPiProviderInstallationStatus(true);
    expect(status.installAction?.command).toContain("npm");
    const run = await getPiProviderInstallationRun("update");
    expect(run).toMatchObject({
      available: true,
      command: {
        command: expect.stringContaining("npm"),
      },
    });
  });
});

describe("piHealthResult loginCommand — mode-aware", () => {
  it("returns 'pi' when command is pi (non-tlh mode)", () => {
    mockState.command = "pi";
    expect(piHealthResult("ready")).toMatchObject({ health: { loginCommand: "pi" } });
  });

  it("returns 'tlh' when command is tlh (tlh mode)", () => {
    mockState.command = "tlh";
    expect(piHealthResult("ready")).toMatchObject({ health: { loginCommand: "tlh" } });
  });
});

describe("getPiProviderInstallationRun — Windows win32 guard in tlh mode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns available:false with bash message for install action on win32 in tlh mode", async () => {
    mockState.command = "tlh";
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const result = await getPiProviderInstallationRun("install");
    expect(result).toMatchObject({
      available: false,
      message: expect.stringContaining("bash"),
    });
  });

  it("does not trigger win32 guard when command is not tlh", async () => {
    mockState.command = "pi";
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const result = await getPiProviderInstallationRun("install");
    expect((result as { message?: string }).message).not.toMatch(/bash/);
  });
});
