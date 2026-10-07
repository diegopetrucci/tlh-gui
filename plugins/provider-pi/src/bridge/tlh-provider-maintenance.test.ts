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
