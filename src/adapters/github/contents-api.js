// Thin client for the GitHub Contents API.
// https://docs.github.com/en/rest/repos/contents
//
// Scope is deliberately small: read a file, write a file, report conflicts
// honestly. Everything about SQLite, syncing and retrying lives a layer up.

/** Both this and 2022-11-28 verified accepted; pinned so a future default
 *  version bump can't silently change response shapes underneath us. */
export const API_VERSION = "2026-03-10";

/** The Contents API returns file bodies inline only below this size. */
const INLINE_LIMIT = 1024 * 1024;

export class GitHubApiError extends Error {
  constructor(message, { status, isConflict = false, isAuth = false, isMissing = false } = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.isConflict = isConflict;
    this.isAuth = isAuth;
    this.isMissing = isMissing;
  }
}

export class ContentsApi {
  /**
   * @param {{ owner: string, repo: string, branch?: string, token: string,
   *           fetchImpl?: typeof fetch, apiBase?: string }} cfg
   */
  constructor({ owner, repo, branch = "main", token, fetchImpl, apiBase = "https://api.github.com" }) {
    if (!owner || !repo) throw new Error("owner and repo are required");
    if (!token) throw new Error("A GitHub token is required");
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.token = token;
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  #url(path) {
    const clean = String(path).replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
    return `${this.apiBase}/repos/${this.owner}/${this.repo}/contents/${clean}`;
  }

  #headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    };
  }

  async #raise(res, what) {
    let detail = "";
    try {
      detail = (await res.json())?.message ?? "";
    } catch {
      /* non-JSON error body; the status is enough */
    }
    throw new GitHubApiError(`${what}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, {
      status: res.status,
      isConflict: res.status === 409 || res.status === 422,
      isAuth: res.status === 401 || res.status === 403,
      isMissing: res.status === 404,
    });
  }

  /**
   * Read a file. Returns null when it does not exist yet, which is the normal
   * first-run state rather than an error.
   * @returns {Promise<{ bytes: Uint8Array, sha: string }|null>}
   */
  async getFile(path) {
    const res = await this.fetch(
      `${this.#url(path)}?ref=${encodeURIComponent(this.branch)}`,
      { headers: this.#headers(), cache: "no-store" },
    );
    if (res.status === 404) return null;
    if (!res.ok) await this.#raise(res, `Reading ${path}`);

    const body = await res.json();
    if (body.type !== "file") {
      throw new GitHubApiError(`${path} is a ${body.type}, not a file`, { status: 200 });
    }

    // Over ~1 MB the API returns metadata with an empty body and expects you
    // to go through the blobs API instead.
    if (body.encoding !== "base64" || (body.content ?? "") === "") {
      if (body.size > INLINE_LIMIT) {
        return { bytes: await this.#getBlob(body.sha, path), sha: body.sha };
      }
      throw new GitHubApiError(`${path} came back with encoding "${body.encoding}"`, { status: 200 });
    }

    return { bytes: decodeBase64(body.content), sha: body.sha };
  }

  /** Large-file path: fetch the blob raw. */
  async #getBlob(sha, path) {
    const res = await this.fetch(
      `${this.apiBase}/repos/${this.owner}/${this.repo}/git/blobs/${sha}`,
      { headers: { ...this.#headers(), Accept: "application/vnd.github.raw" }, cache: "no-store" },
    );
    if (!res.ok) await this.#raise(res, `Reading blob for ${path}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Create or replace a file. `sha` must be the blob sha of the version being
   * replaced; omit it only when creating. A stale sha surfaces as
   * `error.isConflict`, which the caller is expected to resolve by re-reading.
   *
   * @returns {Promise<{ sha: string, commit: string }>}
   */
  async putFile(path, bytes, { sha = null, message } = {}) {
    const res = await this.fetch(this.#url(path), {
      method: "PUT",
      headers: { ...this.#headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: message ?? `Update ${path}`,
        content: encodeBase64(bytes),
        branch: this.branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) await this.#raise(res, `Writing ${path}`);

    const body = await res.json();
    return { sha: body.content?.sha, commit: body.commit?.sha };
  }

  /** Cheap credential/permission probe for the settings screen. */
  async checkAccess() {
    const res = await this.fetch(`${this.apiBase}/repos/${this.owner}/${this.repo}`, {
      headers: this.#headers(),
    });
    if (!res.ok) await this.#raise(res, "Checking repository access");
    const body = await res.json();
    return {
      fullName: body.full_name,
      private: body.private,
      defaultBranch: body.default_branch,
      canPush: Boolean(body.permissions?.push),
    };
  }
}

// --- base64 <-> bytes ------------------------------------------------------
// GitHub wraps the base64 it returns at 60 columns, so the newlines have to
// come out before decoding. Chunked to avoid blowing the argument limit on
// String.fromCharCode for a database of any real size.

export function decodeBase64(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBase64(bytes) {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
