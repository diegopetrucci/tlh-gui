import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  command: "tlh",
  readFileResult: null as string | null | Error,
  execFileResult: null as string | null,
  resolvedExecutable: null as string | null,
  fetchResult: null as object | null | "error" | "timeout",
}));

vi.mock("./rpc-child.js", () => ({
  resolvePiLaunch: () => ({ command: mockState.command, args: [] }),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => {
    if (mockState.readFileResult instanceof Error)
      throw mockState.readFileResult;
    if (mockState.readFileResult === null)
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return mockState.readFileResult;
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFileCustom = vi.fn(async () => {
    if (mockState.execFileResult === null) {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    }
    return { stdout: mockState.execFileResult, stderr: "" };
  });
  const execFileMock = vi.fn();
  (execFileMock as unknown as Record<symbol, unknown>)[
    promisify.custom
  ] = execFileCustom;
  return { ...actual, execFile: execFileMock };
});

vi.mock("@get-bb/plugin-sdk/provider-bridge", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@get-bb/plugin-sdk/provider-bridge")>();
  return {
    ...original,
    experimental_resolveExecutablePath: vi.fn(
      async () => mockState.resolvedExecutable,
    ),
  };
});

import {
  fetchTlhLatestRelease,
  getTlhInstallationStatus,
  isTlhMode,
  readTlhInstallState,
  tlhInstallerCommand,
  tlhInstallationRun,
  tlhUpdateCommand,
} from "./tlh-maintenance.js";

const validInstallState = JSON.stringify({
  schemaVersion: 1,
  repo: "diegopetrucci/the-last-harness",
  track: "latest-release",
  ref: "v0.10.0",
});

function makeFetchMock(
  result: typeof mockState.fetchResult,
): typeof globalThis.fetch {
  return vi.fn(async () => {
    if (result === "error") throw new Error("network error");
    if (result === "timeout") {
      await new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("aborted")), 50),
      );
      throw new Error("aborted");
    }
    const body = result ?? {};
    return {
      ok: true,
      json: async () => body,
    } as Response;
  });
}

afterEach(() => {
  mockState.command = "tlh";
  mockState.readFileResult = null;
  mockState.execFileResult = null;
  mockState.resolvedExecutable = null;
  mockState.fetchResult = null;
  vi.restoreAllMocks();
});

describe("isTlhMode", () => {
  it("returns true when command basename is tlh", () => {
    mockState.command = "tlh";
    expect(isTlhMode()).toBe(true);
  });

  it("returns true when command is a full path ending in tlh", () => {
    mockState.command = "/usr/local/bin/tlh";
    expect(isTlhMode()).toBe(true);
  });

  it("returns false when command is pi", () => {
    mockState.command = "pi";
    expect(isTlhMode()).toBe(false);
  });

  it("returns false when command is node", () => {
    mockState.command = "/usr/bin/node";
    expect(isTlhMode()).toBe(false);
  });
});

describe("readTlhInstallState", () => {
  it("returns null when file is missing", async () => {
    mockState.readFileResult = null;
    expect(await readTlhInstallState()).toBeNull();
  });

  it("returns null when file is invalid JSON", async () => {
    mockState.readFileResult = "not json {";
    expect(await readTlhInstallState()).toBeNull();
  });

  it("returns null when schemaVersion is wrong", async () => {
    mockState.readFileResult = JSON.stringify({
      schemaVersion: 2,
      track: "latest-release",
      ref: "v0.10.0",
    });
    expect(await readTlhInstallState()).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    mockState.readFileResult = JSON.stringify({ schemaVersion: 1, ref: "v0.10.0" });
    expect(await readTlhInstallState()).toBeNull();
  });

  it("parses a valid install state", async () => {
    mockState.readFileResult = validInstallState;
    const state = await readTlhInstallState();
    expect(state).toMatchObject({
      schemaVersion: 1,
      repo: "diegopetrucci/the-last-harness",
      track: "latest-release",
      ref: "v0.10.0",
    });
  });

  it("uses PI_CODING_AGENT_DIR env when set", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/custom/agent");
    const { readFile } = await import("node:fs/promises");
    mockState.readFileResult = validInstallState;
    await readTlhInstallState();
    expect(readFile).toHaveBeenCalledWith(
      expect.stringContaining("/custom/agent"),
      "utf8",
    );
    vi.unstubAllEnvs();
  });

  it("falls back to ~/.the-last-harness/agent when PI_CODING_AGENT_DIR is unset", async () => {
    vi.unstubAllEnvs();
    const { readFile } = await import("node:fs/promises");
    mockState.readFileResult = validInstallState;
    await readTlhInstallState();
    expect(readFile).toHaveBeenCalledWith(
      expect.stringContaining(".the-last-harness"),
      "utf8",
    );
  });
});

