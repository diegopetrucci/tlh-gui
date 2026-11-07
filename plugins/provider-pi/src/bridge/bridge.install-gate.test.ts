import { readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PI_BRIDGE_ARGS_ENV, PI_BRIDGE_COMMAND_ENV } from "./rpc-child.js";
import { npmNodeShim } from "./npm-shim.test-support.js";
import {
  type FakePiBridgeHarness,
  fakePiPath,
  startFakePiBridge,
} from "./test-support.js";

let harness: FakePiBridgeHarness;
let requestId = 0;

function nextRequestId(): number {
  requestId += 1;
  return requestId;
}

beforeEach(async () => {
  harness = await startFakePiBridge({
    prefix: "bb-pi-install-gate-",
    initialize: true,
  });
});

afterEach(async () => {
  await harness.teardown();
});

it("reports ready with the installed version after the get_state probe", async () => {
  const response = await harness.request(nextRequestId(), "provider/health", {
    providerId: "pi",
    cwd: harness.workspaceDir,
  });
  expect(response.result).toMatchObject({
    supported: true,
    health: {
      status: "ready",
      installedVersion: "0.84.0",
      minimumSupportedVersion: "0.84.0",
      canInstall: true,
      canUpdate: true,
      loginCommand: "pi",
    },
  });
}, 30_000);

it.skipIf(process.platform !== "win32").each(["global", "local"])(
  "lists models through the real injected extension with a default %s npm shim",
  async (layout) => {
    const root = harness.workspaceDir;
    const nodeModules = join(root, "node_modules");
    const pkg = join(nodeModules, "@earendil-works", "pi-coding-agent");
    const bin = layout === "local" ? join(nodeModules, ".bin") : root;
    await mkdir(pkg, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ bin: { pi: "cli.mjs" } }),
    );
    await writeFile(
      join(pkg, "cli.mjs"),
      `import ${JSON.stringify(pathToFileURL(fakePiPath).href)};`,
    );
    await copyFile(process.execPath, join(bin, "node.exe"));
    await writeFile(
      join(bin, "pi.cmd"),
      npmNodeShim(
        layout === "local"
          ? "..\\@earendil-works\\pi-coding-agent\\cli.mjs"
          : "node_modules\\@earendil-works\\pi-coding-agent\\cli.mjs",
      ),
    );
    vi.stubEnv(
      "PATH",
      `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`,
    );
    vi.stubEnv(PI_BRIDGE_COMMAND_ENV, undefined);
    vi.stubEnv(PI_BRIDGE_ARGS_ENV, undefined);
    const models = await harness.request(nextRequestId(), "model/list", {
      cwd: root,
    });
    expect(models.error).toBeUndefined();
    expect(models.result).toMatchObject({ models: expect.any(Array) });
  },
  30_000,
);

it("refuses a pi older than the supported minimum before spawning it", async () => {
  vi.stubEnv("FAKE_PI_VERSION", "0.83.2");
  const health = await harness.request(nextRequestId(), "provider/health", {
    providerId: "pi",
    cwd: harness.workspaceDir,
  });
  expect(health.result).toMatchObject({
    health: { status: "unsupported_version", installedVersion: "0.83.2" },
  });
  const models = await harness.request(nextRequestId(), "model/list", {
    cwd: harness.workspaceDir,
  });
  expect(models.error).toMatchObject({
    code: BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
    message: expect.stringContaining(
      "0.83.2 is older than the supported minimum 0.84.0",
    ),
  });
});

it("reports not_installed when the launch command is missing", async () => {
  vi.stubEnv(PI_BRIDGE_COMMAND_ENV, join(harness.workspaceDir, "no-such-pi"));
  vi.stubEnv(PI_BRIDGE_ARGS_ENV, "[]");
  const health = await harness.request(nextRequestId(), "provider/health", {
    providerId: "pi",
    cwd: harness.workspaceDir,
  });
  expect(health.result).toMatchObject({
    health: { status: "not_installed", canInstall: true, canUpdate: false },
  });
  const models = await harness.request(nextRequestId(), "model/list", {
    cwd: harness.workspaceDir,
  });
  expect(models.error).toMatchObject({
    code: BRIDGE_JSON_RPC_ERRORS.MISSING_EXECUTABLE,
    message: expect.stringContaining("Could not find the pi CLI"),
  });
});

it("fails closed when pi cannot report its version, with install guidance", async () => {
  vi.stubEnv("FAKE_PI_VERSION", "crash");
  const health = await harness.request(nextRequestId(), "provider/health", {
    providerId: "pi",
    cwd: harness.workspaceDir,
  });
  expect(health.result).toMatchObject({
    health: {
      status: "unknown",
      installedVersion: null,
      statusMessage: expect.stringMatching(
        new RegExp(
          `^Could not determine the pi version: \`.*--version\` exited with 1\\. Install @earendil-works/pi-coding-agent 0\\.84\\.0 or newer: ${process.platform === "win32" ? "npm\\.cmd" : "npm"} install -g @earendil-works/pi-coding-agent@latest$`,
          "u",
        ),
      ),
    },
  });
  const models = await harness.request(nextRequestId(), "model/list", {
    cwd: harness.workspaceDir,
  });
  expect(models.error).toMatchObject({
    message: expect.stringContaining("Could not determine the pi version"),
  });
});

