// Pluggable persistence for recorded errors. The default is Deno KV; swap in
// your own (Firestore, Postgres, …) by implementing this two-method interface.

export interface StoredError {
  id: string; // unique row key
  ref: string; // optional caller-supplied identifier (order id, job id, …)
  step: string; // where it happened
  error: string; // the message
  ts: number; // epoch ms when recorded
}

export interface Store {
  /** Persist a row. `expireInMs` is a retention hint the backend should honor. */
  put(record: StoredError, opts: { expireInMs: number }): Promise<void>;
  /** Return all live (non-expired) rows. Filtering/sorting is done by the caller. */
  list(): Promise<StoredError[]>;
}

/** Deno KV-backed store (default). Rows auto-expire via KV's native `expireIn`. */
export function kvStore(kv: Deno.Kv, prefix = "canary-errors"): Store {
  return {
    async put(rec, { expireInMs }) {
      await kv.set([prefix, rec.id], rec, { expireIn: expireInMs });
    },
    async list() {
      const out: StoredError[] = [];
      for await (const e of kv.list<StoredError>({ prefix: [prefix] })) {
        if (e.value) out.push(e.value);
      }
      return out;
    },
  };
}

/** In-memory store — for tests or ephemeral processes. Honors expiry on read. */
export function memoryStore(): Store {
  const rows = new Map<string, { rec: StoredError; expiresAt: number }>();
  return {
    put(rec, { expireInMs }) {
      rows.set(rec.id, { rec, expiresAt: Date.now() + expireInMs });
      return Promise.resolve();
    },
    list() {
      const now = Date.now();
      const out: StoredError[] = [];
      for (const [id, { rec, expiresAt }] of rows) {
        if (expiresAt <= now) {
          rows.delete(id);
          continue;
        }
        out.push(rec);
      }
      return Promise.resolve(out);
    },
  };
}
