import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  type ProviderInstallationCommand,
  type ProviderInstallationStatus,
  type ProviderInstallationVerification,
  experimental_compareVersions as compareVersions,
  experimental_downloadedInstallerCommand as downloadedInstallerCommand,
  experimental_formatCommand as formatCommand,
  experimental_resolveExecutablePath as resolveExecutablePath,
  experimental_versionFrom as versionFrom,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import {
  PI_BRIDGE_OPTIONS_BY_FLAVOR,
  type PiBridgeOptions,
} from "../bridge-options.js";
import { resolvePiLaunch } from "./rpc-child.js";

const DEFAULT_TLH_OPTIONS = PI_BRIDGE_OPTIONS_BY_FLAVOR.tlh;

const execFileAsync = promisify(execFile);

const TLH_VERSION_PROBE_TIMEOUT_MS = 15_000;
const GITHUB_RELEASES_TIMEOUT_MS = 10_000;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const DEFAULT_REPO = "diegopetrucci/the-last-harness";
const TLH_REPO_URL = `https://github.com/${DEFAULT_REPO}`;

const STRICT_SEMVER_RE =
  /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?)\s*$/u;

function strictSemver(s: string): string | null {
  const match = STRICT_SEMVER_RE.exec(s);
  return match?.[1] ?? null;
}

const installStateSchema = z.object({
  schemaVersion: z.literal(1),
  repo: z.string().regex(REPO_RE).catch(DEFAULT_REPO).default(DEFAULT_REPO),
  track: z.string(),
  ref: z.string(),
});

const versionJsonSchema = z.object({
  schemaVersion: z.literal(1),
  tlhVersion: z.string().nullable(),
  piVersion: z.string().nullable(),
  track: z.string().nullable(),
  ref: z.string().nullable(),
  repo: z
    .string()
    .nullable()
    .transform((value) =>
      value !== null && REPO_RE.test(value) ? value : null,
    ),
  agentDir: z.string(),
});

type TlhVersionJson = z.infer<typeof versionJsonSchema>;

export type TlhInstallState = z.infer<typeof installStateSchema>;

function agentDir(options: PiBridgeOptions): string {
  const configured = options.agentDir ?? "~/.the-last-harness/agent";
  if (configured.startsWith("~/")) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return configured;
}

export async function readTlhInstallState(
  options: PiBridgeOptions = DEFAULT_TLH_OPTIONS,
): Promise<TlhInstallState | null> {
  const stateFile = path.join(agentDir(options), "tlh", "install-state.json");
  let raw: string;
  try {
    raw = await readFile(stateFile, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const result = installStateSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

async function probeTlhPiVersion(
  options: PiBridgeOptions,
): Promise<string | null> {
  const launch = resolvePiLaunch(process.env, options);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      launch.command,
      [...launch.args, "--version"],
      { timeout: TLH_VERSION_PROBE_TIMEOUT_MS },
    ));
  } catch {
    return null;
  }
  return versionFrom(stdout);
}

async function probeTlhVersionJson(
  options: PiBridgeOptions,
): Promise<TlhVersionJson | null> {
  const launch = resolvePiLaunch(process.env, options);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      launch.command,
      [...launch.args, "version", "--json"],
      { timeout: TLH_VERSION_PROBE_TIMEOUT_MS },
    ));
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
  const result = versionJsonSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

async function resolveTlhRepo(options: PiBridgeOptions): Promise<string> {
  const versionJson = await probeTlhVersionJson(options);
  if (versionJson !== null) return versionJson.repo ?? DEFAULT_REPO;
  return (await readTlhInstallState(options))?.repo ?? DEFAULT_REPO;
}

export async function fetchTlhLatestRelease(
  repo: string,
): Promise<string | null> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    GITHUB_RELEASES_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) return null;
    const releaseSchema = z.object({ tag_name: z.string().min(1) });
    const body = releaseSchema.safeParse(await response.json());
    if (!body.success) return null;
    return strictSemver(body.data.tag_name);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function tlhInstallerCommand(
  repo: string = DEFAULT_REPO,
): ProviderInstallationCommand {
  const url = `https://github.com/${repo}/releases/latest/download/install.sh`;
  return downloadedInstallerCommand(url);
}

