// Persistence layer for Beast Steps backend state (sign-in nonces, sessions,
// and per-user day batches of steps).
//
// The HTTP server keeps its working state in Maps; this module owns the
// conversion to/from a plain JSON-serializable shape and all storage I/O.
//
// Backend selection (see createStoreFromEnv), in priority order:
//   1. PostgreSQL via DATABASE_URL — designed for Neon (serverless Postgres,
//      free tier does not expire; Render's own free Postgres expires after
//      30 days, which is why Neon was chosen). The whole state lives in one
//      JSONB row: more than enough at this scale, and trivially inspectable.
//   2. JSON file via DATA_FILE — atomic writes (write tmp + rename), for
//      local development and tests.
//   3. In-memory — no persistence; the historical default, still used by the
//      unit/e2e tests.
//
// save() is awaited by the server before it answers mutating requests, so a
// completed response means the write has been handed to the storage driver.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export function emptyState() {
  return { nonces: new Map(), sessions: new Map(), userState: new Map() };
}

export function stateToJson(state) {
  return {
    version: 1,
    nonces: [...state.nonces.entries()],
    sessions: [...state.sessions.entries()],
    users: [...state.userState.entries()].map(([address, user]) => [
      address,
      { days: [...user.days.entries()] },
    ]),
  };
}

export function stateFromJson(json) {
  const state = emptyState();
  if (!json || typeof json !== "object") return state;
  for (const [key, value] of json.nonces ?? []) state.nonces.set(key, value);
  for (const [key, value] of json.sessions ?? []) state.sessions.set(key, value);
  for (const [address, user] of json.users ?? []) {
    state.userState.set(address, { days: new Map(user?.days ?? []) });
  }
  return state;
}

export class MemoryStore {
  kind = "memory";
  async load() {
    return emptyState();
  }
  async save() {}
  async close() {}
}

export class FileStore {
  kind = "file";
  #path;
  #queue = Promise.resolve();

  constructor(path) {
    this.#path = path;
  }

  async load() {
    let text;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return emptyState();
      throw e;
    }
    return stateFromJson(JSON.parse(text));
  }

  save(state) {
    // Serialize writes so concurrent requests cannot interleave tmp files.
    const run = this.#queue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(stateToJson(state)));
      await rename(tmp, this.#path); // atomic replace on the same filesystem
    });
    this.#queue = run.catch(() => {}); // one failed write must not jam the queue
    return run;
  }

  async close() {
    await this.#queue;
  }
}

export class PostgresStore {
  kind = "postgres";
  #connectionString;
  #pool = null;

  constructor(connectionString) {
    this.#connectionString = connectionString;
  }

  async #connect() {
    if (this.#pool) return this.#pool;
    // Loaded lazily so file/memory setups never need the pg package.
    const { default: pg } = await import("pg");
    const cs = this.#connectionString;
    const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])/.test(cs);
    this.#pool = new pg.Pool({
      connectionString: cs,
      max: 2,
      // Neon (and most hosted Postgres) requires TLS.
      ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
    });
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS beast_steps_state (
        id integer PRIMARY KEY,
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    return this.#pool;
  }

  async load() {
    const pool = await this.#connect();
    const { rows } = await pool.query("SELECT state FROM beast_steps_state WHERE id = 1");
    if (!rows.length) return emptyState();
    return stateFromJson(rows[0].state);
  }

  async save(state) {
    const pool = await this.#connect();
    await pool.query(
      `INSERT INTO beast_steps_state (id, state, updated_at) VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [JSON.stringify(stateToJson(state))],
    );
  }

  async close() {
    if (this.#pool) {
      await this.#pool.end();
      this.#pool = null;
    }
  }
}

export function createStoreFromEnv(env = process.env) {
  if (env.DATABASE_URL) return new PostgresStore(env.DATABASE_URL);
  if (env.DATA_FILE) return new FileStore(env.DATA_FILE);
  return new MemoryStore();
}