describe("fetchTlhLatestRelease", () => {
  it("returns a semver string from a valid GitHub release response", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ tag_name: "v0.11.0" }));
    expect(await fetchTlhLatestRelease("diegopetrucci/the-last-harness")).toBe(
      "0.11.0",
    );
  });

  it("returns null when the response body is malformed", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ other_field: "x" }));
    expect(
      await fetchTlhLatestRelease("diegopetrucci/the-last-harness"),
    ).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", makeFetchMock("error"));
    expect(
      await fetchTlhLatestRelease("diegopetrucci/the-last-harness"),
    ).toBeNull();
  });

  it("returns null when fetch response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response),
    );
    expect(
      await fetchTlhLatestRelease("diegopetrucci/the-last-harness"),
    ).toBeNull();
  });
});

describe("getTlhInstallationStatus — installed, up to date", () => {
  beforeEach(() => {
    mockState.resolvedExecutable = "/usr/local/bin/tlh";
    mockState.execFileResult = "0.84.0\n";
    mockState.readFileResult = validInstallState;
    vi.stubGlobal("fetch", makeFetchMock({ tag_name: "v0.10.0" }));
  });

  it("reports installed, not needing update when current matches latest", async () => {
    const status = await getTlhInstallationStatus(true, "0.84.0");
    expect(status).toMatchObject({
      executableName: "tlh",
      installed: true,
      installSource: "external",
      npmPackageName: null,
      npmGlobalPackageVersion: null,
      currentVersion: "0.10.0",
      latestVersion: "0.10.0",
      minimumSupportedVersion: null,
      needsUpdate: false,
      versionUnsupported: false,
      installAction: null,
    });
  });
});

describe("getTlhInstallationStatus — update available", () => {
  beforeEach(() => {
    mockState.resolvedExecutable = "/usr/local/bin/tlh";
    mockState.execFileResult = "0.84.0\n";
    mockState.readFileResult = JSON.stringify({
      schemaVersion: 1,
      repo: "diegopetrucci/the-last-harness",
      track: "latest-release",
      ref: "v0.10.0",
    });
    vi.stubGlobal("fetch", makeFetchMock({ tag_name: "v0.11.0" }));
  });

  it("sets needsUpdate and installAction to tlh update", async () => {
    const status = await getTlhInstallationStatus(true, "0.84.0");
    expect(status).toMatchObject({
      needsUpdate: true,
      installAction: {
        kind: "update",
        label: "Update",
        command: expect.stringContaining("tlh"),
      },
    });
    expect(status.installAction?.command).toContain("update");
  });
});

describe("getTlhInstallationStatus — unsupported Pi version", () => {
  beforeEach(() => {
    mockState.resolvedExecutable = "/usr/local/bin/tlh";
    mockState.execFileResult = "0.83.0\n";
    mockState.readFileResult = JSON.stringify({
      schemaVersion: 1,
      repo: "diegopetrucci/the-last-harness",
      track: "latest-release",
      ref: "v0.10.0",
    });
    vi.stubGlobal("fetch", makeFetchMock({ tag_name: "v0.10.0" }));
  });

  it("sets versionUnsupported and installAction to tlh update", async () => {
    const status = await getTlhInstallationStatus(true, "0.84.0");
    expect(status).toMatchObject({
      versionUnsupported: true,
      installAction: {
        kind: "update",
        label: "Update",
      },
    });
    expect(status.installAction?.command).toContain("tlh");
  });
});