export function tlhUpdateCommand(
  options: PiBridgeOptions = DEFAULT_TLH_OPTIONS,
): ProviderInstallationCommand {
  const launch = resolvePiLaunch(process.env, options);
  const command = launch.command;
  const args = [...launch.args, "update"];
  return { command, args, displayCommand: formatCommand(command, args) };
}

export async function tlhInstallGuidance(
  options: PiBridgeOptions = DEFAULT_TLH_OPTIONS,
): Promise<string> {
  if (options.piFlavor === "tlh-main") {
    return `Install ${options.command} from a The Last Harness main build: ${TLH_REPO_URL}`;
  }
  const repo = await resolveTlhRepo(options);
  return `Install The Last Harness (tlh): ${tlhInstallerCommand(repo).displayCommand}`;
}

export async function getTlhInstallationStatus(
  checkUpdates: boolean,
  minimumSupportedVersion: string,
  options: PiBridgeOptions = DEFAULT_TLH_OPTIONS,
): Promise<ProviderInstallationStatus> {
  const launch = resolvePiLaunch(process.env, options);
  const [resolvedExecutable, versionJson, installState] = await Promise.all([
    resolveExecutablePath(launch.command),
    probeTlhVersionJson(options),
    readTlhInstallState(options),
  ]);
  const piVersion =
    (versionJson?.piVersion ? versionFrom(versionJson.piVersion) : null) ??
    (await probeTlhPiVersion(options));

  const repo = versionJson
    ? (versionJson.repo ?? DEFAULT_REPO)
    : (installState?.repo ?? DEFAULT_REPO);
  const track = versionJson ? versionJson.track : (installState?.track ?? null);
  const installed =
    resolvedExecutable !== null || versionJson !== null || piVersion !== null;
  const currentVersion = versionJson
    ? versionJson.tlhVersion !== null
      ? strictSemver(versionJson.tlhVersion)
      : null
    : installState !== null
      ? strictSemver(installState.ref)
      : null;
  const latestVersion =
    checkUpdates && options.piFlavor === "tlh" && track === "latest-release"
      ? await fetchTlhLatestRelease(repo)
      : null;

  let needsUpdate = false;
  try {
    needsUpdate =
      installed &&
      currentVersion !== null &&
      latestVersion !== null &&
      compareVersions(latestVersion, currentVersion) > 0;
  } catch {
    needsUpdate = false;
  }
  const versionUnsupported =
    installed &&
    piVersion !== null &&
    compareVersions(piVersion, minimumSupportedVersion) < 0;

  const installable = options.piFlavor === "tlh";
  const actionKind = !installed
    ? installable
      ? "install"
      : null
    : needsUpdate || versionUnsupported
      ? "update"
      : null;

  const installActionCommand =
    actionKind === "install"
      ? tlhInstallerCommand(repo).displayCommand
      : actionKind === "update"
        ? tlhUpdateCommand(options).displayCommand
        : null;

  const installAction: ProviderInstallationStatus["installAction"] =
    actionKind === null ||
    !checkUpdates ||
    installActionCommand === null ||
    (actionKind === "install" && process.platform === "win32")
      ? null
      : {
          kind: actionKind,
          label: actionKind === "install" ? "Install" : "Update",
          command: installActionCommand,
        };

  return {
    executableName: options.command,
    executablePath: resolvedExecutable,
    installed,
    installSource: "external",
    currentVersion,
    latestVersion,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction,
    needsUpdate,
    versionUnsupported,
  };
}

export async function tlhInstallationRun(
  status: ProviderInstallationStatus,
  action: "install" | "update",
  options: PiBridgeOptions = DEFAULT_TLH_OPTIONS,
): Promise<{
  command: ProviderInstallationCommand;
  verification: ProviderInstallationVerification;
}> {
  const repo = await resolveTlhRepo(options);
  const command =
    action === "install"
      ? tlhInstallerCommand(repo)
      : tlhUpdateCommand(options);
  let verification: ProviderInstallationVerification;
  if (action === "install") {
    verification = { kind: "installed" };
  } else if (status.needsUpdate && status.latestVersion !== null) {
    verification = { kind: "version_at_least", version: status.latestVersion };
  } else {
    verification = { kind: "installed" };
  }
  return { command, verification };
}
