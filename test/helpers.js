import { createRequire } from "node:module";
import { loadSqlJs, _resetSqlJs, SqliteDb } from "../src/adapters/storage/sqlite-db.js";

const require = createRequire(import.meta.url);

/** Point the store's sql.js loader at the Node build. */
export async function useNodeSqlJs() {
  _resetSqlJs();
  globalThis.initSqlJs = require("sql.js");
  await loadSqlJs();
}

export const openDb = (bytes = null) => SqliteDb.open(bytes);

/**
 * A fetch stand-in backed by an in-memory file map, behaving like the parts of
 * the GitHub Contents API this app uses -- including sha checking, so conflict
 * handling is exercised for real rather than simulated.
 */
export function fakeGitHub({ files = new Map() } = {}) {
  let sha = 0;
  const nextSha = () => `sha${++sha}`;
  const calls = [];

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? "GET", url: u.pathname });

    const m = u.pathname.match(/\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (!m) return json({ message: "Not Found" }, 404);
    const path = decodeURIComponent(m[3]);

    if ((init.method ?? "GET") === "GET") {
      const f = files.get(path);
      if (!f) return json({ message: "Not Found" }, 404);
      return json({
        type: "file",
        encoding: "base64",
        size: f.bytes.length,
        path,
        sha: f.sha,
        // GitHub wraps base64 at 60 columns; reproduce that so the client's
        // whitespace stripping is actually tested.
        content: Buffer.from(f.bytes).toString("base64").replace(/(.{60})/g, "$1\n"),
      });
    }

    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      const existing = files.get(path);
      if (existing && body.sha !== existing.sha) {
        return json({ message: "does not match" }, 409);
      }
      if (!existing && body.sha) return json({ message: "not found" }, 422);
      const rec = { bytes: Buffer.from(body.content, "base64"), sha: nextSha() };
      files.set(path, rec);
      return json({ content: { sha: rec.sha }, commit: { sha: `commit-${rec.sha}` } });
    }
    return json({ message: "Not Found" }, 404);
  };

  return { fetchImpl, files, calls, nextSha };
}

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Simulate another device pushing a change to the shared file. */
export async function remoteWrite(gh, path, mutate) {
  const cur = gh.files.get(path);
  const db = await openDb(cur ? new Uint8Array(cur.bytes) : null);
  mutate(db);
  gh.files.set(path, { bytes: Buffer.from(db.export()), sha: gh.nextSha() });
  db.close();
}
