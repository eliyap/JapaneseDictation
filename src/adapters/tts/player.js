// Playback at a variable rate.
//
// `preservesPitch` (Baseline 2023, and the default) turns `playbackRate` into
// a pitch-preserving time stretch, so one natural-speed rendering serves the
// whole practice range. Slowing to 50% sounds like slower speech, not a
// detuned voice.
//
// Audio for the current card is held in memory so replays are instant. It is
// released on `release()` when the card is done -- nothing is cached to disk
// and nothing is ever written to the database.

export class Player {
  #el = null;
  #url = null;
  #key = null;
  #inflight = null;

  /** @param {{ tts: any, fallback?: any }} deps */
  constructor({ tts, fallback = null }) {
    this.tts = tts;
    this.fallback = fallback;
    this.usingFallback = false;
    /** Why the provider failed, when playback fell back. @type {Error|null} */
    this.lastError = null;
  }

  setProvider(tts) {
    this.release();
    this.tts = tts;
  }

  /**
   * Fetch (once) and play `text` at `rate`.
   * Repeated calls for the same text reuse the audio already in memory.
   *
   * @param {{ id: string, text: string }} sentence
   * @param {number} rate
   */
  async play(sentence, rate) {
    this.stop();

    if (this.#key !== sentence.id) {
      this.release();
      this.#key = sentence.id;
      this.#inflight = this.#fetch(sentence.text);
    }

    try {
      await this.#inflight;
    } catch (e) {
      this.#inflight = null;
      this.#key = null;
      if (this.fallback?.available?.()) {
        // Keep going so the session is not blocked, but hold on to why. Losing
        // the reason here is worse than the outage: the user sees a robot voice
        // and no explanation for it.
        this.usingFallback = true;
        this.lastError = e;
        try {
          return await this.fallback.speak(sentence.text, rate);
        } catch {
          // Report why the real provider failed, not why the fallback did.
          // "ElevenLabs needs a paid plan" is actionable; "speech synthesis
          // not-allowed" sends you chasing the wrong problem.
          throw e;
        }
      }
      throw e;
    }

    this.usingFallback = false;
    this.lastError = null;
    return this.#playCurrent(rate);
  }

  async #fetch(text) {
    const blob = await this.tts.synthesize(text, {});
    this.#url = URL.createObjectURL(blob);
    this.bytes = blob.size;
  }

  #playCurrent(rate) {
    return new Promise((resolve, reject) => {
      const el = new Audio(this.#url);
      this.#el = el;
      // Explicit despite `true` being the default -- older WebKit and Gecko
      // shipped this prefixed, and pitch preservation is the whole design.
      el.preservesPitch = true;
      el.mozPreservesPitch = true;
      el.webkitPreservesPitch = true;
      el.playbackRate = rate;

      el.addEventListener("ended", () => resolve(), { once: true });
      el.addEventListener("error", () => reject(new Error("Could not play the audio")), { once: true });
      el.play().catch(reject);
    });
  }

  /** Change speed mid-playback without re-fetching. */
  setRate(rate) {
    if (this.#el) this.#el.playbackRate = rate;
  }

  stop() {
    if (this.#el) {
      this.#el.pause();
      this.#el = null;
    }
    this.fallback?.stop?.();
  }

  /** Drop the current card's audio. Called when moving to the next card. */
  release() {
    this.stop();
    if (this.#url) {
      URL.revokeObjectURL(this.#url);
      this.#url = null;
    }
    this.#key = null;
    this.#inflight = null;
    this.bytes = 0;
  }

  get hasAudio() {
    return Boolean(this.#url);
  }
}