describe("getTlhInstallationStatus — not installed", () => {
  beforeEach(() => {
    mockState.resolvedExecutable = null;
    mockState.execFileResult = null;
    mockState.readFileResult = null;
  });

  it("sets installed=false and installAction to the TLH installer", async () => {
    const status = await getTlhInstallationStatus(true, "0.84.0");
    expect(status).toMatchObject({
      installed: false,
      installAction: {
        kind: "install",
        label: "Install",
      },
    });
    expect(status.installAction?.command).toContain("install.sh");
  });
});

describe("getTlhInstallationStatus — missing install-state.json", () => {
  beforeEach(() => {
    mockState.resolvedExecutable = "/usr/local/bin/tlh";
    mockState.execFileResult = "0.84.0\n";
    mockState.readFileResult = null;
  });

  it("does not crash and reports no update (currentVersion null)", async () => {
    const status = await getTlhInstallationStatus(true, "0.84.0");
    expect(status).toMatchObject({
      installed: true,
      currentVersion: null,
      latestVersion: null,
      needsUpdate: false,
      installAction: null,
    });
  });
});

describe("getTlhInstallationStatus — invalid install-state.json", () => {
  beforeEach(() => {
    mockState.resolvedExecutable = "/usr/local/bin/tlh";
    mockState.execFileResult = "0.84.0\n";
    mockState.readFileResult = JSON.stringify({ schemaVersion: 99 });
  });

  it("does not crash and reports no update (currentVersion null)", async () => {
    const status = await getTlhInstallationStatus(true, "0.84.0");
    expect(status).toMatchObject({
      installed: true,
      currentVersion: null,
      needsUpdate: false,
      installAction: null,
    });
  });
});

describe("getTlhInstallationStatus — non-release track", () => {
  beforeEach(() => {
    mockState.resolvedExecutable = "/usr/local/bin/tlh";
    mockState.execFileResult = "0.84.0\n";
    mockState.readFileResult = JSON.stringify({
      schemaVersion: 1,
      repo: "diegopetrucci/the-last-harness",
      track: "dev",
      ref: "abc1234",
    });
    vi.stubGlobal("fetch", makeFetchMock({ tag_name: "v0.11.0" }));
  });

  it("does not fetch the latest release and reports no update", async () => {
    const status = await getTlhInstallationStatus(true, "0.84.0");
    expect(fetch).not.toHaveBeenCalled();
    expect(status).toMatchObject({
      latestVersion: null,
      needsUpdate: false,
      currentVersion: null,
    });
  });
});

describe("tlhInstallationRun", () => {
  it("returns the TLH installer for install action", () => {
    const status = {
      currentVersion: "0.10.0",
      latestVersion: null,
      executableName: "tlh",
      executablePath: "/usr/local/bin/tlh",
      installed: false,
      installSource: "external" as const,
      npmPackageName: null,
      npmGlobalPackageVersion: null,
      minimumSupportedVersion: null,
      installAction: { kind: "install" as const, label: "Install" as const, command: "" },
      needsUpdate: false,
      versionUnsupported: false,
    };
    const result = tlhInstallationRun(status, "install");
    expect(result.command).toMatchObject({
      command: "sh",
      args: expect.arrayContaining([expect.stringContaining("install.sh")]),
    });
    expect(result.verification).toMatchObject({ kind: "installed" });
  });

  it("returns version_at_least verification for update when needsUpdate and latestVersion known", () => {
    const status = {
      currentVersion: "0.10.0",
      latestVersion: "0.11.0",
      executableName: "tlh",
      executablePath: "/usr/local/bin/tlh",
      installed: true,
      installSource: "external" as const,
      npmPackageName: null,
      npmGlobalPackageVersion: null,
      minimumSupportedVersion: null,
      installAction: { kind: "update" as const, label: "Update" as const, command: "" },
      needsUpdate: true,
      versionUnsupported: false,
    };
    const result = tlhInstallationRun(status, "update");
    expect(result.command).toMatchObject({ command: "tlh", args: ["update"] });
    expect(result.verification).toMatchObject({
      kind: "version_at_least",
      version: "0.11.0",
    });
  });

  it("returns installed verification for unsupported-only update (latestVersion null)", () => {
    const status = {
      currentVersion: "0.10.0",
      latestVersion: null,
      executableName: "tlh",
      executablePath: "/usr/local/bin/tlh",
      installed: true,
      installSource: "external" as const,
      npmPackageName: null,
      npmGlobalPackageVersion: null,
      minimumSupportedVersion: null,
      installAction: { kind: "update" as const, label: "Update" as const, command: "" },
      needsUpdate: false,
      versionUnsupported: true,
    };
    const result = tlhInstallationRun(status, "update");
    expect(result.command).toMatchObject({ command: "tlh", args: ["update"] });
    expect(result.verification).toMatchObject({ kind: "installed" });
  });

  it("returns installed verification for unsupported-only update (needsUpdate false, latestVersion known)", () => {
    const status = {
      currentVersion: "0.10.0",
      latestVersion: "0.10.0",
      executableName: "tlh",
      executablePath: "/usr/local/bin/tlh",
      installed: true,
      installSource: "external" as const,
      npmPackageName: null,
      npmGlobalPackageVersion: null,
      minimumSupportedVersion: null,
      installAction: { kind: "update" as const, label: "Update" as const, command: "" },
      needsUpdate: false,
      versionUnsupported: true,
    };
    const result = tlhInstallationRun(status, "update");
    expect(result.verification).toMatchObject({ kind: "installed" });
  });
});