it("memoizes the install gate per launch path across health polls", async () => {
  const processLog = join(harness.workspaceDir, "process.log");
  vi.stubEnv("FAKE_PI_PROCESS_LOG", processLog);
  await harness.request(nextRequestId(), "provider/health", {
    providerId: "pi",
    cwd: harness.workspaceDir,
  });
  await harness.request(nextRequestId(), "model/list", {
    cwd: harness.workspaceDir,
  });
  await harness.request(nextRequestId(), "provider/health", {
    providerId: "pi",
    cwd: harness.workspaceDir,
  });
  const versionSpawns = readFileSync(processLog, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("version:"));
  expect(versionSpawns).toHaveLength(1);
  vi.stubEnv(
    PI_BRIDGE_ARGS_ENV,
    JSON.stringify([fakePiPath, "--other-launch"]),
  );
  await harness.request(nextRequestId(), "provider/health", {
    providerId: "pi",
    cwd: harness.workspaceDir,
  });
  expect(
    readFileSync(processLog, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("version:")),
  ).toHaveLength(2);
}, 30_000);

const tlhMainBridgeOptions = {
  piFlavor: "tlh-main",
  displayName: "TLH main",
  command: "tlh-main",
  loginCommand: "tlh-main",
  maintenance: "tlh",
  agentDir: "~/.the-last-harness-main/agent",
};

it("ignores BB_PI_BRIDGE_COMMAND for the tlh-main flavor and reports its own CLI as missing", async () => {
  vi.stubEnv("PATH", harness.workspaceDir);
  const health = await harness.request(nextRequestId(), "provider/health", {
    providerId: "tlh-main",
    cwd: harness.workspaceDir,
    providerOptions: tlhMainBridgeOptions,
  });
  expect(health.result).toMatchObject({
    health: { status: "not_installed", loginCommand: "tlh-main" },
  });
  const models = await harness.request(nextRequestId(), "model/list", {
    cwd: harness.workspaceDir,
    providerOptions: tlhMainBridgeOptions,
  });
  expect(models.error).toMatchObject({
    code: BRIDGE_JSON_RPC_ERRORS.MISSING_EXECUTABLE,
    message: expect.stringContaining("tlh-main CLI"),
  });
  const status = await harness.request(
    nextRequestId(),
    "provider/installation/status",
    {
      providerId: "tlh-main",
      checkUpdates: false,
      providerOptions: tlhMainBridgeOptions,
    },
  );
  expect(status.result).toMatchObject({
    executableName: "tlh-main",
    installed: false,
    installAction: null,
  });
}, 30_000);

it("rejects invalid flavor options and a second flavor on the same process", async () => {
  const invalid = await harness.request(nextRequestId(), "provider/health", {
    providerId: "tlh",
    providerOptions: { piFlavor: "tlh" },
  });
  expect(invalid.error?.message).toContain(
    "Invalid provider-pi bridge options",
  );
  const first = await harness.request(nextRequestId(), "provider/health", {
    providerId: "tlh-main",
    cwd: harness.workspaceDir,
    providerOptions: tlhMainBridgeOptions,
  });
  expect(first.error).toBeUndefined();
  const second = await harness.request(nextRequestId(), "provider/health", {
    providerId: "pi",
    cwd: harness.workspaceDir,
    providerOptions: { ...tlhMainBridgeOptions, piFlavor: "pi" },
  });
  expect(second.error?.message).toContain("bound to the tlh-main flavor");
}, 30_000);

it.each([
  ["tlh", "TLH"],
  ["tlh-main", "TLH main"],
])(
  "resolves the %s flavor from providerId when no providerOptions are sent",
  async (providerId, displayName) => {
    vi.stubEnv("PATH", harness.workspaceDir);
    const health = await harness.request(nextRequestId(), "provider/health", {
      providerId,
      cwd: harness.workspaceDir,
    });
    expect(health.result).toMatchObject({
      health: { status: "not_installed", loginCommand: providerId },
    });
    const status = await harness.request(
      nextRequestId(),
      "provider/installation/status",
      { providerId, checkUpdates: false },
    );
    expect(status.result).toMatchObject({
      executableName: providerId,
      installed: false,
    });
    const run = await harness.request(
      nextRequestId(),
      "provider/installation/run",
      { providerId, action: "install" },
    );
    expect(JSON.stringify(run)).not.toContain('"pi"');
    const models = await harness.request(nextRequestId(), "model/list", {
      cwd: harness.workspaceDir,
    });
    expect(models.error).toMatchObject({
      code: BRIDGE_JSON_RPC_ERRORS.MISSING_EXECUTABLE,
      message: expect.stringContaining(providerId),
    });
    expect(displayName.length).toBeGreaterThan(0);
  },
  30_000,
);

it("lets providerId win when providerOptions lack piFlavor", async () => {
  vi.stubEnv("PATH", harness.workspaceDir);
  const health = await harness.request(nextRequestId(), "provider/health", {
    providerId: "tlh-main",
    cwd: harness.workspaceDir,
    providerOptions: { unrelated: true },
  });
  expect(health.result).toMatchObject({
    health: { status: "not_installed", loginCommand: "tlh-main" },
  });
}, 30_000);

it("keeps the pi default for model/list with neither options nor providerId", async () => {
  const models = await harness.request(nextRequestId(), "model/list", {
    cwd: harness.workspaceDir,
  });
  expect(models.error).toBeUndefined();
}, 30_000);
