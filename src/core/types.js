// The contracts every replaceable part of this app implements.
//
// This file is types only -- it exists so the boundaries are written down in
// one place rather than implied by whichever implementation you read first.
// Nothing imports it at runtime.

/**
 * A sentence to transcribe. Authored by the user; audio is never stored on it.
 *
 * @typedef {Object} Sentence
 * @property {string}  id
 * @property {string}  text          Japanese, the thing being dictated
 * @property {string=} translation   shown on reveal, purely for context
 * @property {string=} notes
 * @property {string[]} tags
 * @property {number}  createdAt     epoch ms
 * @property {boolean} archived
 */

/**
 * Per-card scheduling state.
 *
 * The first-class fields are the ones the app itself needs (to sort a queue,
 * to set playback rate, to show progress). Anything an algorithm needs beyond
 * that goes in `algo`, which the app treats as an opaque blob. That split is
 * what lets a new algorithm ship without a schema migration: SM-2 keeps its
 * ease factor there, FSRS would keep stability/difficulty there, and the
 * `cards` table never changes.
 *
 * @typedef {Object} CardState
 * @property {number|null} due     epoch ms; null means "new, never reviewed"
 * @property {number}  speed       playback rate, 1.0 = natural
 * @property {number}  reps
 * @property {number}  lapses
 * @property {number}  streak      consecutive correct
 * @property {boolean} retired
 * @property {Record<string, unknown>} algo   algorithm-private
 */

/**
 * One graded answer. `correct` is the only signal -- grading is done on paper.
 *
 * @typedef {Object} ReviewInput
 * @property {boolean} correct
 * @property {number}  at          epoch ms
 * @property {number}  speed       rate the audio actually played at
 * @property {number=} elapsedMs   time from first play to grading
 */

/**
 * A tunable knob. Schedulers declare these; the settings UI renders itself
 * from the declarations, so a new algorithm gets a settings panel for free.
 *
 * @typedef {Object} ParamSpec
 * @property {string} key
 * @property {string} label
 * @property {'number'|'boolean'} type
 * @property {number|boolean} default
 * @property {number=} min
 * @property {number=} max
 * @property {number=} step
 * @property {string=} help
 * @property {'ratio'|'days'|'count'=} unit
 */

/**
 * A scheduling algorithm.
 *
 * Implementations must be pure and synchronous: same inputs, same output, no
 * clock reads of their own (`now` is always passed in). That is what makes
 * them testable and what lets the app replay a review log through a different
 * algorithm to compare them.
 *
 * @typedef {Object} Scheduler
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {ParamSpec[]} params
 * @property {(params: Record<string, any>) => CardState} init
 * @property {(state: CardState, review: ReviewInput, params: Record<string, any>) => CardState} review
 * @property {(state: CardState, now: number) => boolean} isDue
 * @property {(state: CardState, now: number) => number} priority  lower shows sooner
 */

/**
 * Text to speech. `synthesize` returns audio at natural speed; playback rate
 * is applied in the player, not requested from the provider.
 *
 * @typedef {Object} TtsProvider
 * @property {string} id
 * @property {string} label
 * @property {(text: string, opts: TtsOptions) => Promise<Blob>} synthesize
 * @property {(() => Promise<TtsVoice[]>)=} listVoices  optional; may throw if unpermitted
 */

/**
 * @typedef {Object} TtsOptions
 * @property {string=} voiceId
 * @property {string=} modelId
 * @property {AbortSignal=} signal
 */

/** @typedef {{ id: string, name: string, category?: string }} TtsVoice */

/**
 * Durable storage. Reads are synchronous against an in-memory database;
 * only `load` and `flush` touch the network.
 *
 * @typedef {Object} Store
 * @property {() => Promise<void>} load
 * @property {() => Promise<void>} flush
 * @property {() => boolean} isDirty
 * @property {() => Sentence[]} listSentences
 * @property {(s: Sentence) => void} upsertSentence
 * @property {(id: string) => void} deleteSentence
 * @property {(id: string) => CardState|null} getCard
 * @property {(id: string, schedulerId: string, state: CardState) => void} putCard
 * @property {(sentenceId: string, review: ReviewInput, schedulerId: string) => void} logReview
 * @property {(sentenceId?: string) => ReviewLogEntry[]} listReviews
 * @property {(key: string) => string|null} getSetting
 * @property {(key: string, value: string) => void} setSetting
 */

/**
 * @typedef {Object} ReviewLogEntry
 * @property {string}  sentenceId
 * @property {number}  reviewedAt
 * @property {boolean} correct
 * @property {number}  speed
 * @property {string}  scheduler
 * @property {number|null} elapsedMs
 */

export {};
