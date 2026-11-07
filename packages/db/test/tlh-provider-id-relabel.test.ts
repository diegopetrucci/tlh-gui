import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConnection,
  createProject,
  createThread,
  migrate,
  noopNotifier,
  upsertHost,
  type DbConnection,
} from "../src/index.js";
import { createMigratedConnection } from "../src/testing.js";

const MARKER_KEY = "tlhProviderIdRelabelCompletedAt";

interface ProviderIdRow {
  providerId: string | null;
}

interface SettingRow {
  value: string;
}

const tempDirs: string[] = [];
const openConnections: DbConnection[] = [];

afterEach(() => {
  for (const db of openConnections.splice(0)) {
    if (db.$client.open) db.$client.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function track(db: DbConnection): DbConnection {
  openConnections.push(db);
  return db;
}

function clearMarker(db: DbConnection): void {
  db.$client
    .prepare("DELETE FROM app_settings_values WHERE key = ?")
    .run(MARKER_KEY);
}

function markerRowCount(db: DbConnection): number {
  return db.$client
    .prepare("SELECT 1 FROM app_settings_values WHERE key = ?")
    .all(MARKER_KEY).length;
}

function setSetting(db: DbConnection, key: string, value: unknown): void {
  db.$client
    .prepare(
      `INSERT INTO app_settings_values (key, value, updated_at) VALUES (?, ?, 1)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

function readSetting(db: DbConnection, key: string): unknown {
  const row = db.$client
    .prepare<
      [string],
      SettingRow
    >("SELECT value FROM app_settings_values WHERE key = ?")
    .get(key);
  return row === undefined ? undefined : JSON.parse(row.value);
}

function threadProviderIds(db: DbConnection): Array<string | null> {
  return db.$client
    .prepare<[], ProviderIdRow>(
      "SELECT provider_id AS providerId FROM threads ORDER BY id",
    )
    .all()
    .map((row) => row.providerId);
}

function seedLegacyData(db: DbConnection): {
  threadId: string;
  eventData: string;
} {
  const host = upsertHost(db, noopNotifier, { name: "relabel-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "relabel-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/relabel" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "pi",
  });
  const eventData = JSON.stringify({
    interaction: { providerId: "pi" },
  });
  db.$client
    .prepare(
      `INSERT INTO events (id, thread_id, scope_kind, sequence, type, data, created_at)
       VALUES ('evt_relabel', ?, 'thread', 1000, 'system/interaction/lifecycle', ?, 1)`,
    )
    .run(thread.id, eventData);
  db.$client
    .prepare(
      `INSERT INTO project_execution_defaults
        (project_id, provider_id, model, service_tier, reasoning_level, permission_mode, updated_at)
       VALUES (?, 'pi', 'm', 'default', 'medium', 'default', 1)`,
    )
    .run(project.id);
  db.$client
    .prepare(
      `INSERT INTO pending_interactions
        (id, thread_id, origin_kind, provider_id, provider_thread_id, provider_request_id, status, payload, created_at, updated_at)
       VALUES ('pi_1', ?, 'provider', 'pi', 'pt', 'req', 'pending', '{}', 1, 1)`,
    )
    .run(thread.id);
  const insertCatalog = db.$client.prepare(
    `INSERT INTO provider_model_catalogs
      (host_id, provider_id, scope_key, fingerprint, models_json, selected_only_models_json, fetched_at)
     VALUES (?, ?, 's', 'f', '[]', '[]', 1)`,
  );
  insertCatalog.run(host.id, "pi");
  insertCatalog.run(host.id, "codex");
  setSetting(db, "providerOrder", ["codex", "pi", "tlh", "pi"]);
  setSetting(db, "defaultProviderId", "pi");
  setSetting(db, "disabledProviderIds", ["pi", "claude"]);
  setSetting(db, "providerCompletedTurnDisplay", {
    pi: "collapsed",
    codex: "expanded",
  });
  return { threadId: thread.id, eventData };
}

describe("tlh provider id relabel", () => {
  it("relabels legacy pi data once, drops catalogs, dedupes settings, keeps events", () => {
    const db = track(createMigratedConnection());
    const { threadId, eventData } = seedLegacyData(db);
    clearMarker(db);

    migrate(db);

    expect(threadProviderIds(db)).toEqual(["tlh"]);
    expect(
      db.$client
        .prepare("SELECT provider_id FROM project_execution_defaults")
        .all(),
    ).toEqual([{ provider_id: "tlh" }]);
    expect(
      db.$client.prepare("SELECT provider_id FROM pending_interactions").all(),
    ).toEqual([{ provider_id: "tlh" }]);
    expect(
      db.$client
        .prepare("SELECT provider_id FROM provider_model_catalogs")
        .all(),
    ).toEqual([{ provider_id: "codex" }]);
    expect(readSetting(db, "providerOrder")).toEqual(["codex", "tlh"]);
    expect(readSetting(db, "defaultProviderId")).toBe("tlh");
    expect(readSetting(db, "disabledProviderIds")).toEqual(["tlh", "claude"]);
    expect(readSetting(db, "providerCompletedTurnDisplay")).toEqual({
      codex: "expanded",
      tlh: "collapsed",
    });
    expect(
      db.$client
        .prepare("SELECT data FROM events WHERE id = 'evt_relabel'")
        .get(),
    ).toEqual({ data: eventData });
    expect(markerRowCount(db)).toBe(1);

    db.$client
      .prepare("UPDATE threads SET provider_id = 'pi' WHERE id = ?")
      .run(threadId);
    migrate(db);
    expect(threadProviderIds(db)).toEqual(["pi"]);
  });

  it("prefers an existing tlh completed-turn display over the legacy pi value", () => {
    const db = track(createMigratedConnection());
    setSetting(db, "providerCompletedTurnDisplay", {
      pi: "collapsed",
      tlh: "expanded",
    });
    clearMarker(db);
    migrate(db);
    expect(readSetting(db, "providerCompletedTurnDisplay")).toEqual({
      tlh: "expanded",
    });
  });

  it("only sets the marker on a fresh install and leaves later pi rows alone", () => {
    const db = track(createConnection(":memory:"));
    migrate(db);
    expect(markerRowCount(db)).toBe(1);

    const host = upsertHost(db, noopNotifier, { name: "fresh-host" });
    const { project } = createProject(db, noopNotifier, {
      name: "fresh-project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/fresh" },
    });
    createThread(db, noopNotifier, { projectId: project.id, providerId: "pi" });
    migrate(db);
    expect(threadProviderIds(db)).toEqual(["pi"]);
  });

  it("backs up an on-disk database with legacy data without overwriting backups", () => {
    const dir = mkdtempSync(join(tmpdir(), "tlh-relabel-"));
    tempDirs.push(dir);
    const path = join(dir, "bb.db");
    const backup = `${path}.pre-tlh-provider-ids.bak`;

    const first = track(createConnection(path));
    migrate(first);
    expect(existsSync(backup)).toBe(false);
    seedLegacyData(first);
    clearMarker(first);
    migrate(first);
    expect(existsSync(backup)).toBe(true);
    expect(threadProviderIds(first)).toEqual(["tlh"]);

    const backupDb = track(createConnection(backup));
    expect(threadProviderIds(backupDb)).toEqual(["pi"]);
    backupDb.$client.close();

    first.$client.prepare("UPDATE threads SET provider_id = 'pi'").run();
    clearMarker(first);
    migrate(first);
    expect(existsSync(`${backup}.1`)).toBe(true);
    const originalBackup = track(createConnection(backup));
    expect(threadProviderIds(originalBackup)).toEqual(["pi"]);
  });

  it("does not create a backup on disk when there is nothing to relabel", () => {
    const dir = mkdtempSync(join(tmpdir(), "tlh-relabel-"));
    tempDirs.push(dir);
    const path = join(dir, "bb.db");
    const db = track(createConnection(path));
    migrate(db);
    clearMarker(db);
    migrate(db);
    expect(markerRowCount(db)).toBe(1);
    expect(existsSync(`${path}.pre-tlh-provider-ids.bak`)).toBe(false);
  });
});
