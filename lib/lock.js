/**
 * The explicit task lock the context operations share.
 *
 * The log already carries a compaction lock (`compaction/start` without its
 * `end`), and that one is authoritative for "is a compaction running". This
 * lock is the cross-operation, cross-process guard: two windows against the
 * same profile share this file, so a clear in one window refuses a compact
 * in the other instead of racing it, and the status route can answer "this
 * session is busy" without touching the agent at all.
 *
 * Every lock carries the timestamp it was taken and expires on its own. A
 * crashed window leaves a stale entry, and expiry is what keeps that from
 * locking the session forever; the cleanup on every read doubles as the
 * residual sweep the stale entry would otherwise need.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { storageDirOf } from "./store.js";

/** How long one task may hold a lock before it is presumed dead. */
export const LOCK_TTL_MS = 15 * 60_000;

/**
 * File-backed advisory locks over the context operations.
 */
export class TaskLocks {
  /**
   * @param ctx - host plugin context, for the storage directory and logger.
   * @param options - `ttlMs` overrides the expiry window.
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.path = join(storageDirOf(ctx), "locks.json");
    this.ttlMs = options.ttlMs ?? LOCK_TTL_MS;
    this.owner = `w${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    /** One in-flight file operation at a time, so read-modify-write settles. */
    this.queue = Promise.resolve();
  }

  /**
   * Run one read-modify-write against the lock file, serialized per instance.
   * @param mutate - receives the live map, may change it, returns a result.
   * @returns whatever `mutate` returned.
   */
  _update(mutate) {
    const run = this.queue.then(async () => {
      const map = await this._read();
      const result = await mutate(map);
      await this._write(map);
      return result;
    });
    // A failed operation must not poison every later one.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Read the lock file, dropping entries whose expiry has passed. */
  async _read() {
    let text;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return {};
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {};
    }
    const now = Date.now();
    const map = {};
    for (const [key, entry] of Object.entries(parsed ?? {})) {
      if (typeof entry?.at !== "number" || now - entry.at > this.ttlMs)
        continue;
      map[key] = entry;
    }
    return map;
  }

  /** Persist the map atomically; a failure only costs visibility, not data. */
  async _write(map) {
    try {
      await mkdir(join(this.path, ".."), { recursive: true });
      const staged = `${this.path}.tmp`;
      await writeFile(staged, `${JSON.stringify(map)}\n`, "utf8");
      await rename(staged, this.path);
    } catch (error) {
      this.ctx.logger?.warn?.(
        `dsh-token-panorama: could not write the task lock: ${String(error)}`,
      );
    }
  }

  /**
   * Take the lock for one key, unless another live owner holds it.
   * @param key - the lock's key, one per session.
   * @returns true when this caller now holds it.
   */
  async acquire(key) {
    return this._update((map) => {
      const held = map[key];
      if (held !== undefined && held.owner !== this.owner) return false;
      map[key] = { owner: this.owner, at: Date.now() };
      return true;
    });
  }

  /**
   * Release a lock this caller holds.
   * @param key - the lock's key.
   * @returns true when the entry was removed (or already gone).
   */
  async release(key) {
    return this._update((map) => {
      const held = map[key];
      if (held === undefined) return true;
      if (held.owner !== this.owner) return false;
      delete map[key];
      return true;
    });
  }

  /**
   * Every live lock, expiry already applied. This is what the status route
   * reports, so a second window can see a task a first window is running.
   * @returns `{key, at, ageMs}`` per held lock.
   */
  async status() {
    return this._update((map) =>
      Object.entries(map).map(([key, entry]) => ({
        key,
        at: entry.at,
        ageMs: Date.now() - entry.at,
        mine: entry.owner === this.owner,
      })),
    );
  }
}
