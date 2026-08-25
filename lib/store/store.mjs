import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { emptyStore } from "../config.mjs";
import { CURRENT_VERSION, migrate } from "./migrations.mjs";

export class Store {
  #filePath;
  #seedFn;
  #queue;

  constructor(filePath, { seedFn } = {}) {
    this.#filePath = filePath;
    this.#seedFn = typeof seedFn === "function" ? seedFn : () => emptyStore();
    this.#queue = Promise.resolve();
  }

  get filePath() {
    return this.#filePath;
  }

  async read() {
    return this.#enqueue(() => this.#load());
  }

  async update(mutator) {
    return this.#enqueue(async () => {
      const store = await this.#load();
      const result = await mutator(store);
      const next = result === undefined || result === null ? store : result;
      bumpRev(next);
      await this.#write(next);
      return next;
    });
  }

  async replace(newStore) {
    return this.#enqueue(async () => {
      const migrated = migrate(newStore);
      bumpRev(migrated);
      await this.#write(migrated);
      return migrated;
    });
  }

  #enqueue(task) {
    const run = this.#queue.then(task);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #load() {
    let raw;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch {
      return this.#seedAndWrite();
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.#backupBytes(raw, `corrupt-${Date.now()}`);
      return this.#seedAndWrite();
    }

    // Pre-migration backup: the first time an older-versioned (or version-less v1) file is
    // loaded, preserve its original bytes next to it. This is the rollback story for a
    // version bump — restore the backup, run the previous build.
    if (isPlainObject(parsed) && !(typeof parsed.version === "number" && parsed.version >= CURRENT_VERSION)) {
      const label = Number.isInteger(parsed.version) ? parsed.version : 1;
      await this.#backupBytes(raw, `v${label}.backup`, { once: true });
    }

    try {
      return migrate(parsed);
    } catch {
      await this.#backupBytes(raw, `corrupt-${Date.now()}`);
      return this.#seedAndWrite();
    }
  }

  // Copies original file bytes to `<filePath>.<label>.json`. With `once`, an existing backup
  // is never overwritten (flag "wx"). Backup failure must never block loading the store.
  async #backupBytes(raw, label, { once = false } = {}) {
    try {
      await writeFile(`${this.#filePath}.${label}.json`, raw, { encoding: "utf8", flag: once ? "wx" : "w" });
    } catch {
      // EEXIST for once-backups is the expected steady state; anything else is non-fatal.
    }
  }

  async #seedAndWrite() {
    const seeded = migrate(this.#seedFn());
    await this.#write(seeded);
    return seeded;
  }

  async #write(store) {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const tmpPath = `${this.#filePath}.tmp-${crypto.randomBytes(6).toString("hex")}`;
    await writeFile(tmpPath, JSON.stringify(store, null, 2), "utf8");

    try {
      await rename(tmpPath, this.#filePath);
    } catch (error) {
      if (!error || (error.code !== "EEXIST" && error.code !== "EPERM")) {
        await unlink(tmpPath).catch(() => {});
        throw error;
      }
      // Windows can refuse rename-over-existing; unlink the target and retry once.
      try {
        await unlink(this.#filePath).catch(() => {});
        await rename(tmpPath, this.#filePath);
      } catch (retryError) {
        await unlink(tmpPath).catch(() => {});
        throw retryError;
      }
    }
  }
}

// Every successful mutation increments the store-level revision counter. The server keys its
// decorate cache on it — recategorize, fulltext re-enrichment, deletes all invalidate via this
// one counter, and callers never manage it themselves. Future-version passthrough stores may
// be arbitrary objects; only bump when we can do so safely.
function bumpRev(store) {
  if (isPlainObject(store)) {
    store.rev = (Number.isInteger(store.rev) && store.rev >= 0 ? store.rev : 0) + 1;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
