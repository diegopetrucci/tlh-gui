import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPiCommandListMemo, toPiCommandList } from "./commands.js";
import { type FakePiBridgeHarness, startFakePiBridge } from "./test-support.js";

let harness: FakePiBridgeHarness;
let requestId = 0;

function nextRequestId(): number {
  requestId += 1;
  return requestId;
}

beforeEach(async () => {
  harness = await startFakePiBridge({
    prefix: "bb-pi-commands-",
    initialize: true,
  });
});

afterEach(async () => {
  await harness.teardown();
});

it("advertises commands/list", async () => {
  const response = await harness.request(nextRequestId(), "initialize", {
    protocolVersion: 2,
    client: { name: "test", version: "0" },
    grammarVersions: [3, 3],
  });
  expect(response.result).toMatchObject({
    capabilities: { commands: { list: true } },
  });
});

it("lists extension and prompt commands, without skills, clear, compact or duplicates", async () => {
  const response = await harness.request(nextRequestId(), "commands/list", {
    cwd: harness.workspaceDir,
  });
  expect(response.error).toBeUndefined();
  expect(response.result).toEqual({
    commands: [
      { name: "usage", description: "Show usage" },
      { name: "bare", description: "" },
      { name: "review", description: "Review changes" },
    ],
  });
}, 30_000);

it("memoizes per cwd and disposes the sessionless child", async () => {
  const processLog = join(harness.workspaceDir, "process.log");
  vi.stubEnv("FAKE_PI_PROCESS_LOG", processLog);
  const params = { cwd: harness.workspaceDir };
  const [first, second] = await Promise.all([
    harness.request(nextRequestId(), "commands/list", params),
    harness.request(nextRequestId(), "commands/list", params),
  ]);
  await harness.request(nextRequestId(), "commands/list", params);
  expect(second.result).toEqual(first.result);
  await vi.waitFor(() => {
    const lines = readFileSync(processLog, "utf8").split("\n");
    expect(lines.filter((line) => line.startsWith("spawn:"))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("exit:"))).toHaveLength(1);
  });
}, 30_000);

it("returns an error without crashing when get_commands fails", async () => {
  vi.stubEnv("FAKE_PI_GET_COMMANDS_FAILURE", "reject");
  const failed = await harness.request(nextRequestId(), "commands/list", {
    cwd: harness.workspaceDir,
  });
  expect(failed.error).toMatchObject({
    message: expect.stringContaining("get_commands failed"),
  });
  vi.stubEnv("FAKE_PI_GET_COMMANDS_FAILURE", undefined);
  const recovered = await harness.request(nextRequestId(), "commands/list", {
    cwd: harness.workspaceDir,
  });
  expect(recovered.error).toBeUndefined();
}, 30_000);

it("rejects a malformed get_commands envelope without caching it", async () => {
  vi.stubEnv("FAKE_PI_GET_COMMANDS_MALFORMED", "1");
  const failed = await harness.request(nextRequestId(), "commands/list", {
    cwd: harness.workspaceDir,
  });
  expect(failed.error).toBeDefined();
  vi.stubEnv("FAKE_PI_GET_COMMANDS_MALFORMED", undefined);
  const recovered = await harness.request(nextRequestId(), "commands/list", {
    cwd: harness.workspaceDir,
  });
  expect(recovered.error).toBeUndefined();
  expect(recovered.result).toMatchObject({
    commands: expect.arrayContaining([
      { name: "usage", description: "Show usage" },
    ]),
  });
}, 30_000);

it("bounds the number, length and payload of commands", () => {
  const reported = Array.from({ length: 800 }, (_, index) => ({
    name: `cmd-${index}`,
    description: "d".repeat(1_000),
    source: "extension",
  }));
  const { commands } = toPiCommandList({ commands: reported });
  expect(commands.length).toBeLessThanOrEqual(500);
  expect(commands.length).toBeGreaterThan(0);
  expect(commands[0]?.description.length).toBeLessThanOrEqual(300);
  expect(Buffer.byteLength(JSON.stringify({ commands }))).toBeLessThanOrEqual(
    60 * 1024,
  );
  expect(toPiCommandList({ commands: [] })).toEqual({ commands: [] });
  expect(
    toPiCommandList({
      commands: [null, { name: 3, source: "extension" }, { source: "prompt" }],
    }),
  ).toEqual({ commands: [] });
  expect(() => toPiCommandList(null)).toThrow();
});

it("expires memoized results after the TTL", async () => {
  let clock = 0;
  const list = vi.fn(async () => ({ commands: [] }));
  const memo = createPiCommandListMemo({ list, now: () => clock, ttlMs: 100 });
  await memo("/a");
  await memo("/a");
  expect(list).toHaveBeenCalledTimes(1);
  clock = 101;
  await memo("/a");
  expect(list).toHaveBeenCalledTimes(2);
});
