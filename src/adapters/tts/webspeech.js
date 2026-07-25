/** @import { TtsProvider } from '../../core/types.js' */

// The device's built-in Japanese voice.
//
// Exists so the app is usable without credentials -- for trying the review
// flow, and as a fallback when ElevenLabs is unreachable. It cannot return a
// Blob (the platform never exposes the samples), so it implements `speak`
// instead and the player special-cases it.

export function createWebSpeech() {
  return {
    id: "webspeech",
    label: "Device voice",
    isLive: true,

    available() {
      return Boolean(globalThis.speechSynthesis);
    },

    async synthesize() {
      throw new Error("The device voice cannot produce a downloadable file");
    },

    /** @param {string} text @param {number} rate */
    speak(text, rate) {
      return new Promise((resolve, reject) => {
        if (!globalThis.speechSynthesis) {
          reject(new Error("This browser has no speech synthesis"));
          return;
        }
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "ja-JP";
        u.rate = rate;
        const ja = speechSynthesis.getVoices().find((v) => v.lang?.startsWith("ja"));
        if (ja) u.voice = ja;
        u.addEventListener("end", () => resolve(), { once: true });
        u.addEventListener("error", (e) => {
          // cancel() surfaces as an error; that is us stopping playback.
          if (e.error === "interrupted" || e.error === "canceled") resolve();
          else reject(new Error(`Speech synthesis failed: ${e.error}`));
        }, { once: true });
        speechSynthesis.speak(u);
      });
    },

    stop() {
      globalThis.speechSynthesis?.cancel();
    },
  };
}
