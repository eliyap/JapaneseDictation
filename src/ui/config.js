// Credentials and device-local preferences.
//
// These live in localStorage and are NEVER written to the database or the
// repository. The database is a public-ish artifact committed to git; putting
// a token in it would publish the token. Anything secret stops here.

const KEY = "jpdictation.config.v1";

export const DEFAULTS = {
  github: { owner: "", repo: "", branch: "main", path: "data/dictation.sqlite", token: "" },
  elevenlabs: { apiKey: "", voiceId: "3JDquces8E8bkmvbh6Bc", modelId: "eleven_multilingual_v2" },
  schedulerId: "speed-ladder",
  autoPlay: true,
};

export function loadConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      ...DEFAULTS,
      ...raw,
      github: { ...DEFAULTS.github, ...(raw.github ?? {}) },
      elevenlabs: { ...DEFAULTS.elevenlabs, ...(raw.elevenlabs ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(cfg) {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
    return true;
  } catch {
    return false; // private mode or quota; the app still works for this session
  }
}

export function clearConfig() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing useful to do */
  }
}

export const githubReady = (cfg) =>
  Boolean(cfg.github.owner && cfg.github.repo && cfg.github.token);

export const ttsReady = (cfg) => Boolean(cfg.elevenlabs.apiKey);

/** Scheduler params are per-algorithm and stored in the synced database, not
 *  here -- they are a study preference, not a device secret. */
export const PARAMS_SETTING_KEY = (schedulerId) => `params.${schedulerId}`;

// --- credential blob ------------------------------------------------------
//
// All credentials travel as one JSON document in a single password field, so a
// password manager can store and autofill them like any other login. That is
// what keeps this site safe to publish: the deployed files contain no secrets,
// and nothing has to be retyped on a new device.

/** The identity to save the entry under. Gives the manager a username to match. */
export const CREDENTIAL_USER = "japanese-dictation";

/**
 * Parse a credential blob into a config patch.
 * Throws with a message worth showing to a person.
 *
 * @param {string} text
 * @returns {{ github: object, elevenlabs: object }}
 */
export function parseCredentialBlob(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error("Paste your credential JSON first");

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      trimmed.startsWith("github_pat_") || trimmed.startsWith("ghp_")
        ? "That looks like a bare token. This field expects the whole JSON object — use “Copy for password manager” to see the shape."
        : "That is not valid JSON",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }

  const gh = parsed.github ?? {};
  const el = parsed.elevenlabs ?? {};
  if (!gh.token && !el.apiKey) {
    throw new Error('No credentials found — expected "github.token" and/or "elevenlabs.apiKey"');
  }

  return {
    github: {
      owner: str(gh.owner) || DEFAULTS.github.owner,
      repo: str(gh.repo) || DEFAULTS.github.repo,
      branch: str(gh.branch) || DEFAULTS.github.branch,
      path: str(gh.path) || DEFAULTS.github.path,
      token: str(gh.token),
    },
    elevenlabs: {
      apiKey: str(el.apiKey),
      voiceId: str(el.voiceId) || DEFAULTS.elevenlabs.voiceId,
      modelId: str(el.modelId) || DEFAULTS.elevenlabs.modelId,
    },
  };
}

/** Render the current config as a blob to paste into a password manager. */
export function buildCredentialBlob(cfg) {
  return JSON.stringify(
    {
      github: {
        owner: cfg.github.owner,
        repo: cfg.github.repo,
        branch: cfg.github.branch,
        path: cfg.github.path,
        token: cfg.github.token,
      },
      elevenlabs: {
        apiKey: cfg.elevenlabs.apiKey,
        voiceId: cfg.elevenlabs.voiceId,
        modelId: cfg.elevenlabs.modelId,
      },
    },
    null,
    2,
  );
}

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
