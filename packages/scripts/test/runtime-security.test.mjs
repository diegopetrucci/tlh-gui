import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");
const shell = source("apps/server/src/assets/install-machine.sh");
const windows = source("apps/server/src/assets/install-machine-windows.mjs");
const cli = source("apps/cli/src/commands/server-machine-service.ts");
const gates = [
  shell.match(/node_supported=\$\(node -e '([\s\S]*?)' && echo yes/)[1],
  windows.match(
    /(const \[major, minor, patch\][\s\S]*?)\n  if \(!supported\)/,
  )[1] + "\nprocess.exit(supported ? 0 : 1);",
  "const version = process.versions.node;" +
    cli
      .match(
        /function supportsServiceNode\(version: string\): boolean \{([\s\S]*?)\n\}/,
      )[1]
      .replace("return ", "const supported = ") +
    "\nprocess.exit(supported ? 0 : 1);",
];

it.each([
  ["20.18.1", false],
  ["22.19.0", false],
  ["22.23.3", false],
  ["22.23.4", true],
  ["22.24.0", true],
  ["23.11.0", false],
  ["24.22.0", false],
  ["24.22.1", true],
  ["24.23.0", true],
  ["25.0.0", false],
  ["26.12.0", false],
  ["26.12.1", true],
  ["26.13.0", true],
  ["27.0.0", true],
])(
  "machine runtime gates classify Node %s as supported=%s",
  (version, supported) => {
    for (const gate of gates) {
      let exitCode;
      runInNewContext(gate, {
        process: {
          versions: { node: version },
          exit: (code) => {
            exitCode = code;
          },
        },
      });
      expect(exitCode, gate).toBe(supported ? 0 : 1);
    }
  },
);

it("keeps source and npm engine floors aligned with the primary runtime", () => {
  expect(source(".nvmrc").trim()).toBe("22.23.4");
  expect(JSON.parse(source("package.json")).engines.node).toBe(
    "^22.23.4 || ^24.22.1 || >=26.12.1",
  );
  expect(JSON.parse(source("packages/bb-app/package.json")).engines.node).toBe(
    "^22.23.4 || ^24.22.1 || ^26.12.1",
  );
});
