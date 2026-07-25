/** @import { TtsProvider, TtsOptions, TtsVoice } from '../../core/types.js' */

// ElevenLabs text-to-speech.
//
// Audio is always requested at natural speed. The 50-110% practice range is
// applied at playback with `playbackRate` + `preservesPitch`, which covers a
// wider range than ElevenLabs' own `speed` parameter (0.7-1.2) and makes
// replaying at a different speed instant and free.

const API_BASE = "https://api.elevenlabs.io";

export const DEFAULT_VOICE_ID = "3JDquces8E8bkmvbh6Bc";
export const DEFAULT_MODEL_ID = "eleven_multilingual_v2";
export const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";

export class TtsError extends Error {
  constructor(message, { status, code, retryable = false } = {}) {
    super(message);
    this.name = "TtsError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * @param {{ apiKey: string, voiceId?: string, modelId?: string,
 *           outputFormat?: string, fetchImpl?: typeof fetch, apiBase?: string }} cfg
 * @returns {TtsProvider}
 */
export function createElevenLabs(cfg) {
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const apiBase = (cfg.apiBase ?? API_BASE).replace(/\/+$/, "");

  const headers = () => {
    if (!cfg.apiKey) throw new TtsError("No ElevenLabs API key configured", { status: 0 });
    return { "xi-api-key": cfg.apiKey };
  };

  return {
    id: "elevenlabs",
    label: "ElevenLabs",

    async synthesize(text, opts = {}) {
      if (!text?.trim()) throw new TtsError("Nothing to speak", { status: 0 });

      const voiceId = opts.voiceId ?? cfg.voiceId ?? DEFAULT_VOICE_ID;
      const url =
        `${apiBase}/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
        `?output_format=${encodeURIComponent(cfg.outputFormat ?? DEFAULT_OUTPUT_FORMAT)}`;

      const res = await fetchImpl(url, {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text,
          model_id: opts.modelId ?? cfg.modelId ?? DEFAULT_MODEL_ID,
        }),
        signal: opts.signal,
      });

      if (!res.ok) throw await toTtsError(res);

      const blob = await res.blob();
      if (blob.size === 0) throw new TtsError("ElevenLabs returned empty audio", { status: 200 });
      return blob;
    },

    /**
     * Optional -- needs the `voices_read` permission, which a TTS-only key
     * will not have. Callers must treat failure as "cannot enumerate", not
     * as "the key is broken".
     * @returns {Promise<TtsVoice[]>}
     */
    async listVoices() {
      const res = await fetchImpl(`${apiBase}/v2/voices?page_size=100`, { headers: headers() });
      if (!res.ok) throw await toTtsError(res);
      const body = await res.json();
      return (body.voices ?? []).map((v) => ({
        id: v.voice_id,
        name: v.name,
        category: v.category,
      }));
    },
  };
}

/**
 * Turn an ElevenLabs error body into something a user can act on. Their
 * failures are mostly account-level rather than request-level, and the raw
 * status alone ("401") points you at the wrong problem.
 */
async function toTtsError(res) {
  let detail = null;
  try {
    detail = (await res.json())?.detail ?? null;
  } catch {
    /* non-JSON body */
  }
  const code = typeof detail === "object" ? detail?.status ?? detail?.code : null;
  const raw = typeof detail === "string" ? detail : detail?.message ?? "";

  const explain = {
    detected_unusual_activity:
      "ElevenLabs has disabled free-tier access for this account, usually because " +
      "requests arrived from a VPN, proxy or datacenter IP. Use a normal network " +
      "connection, or upgrade the account to a paid plan.",
    missing_permissions:
      "This API key lacks a permission the request needs. Edit the key in the " +
      "ElevenLabs dashboard and grant it.",
    quota_exceeded: "The account is out of characters for this billing period.",
    voice_not_found: "That voice ID does not exist on this account.",
    invalid_api_key: "ElevenLabs rejected this API key.",
  }[code];

  return new TtsError(explain ?? raw ?? `ElevenLabs request failed (HTTP ${res.status})`, {
    status: res.status,
    code,
    retryable: res.status === 429 || res.status >= 500,
  });
}
