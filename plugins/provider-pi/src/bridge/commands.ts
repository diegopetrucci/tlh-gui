import type { commandListResultSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { PiRpcChild, buildPiChildEnv } from "./rpc-child.js";

type CommandListResult = z.infer<typeof commandListResultSchema>;

const MAX_COMMANDS = 500;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_PAYLOAD_BYTES = 60 * 1024;
const GET_COMMANDS_TIMEOUT_MS = 15_000;
export const COMMAND_LIST_TTL_MS = 2 * 60_000;

const HIDDEN_COMMANDS: ReadonlySet<string> = new Set(["clear", "compact"]);
const LISTED_SOURCES: ReadonlySet<string> = new Set(["extension", "prompt"]);

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

const commandsEnvelopeSchema = z.object({ commands: z.array(z.unknown()) });

const reportedCommandSchema = z.object({
  name: z.string(),
  source: z.string(),
  description: z.string().catch(""),
});

export function toPiCommandList(data: unknown): CommandListResult {
  const reported = commandsEnvelopeSchema.parse(data).commands;
  const result: CommandListResult = { commands: [] };
  const seen = new Set<string>();
  let bytes = Buffer.byteLength(JSON.stringify(result));
  for (const entry of reported) {
    const parsed = reportedCommandSchema.safeParse(entry);
    if (!parsed.success || !LISTED_SOURCES.has(parsed.data.source)) {
      continue;
    }
    const { name: rawName, description } = parsed.data;
    const name = rawName.trim().replace(/^\//, "");
    if (name === "" || HIDDEN_COMMANDS.has(name) || seen.has(name)) {
      continue;
    }
    const command = {
      name,
      description: truncate(description.trim(), MAX_DESCRIPTION_LENGTH),
    };
    const entryBytes = Buffer.byteLength(JSON.stringify(command)) + 1;
    if (
      result.commands.length >= MAX_COMMANDS ||
      bytes + entryBytes > MAX_PAYLOAD_BYTES
    ) {
      break;
    }
    seen.add(name);
    result.commands.push(command);
    bytes += entryBytes;
  }
  return result;
}

export async function listPiCommands(
  cwd: string,
  extensionPath: string,
): Promise<CommandListResult> {
  const child = new PiRpcChild({
    cwd,
    env: buildPiChildEnv({}),
    args: ["--mode", "rpc", "--no-session", "--extension", extensionPath],
    onEvent: () => {},
    onChannelMessage: () => {},
    onExit: () => {},
    recordThreadId: null,
  });
  try {
    const data = await child.requestOk(
      { type: "get_commands" },
      GET_COMMANDS_TIMEOUT_MS,
    );
    return toPiCommandList(data);
  } finally {
    child.kill();
    await child.waitForExit().catch(() => undefined);
  }
}

interface PiCommandListMemoOptions {
  list: (cwd: string) => Promise<CommandListResult>;
  now?: () => number;
  ttlMs?: number;
}

export function createPiCommandListMemo({
  list,
  now = Date.now,
  ttlMs = COMMAND_LIST_TTL_MS,
}: PiCommandListMemoOptions): (cwd: string) => Promise<CommandListResult> {
  const settled = new Map<
    string,
    { result: CommandListResult; expiresAt: number }
  >();
  const pending = new Map<string, Promise<CommandListResult>>();
  return (cwd) => {
    const cached = settled.get(cwd);
    if (cached !== undefined && cached.expiresAt > now()) {
      return Promise.resolve(cached.result);
    }
    settled.delete(cwd);
    const inFlight = pending.get(cwd);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const probe = list(cwd)
      .then((result) => {
        settled.set(cwd, { result, expiresAt: now() + ttlMs });
        return result;
      })
      .finally(() => {
        if (pending.get(cwd) === probe) {
          pending.delete(cwd);
        }
      });
    pending.set(cwd, probe);
    return probe;
  };
}
