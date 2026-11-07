import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  experimental_filterResolvedNativeRoots,
  type ExperimentalNativeRootsResolveAnswer,
} from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import {
  PI_BRIDGE_OPTIONS_BY_FLAVOR,
  type PiFlavor,
} from "./bridge-options.js";

const DEFAULT_PI_AGENT_DIR = ".pi/agent";

function defaultAgentDirRelativeToHome(flavor: PiFlavor): string {
  const agentDir = PI_BRIDGE_OPTIONS_BY_FLAVOR[flavor].agentDir;
  return agentDir === undefined
    ? DEFAULT_PI_AGENT_DIR
    : agentDir.replace(/^~\//u, "");
}

export function piNativeRootsDeclaration(
  flavor: PiFlavor,
): Pick<
  PluginProviderDeclaration,
  "experimental_nativeSkillRoots" | "experimental_resolvesNativeRoots"
> {
  return {
    experimental_nativeSkillRoots: {
      user: [
        {
          path: `${defaultAgentDirRelativeToHome(flavor)}/skills`,
          recursive: true,
        },
        { path: ".agents/skills", recursive: true },
      ],
      project: [
        { path: ".pi/skills", recursive: true },
        { path: ".agents/skills", recursive: true, ancestors: true },
      ],
    },
    experimental_resolvesNativeRoots: true,
  };
}

export const PI_NATIVE_ROOTS_DECLARATION = piNativeRootsDeclaration("pi");

const piSettingsSchema = z
  .object({ skills: z.array(z.string()).optional() })
  .passthrough();

export interface ResolvePiNativeRootsArgs {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  flavor?: PiFlavor;
}

function defaultAgentDir(args: ResolvePiNativeRootsArgs): string {
  return path.join(
    args.homeDir,
    ...defaultAgentDirRelativeToHome(args.flavor ?? "pi").split("/"),
  );
}

function resolvePiAgentDir(args: ResolvePiNativeRootsArgs): string {
  if ((args.flavor ?? "pi") !== "pi") return defaultAgentDir(args);
  const configured = args.env.PI_CODING_AGENT_DIR?.trim();
  return configured
    ? resolveStoredPath(args.homeDir, configured, args.homeDir)
    : defaultAgentDir(args);
}

function resolveStoredPath(
  homeDir: string,
  value: string,
  baseDir: string,
): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function isPlainSkillSource(value: string): boolean {
  return !/^(?:npm:|git:|https?:\/\/|git@)/u.test(value);
}

export async function resolvePiNativeRoots(
  args: ResolvePiNativeRootsArgs,
): Promise<ExperimentalNativeRootsResolveAnswer> {
  const agentDir = resolvePiAgentDir(args);
  const roots = new Set<string>();
  if (agentDir !== defaultAgentDir(args)) {
    roots.add(path.resolve(agentDir, "skills"));
  }
  let settings: z.infer<typeof piSettingsSchema> | null = null;
  try {
    settings = piSettingsSchema.parse(
      JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")),
    );
  } catch {
    settings = null;
  }
  for (const raw of settings?.skills ?? []) {
    const value = raw.trim();
    if (
      value.length === 0 ||
      value.startsWith("!") ||
      !isPlainSkillSource(value)
    ) {
      continue;
    }
    if (path.extname(value).toLowerCase() === ".md") {
      continue;
    }
    roots.add(path.resolve(resolveStoredPath(args.homeDir, value, agentDir)));
  }
  return {
    skills: experimental_filterResolvedNativeRoots(
      {
        skills: [...roots].sort().map((rootPath) => ({
          path: rootPath,
          origin: "user" as const,
          recursive: true,
          shape: "skills" as const,
        })),
      },
      { warn: console.warn },
    ).answer.skills,
  };
}
