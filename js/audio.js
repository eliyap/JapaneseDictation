// Playback with pitch-preserved time stretching.
//
// The whole reason this app needs no TTS at runtime: `preservesPitch` (Baseline
// 2023, and the default) makes `playbackRate` a proper time-stretch, so ONE
// rendering per sentence covers the entire 50-110% range. Speed practice costs
// zero extra bytes and zero extra API spend.

const SPEECH_LANG = "ja-JP";

export class Player {
  #el = null;
  #manifest = {};
  #missing = new Set();

  /** @param {Record<string, string>} manifest sentence id -> audio URL */
  constructor(manifest = {}) {
    this.#manifest = manifest;
  }

  hasAudio(id) {
    return Boolean(this.#manifest[id]) && !this.#missing.has(id);
  }

  /** True when we'd fall back to the OS voice, which is worth telling the user. */
  usesSynthFallback(id) {
    return !this.hasAudio(id);
  }

  stop() {
    if (this.#el) {
      this.#el.pause();
      this.#el = null;
    }
    if (globalThis.speechSynthesis) speechSynthesis.cancel();
  }

  /**
   * Play `sentence` at `rate` (1.0 = natural). Resolves when playback ends.
   * Rejects only on a genuine failure to produce any audio at all.
   */
  async play(sentence, rate) {
    this.stop();
    const url = this.#manifest[sentence.id];
    if (!url) return this.#speak(sentence.text, rate);

    try {
      return await this.#playFile(url, rate);
    } catch (e) {
      // A manifest entry whose file is missing (stale manifest, partial deploy)
      // shouldn't dead-end the session -- drop to the OS voice and say so.
      if (e?.name === "NotAllowedError") throw e; // autoplay block: not our problem to paper over
      this.#missing.add(sentence.id);
      return this.#speak(sentence.text, rate);
    }
  }

  #playFile(url, rate) {
    return new Promise((resolve, reject) => {
      const el = new Audio(url);
      this.#el = el;
      // Explicit even though `true` is the spec default -- older WebKit and
      // Gecko shipped this under prefixes and we want the same behaviour there.
      el.preservesPitch = true;
      el.mozPreservesPitch = true;
      el.webkitPreservesPitch = true;
      el.playbackRate = rate;

      el.addEventListener("ended", () => resolve(), { once: true });
      el.addEventListener(
        "error",
        () => reject(new Error(`Could not load audio: ${url}`)),
        { once: true },
      );
      el.play().catch(reject);
    });
  }

  /**
   * Web Speech fallback. Quality and availability vary by OS -- this exists so
   * a freshly cloned repo is usable before you have generated any audio, not
   * as the intended experience.
   */
  #speak(text, rate) {
    return new Promise((resolve, reject) => {
      if (!globalThis.speechSynthesis) {
        reject(new Error("No audio file for this sentence, and this browser has no speech synthesis."));
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = SPEECH_LANG;
      u.rate = rate;
      const ja = speechSynthesis.getVoices().find((v) => v.lang?.startsWith("ja"));
      if (ja) u.voice = ja;
      u.addEventListener("end", () => resolve(), { once: true });
      u.addEventListener("error", (e) => {
        // Chrome fires 'error' with reason 'interrupted'/'canceled' on cancel();
        // that is us calling stop(), not a failure worth surfacing.
        if (e.error === "interrupted" || e.error === "canceled") resolve();
        else reject(new Error(`Speech synthesis failed: ${e.error}`));
      }, { once: true });
      speechSynthesis.speak(u);
    });
  }
}

/** Nudge the voice list to populate; Chrome loads it asynchronously. */
export function warmUpVoices() {
  if (globalThis.speechSynthesis) speechSynthesis.getVoices();
}