describe("tlhInstallerCommand and tlhUpdateCommand shapes", () => {
  it("installer command uses sh -c with the install.sh URL", () => {
    const cmd = tlhInstallerCommand();
    expect(cmd.command).toBe("sh");
    expect(cmd.displayCommand).toContain("install.sh");
  });

  it("update command uses the resolved launch command", () => {
    mockState.command = "tlh";
    const cmd = tlhUpdateCommand();
    expect(cmd).toMatchObject({ command: "tlh", args: ["update"] });
    expect(cmd.displayCommand).toContain("tlh");
    expect(cmd.displayCommand).toContain("update");
  });

  it("update command uses an absolute path when BB_PI_BRIDGE_COMMAND is set", () => {
    mockState.command = "/abs/path/tlh";
    const cmd = tlhUpdateCommand();
    expect(cmd).toMatchObject({ command: "/abs/path/tlh", args: ["update"] });
    expect(cmd.displayCommand).toContain("/abs/path/tlh");
  });
});

describe("readTlhInstallState — repo validation", () => {
  it("falls back to default repo when repo contains invalid characters", async () => {
    mockState.readFileResult = JSON.stringify({
      schemaVersion: 1,
      repo: "../../etc/passwd",
      track: "latest-release",
      ref: "v0.10.0",
    });
    const state = await readTlhInstallState();
    expect(state?.repo).toBe("diegopetrucci/the-last-harness");
  });

  it("falls back to default repo when repo has no slash", async () => {
    mockState.readFileResult = JSON.stringify({
      schemaVersion: 1,
      repo: "nodash",
      track: "latest-release",
      ref: "v0.10.0",
    });
    const state = await readTlhInstallState();
    expect(state?.repo).toBe("diegopetrucci/the-last-harness");
  });

  it("accepts a valid owner/repo string", async () => {
    mockState.readFileResult = JSON.stringify({
      schemaVersion: 1,
      repo: "some-org/my.repo_1",
      track: "latest-release",
      ref: "v0.10.0",
    });
    const state = await readTlhInstallState();
    expect(state?.repo).toBe("some-org/my.repo_1");
  });
});

describe("getTlhInstallationStatus — resolveExecutablePath uses launch command", () => {
  it("resolves via absolute path when BB_PI_BRIDGE_COMMAND is set", async () => {
    mockState.command = "/abs/path/tlh";
    mockState.resolvedExecutable = "/abs/path/tlh";
    mockState.execFileResult = "0.84.0\n";
    mockState.readFileResult = null;
    const { experimental_resolveExecutablePath } = await import(
      "@get-bb/plugin-sdk/provider-bridge"
    );
    const status = await getTlhInstallationStatus(false, "0.84.0");
    expect(experimental_resolveExecutablePath).toHaveBeenCalledWith("/abs/path/tlh");
    expect(status.installed).toBe(true);
    expect(status.minimumSupportedVersion).toBeNull();
  });
});
