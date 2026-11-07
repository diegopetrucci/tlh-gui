import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrations, type Db } from "./data.js";
import { ingestLegacyImport } from "./legacy-import.js";
import { relabelPiProviderToTlh } from "./tlh-provider-relabel.js";

function createDb(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const migration of migrations) db.exec(migration);
  return db;
}

function createBb() {
  const kv = new Map<string, unknown>();
  return {
    kv,
    bb: {
      storage: {
        kv: {
          get: async <T>(key: string) => kv.get(key) as T | undefined,
          set: async (key: string, value: unknown) => {
            kv.set(key, value);
          },
        },
      },
      log: { info: () => undefined },
    },
  };
}

function insert(db: Db, id: string, execution: string) {
  db.prepare(
    `INSERT INTO automations (
       id, project_id, name, enabled, trigger_type, trigger_config, run_mode,
       execution, origin, run_count, created_at, updated_at
     ) VALUES (?, 'proj', 'n', 1, 'schedule', '{}', 'agent', ?, 'human', 0, 1, 1)`,
  ).run(id, execution);
}

function execution(db: Db, id: string): string {
  return (
    db.prepare("SELECT execution FROM automations WHERE id = ?").get(id) as {
      execution: string;
    }
  ).execution;
}

const piExecution = JSON.stringify({
  mode: "agent",
  prompt: "p",
  providerId: "pi",
  model: "m",
  permissionMode: "readonly",
});

describe("relabelPiProviderToTlh", () => {
  it("relabels only pi executions, preserving other fields and key order", async () => {
    const db = createDb();
    const other = JSON.stringify({ mode: "agent", providerId: "claude" });
    const script = JSON.stringify({ mode: "script", command: "echo pi" });
    insert(db, "a", piExecution);
    insert(db, "b", other);
    insert(db, "c", script);
    const { bb, kv } = createBb();

    await relabelPiProviderToTlh({ bb, db });

    expect(execution(db, "a")).toBe(
      JSON.stringify({ ...JSON.parse(piExecution), providerId: "tlh" }),
    );
    expect(execution(db, "b")).toBe(other);
    expect(execution(db, "c")).toBe(script);
    expect(kv.get("tlh-provider-id-relabel-done")).toBe(true);
  });

  it("is idempotent: pi rows created after the marker stay pi", async () => {
    const db = createDb();
    const { bb } = createBb();
    await relabelPiProviderToTlh({ bb, db });
    insert(db, "late", piExecution);

    await relabelPiProviderToTlh({ bb, db });

    expect(execution(db, "late")).toBe(piExecution);
  });

  it("sets only the marker on a fresh install", async () => {
    const db = createDb();
    const { bb, kv } = createBb();

    await relabelPiProviderToTlh({ bb, db });

    expect(db.prepare("SELECT COUNT(*) AS n FROM automations").get()).toEqual({
      n: 0,
    });
    expect(kv.get("tlh-provider-id-relabel-done")).toBe(true);
  });

  it("relabels rows brought in by a pending legacy import when run after it", async () => {
    const db = createDb();
    const pluginDataDir = await mkdtemp(join(tmpdir(), "bb-auto-relabel-"));
    try {
      await mkdir(join(pluginDataDir, "import"), { recursive: true });
      await writeFile(
        join(pluginDataDir, "import", "legacy-automations.json"),
        JSON.stringify({
          automations: [
            {
              id: "auto_legacy",
              projectId: "proj",
              targetThreadId: null,
              name: "legacy",
              enabled: true,
              triggerType: "schedule",
              triggerConfig: JSON.stringify({
                triggerType: "schedule",
                cron: "0 9 * * *",
                timezone: "UTC",
              }),
              runMode: "agent",
              execution: piExecution,
              environment: JSON.stringify({ type: "project-default" }),
              autoArchive: false,
              origin: "human",
              createdByThreadId: null,
              nextRunAt: 1000,
              lastRunAt: null,
              runCount: 0,
              lastRunStatus: null,
              lastRunThreadId: null,
              lastError: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          runs: [],
          scripts: {},
        }),
      );
      const { bb } = createBb();

      await ingestLegacyImport({ bb, db, pluginDataDir });
      await relabelPiProviderToTlh({ bb, db });

      expect(JSON.parse(execution(db, "auto_legacy"))).toMatchObject({
        providerId: "tlh",
      });
    } finally {
      await rm(pluginDataDir, { recursive: true, force: true });
    }
  });
});
