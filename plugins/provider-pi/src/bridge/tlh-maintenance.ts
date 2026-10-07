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
import { resolvePiLaunch } from "./rpc-child.js";

const execFileAsync = promisify(execFile);

const TLH_VERSION_PROBE_TIMEOUT_MS = 15_000;
const GITHUB_RELEASES_TIMEOUT_MS = 10_000;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const DEFAULT_REPO = "diegopetrucci/the-last-harness";

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

export type TlhInstallState = z.infer<typeof installStateSchema>;

export function isTlhMode(): boolean {
  const base = path.basename(resolvePiLaunch(process.env).command);
  return base === "tlh" || base === "tlh.exe";
}

function agentDir(): string {
  const envDir = process.env["PI_CODING_AGENT_DIR"];
  if (envDir) return envDir;
  return path.join(os.homedir(), ".the-last-harness", "agent");
}

export async function readTlhInstallState(): Promise<TlhInstallState | null> {
  const stateFile = path.join(agentDir(), "tlh", "install-state.json");
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

async function probeTlhPiVersion(): Promise<string | null> {
  const launch = resolvePiLaunch(process.env);
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

export function tlhInstallerCommand(repo: string = DEFAULT_REPO): ProviderInstallationCommand {
  const url = `https://github.com/${repo}/releases/latest/download/install.sh`;
  return downloadedInstallerCommand(url);
}

export function tlhUpdateCommand(): ProviderInstallationCommand {
  const launch = resolvePiLaunch(process.env);
  const command = launch.command;
  const args = [...launch.args, "update"];
  return { command, args, displayCommand: formatCommand(command, args) };
}

export async function tlhInstallGuidance(): Promise<string> {
  const state = await readTlhInstallState();
  const repo = state?.repo ?? DEFAULT_REPO;
  return `Install The Last Harness (tlh): ${tlhInstallerCommand(repo).displayCommand}`;
}

export async function getTlhInstallationStatus(
  checkUpdates: boolean,
  minimumSupportedVersion: string,
): Promise<ProviderInstallationStatus> {
  const launch = resolvePiLaunch(process.env);
  const [resolvedExecutable, piVersion, installState] = await Promise.all([
    resolveExecutablePath(launch.command),
    probeTlhPiVersion(),
    readTlhInstallState(),
  ]);

  const repo = installState?.repo ?? DEFAULT_REPO;
  const installed = resolvedExecutable !== null || piVersion !== null;
  const currentVersion =
    installState !== null ? strictSemver(installState.ref) : null;
  const latestVersion =
    checkUpdates && installState?.track === "latest-release"
      ? await fetchTlhLatestRelease(installState.repo)
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

  const actionKind = !installed
    ? "install"
    : needsUpdate || versionUnsupported
      ? "update"
      : null;

  const installActionCommand =
    actionKind === "install"
      ? tlhInstallerCommand(repo).displayCommand
      : actionKind === "update"
        ? tlhUpdateCommand().displayCommand
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
    executableName: "tlh",
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
): Promise<{
  command: ProviderInstallationCommand;
  verification: ProviderInstallationVerification;
}> {
  const installState = await readTlhInstallState();
  const repo = installState?.repo ?? DEFAULT_REPO;
  const command =
    action === "install" ? tlhInstallerCommand(repo) : tlhUpdateCommand();
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

export function tlhNotInstalledMessage(): string {
  return isTlhMode()
    ? "Could not find the tlh CLI on this host. Install The Last Harness from https://github.com/diegopetrucci/the-last-harness and retry."
    : "Could not find the pi CLI on this host. Install @earendil-works/pi-coding-agent and retry.";
}

export function piLoginCommand(): string {
  return isTlhMode() ? "tlh" : "pi";
}
