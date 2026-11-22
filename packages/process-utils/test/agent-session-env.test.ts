import { expect, it } from "vitest";
import { stripAgentSessionEnv } from "../src/index.js";

it("removes inherited agent-session keys and keeps user config", () => {
  const input: NodeJS.ProcessEnv = {
    TICKETS_DIR: "/t",
    TLH_TICKETS_DIR_AUTO: "1",
    PI_SESSION_ID: "s",
    PI_SESSION_FILE: "/f",
    PI_BB_TOOLS_FILE: "/b",
    PI_SUBAGENT_CHILD: "1",
    PI_SUBAGENT_RUN_ID: "r",
    PI_SUBAGENT_PARENT_CAPABILITY_TOKEN: "x",
    PI_SUBAGENT_PI_BINARY: "/bin/pi",
    PI_CODING_AGENT_DIR: "/agent",
    TLH_PROGRAM_STATUS: "ok",
    PATH: "/usr/bin",
  };
  const snapshot = { ...input };
  const result = stripAgentSessionEnv(input);
  expect(result).toEqual({
    PI_SUBAGENT_PI_BINARY: "/bin/pi",
    PI_CODING_AGENT_DIR: "/agent",
    TLH_PROGRAM_STATUS: "ok",
    PATH: "/usr/bin",
  });
  expect(input).toEqual(snapshot);
});

it("drops MCP_DIRECT_TOOLS only when it is __none__", () => {
  expect(
    stripAgentSessionEnv({ MCP_DIRECT_TOOLS: "__none__" }).MCP_DIRECT_TOOLS,
  ).toBeUndefined();
  expect(
    stripAgentSessionEnv({ MCP_DIRECT_TOOLS: "server/tool" }).MCP_DIRECT_TOOLS,
  ).toBe("server/tool");
});
