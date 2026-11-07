import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Db } from "./data.js";

const TLH_PROVIDER_RELABEL_DONE_KEY = "tlh-provider-id-relabel-done";

type RelabelApi = {
  storage: {
    kv: Pick<BbPluginApi["storage"]["kv"], "get" | "set">;
  };
  log: Pick<BbPluginApi["log"], "info">;
};

export async function relabelPiProviderToTlh(args: {
  bb: RelabelApi;
  db: Db;
}): Promise<void> {
  const done = await args.bb.storage.kv.get<boolean>(
    TLH_PROVIDER_RELABEL_DONE_KEY,
  );
  if (done === true) return;

  const relabeled = args.db.transaction(
    () =>
      args.db
        .prepare(
          `UPDATE automations
           SET execution = json_set(execution, '$.providerId', 'tlh')
           WHERE json_valid(execution)
             AND json_extract(execution, '$.providerId') = 'pi'`,
        )
        .run().changes,
  )();

  await args.bb.storage.kv.set(TLH_PROVIDER_RELABEL_DONE_KEY, true);
  if (relabeled > 0) {
    args.bb.log.info(
      `Relabeled ${relabeled} automations from provider pi to tlh`,
    );
  }
}
