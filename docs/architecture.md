# Architecture

Four replaceable parts behind explicit interfaces, and a core that knows only
the interfaces. The contracts are written down in
[`src/core/types.js`](../src/core/types.js) — that file is types only and
imports nothing, so it stays a description rather than a second implementation.

```
                    ┌──────────────────────────────┐
   src/ui/  ───────▶│  Session (src/core/session.js)│
   (DOM, events)    └───────────┬──────────────────┘
                                │  uses only interfaces
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                  ▼
        Scheduler            Store             TtsProvider
   speed-ladder.js     github-sqlite.js       elevenlabs.js
   sm2.js              (sqlite-db.js +        webspeech.js
   fsrs.js (adapter)    contents-api.js)
```

`Session` holds the review loop and touches no DOM, no network and no clock of
its own — `now` is injected. That is why the whole loop is testable in Node.

## Swapping the scheduler

A scheduler is pure and synchronous: `(state, review, params) -> state`. It
never reads the clock, so replaying a review log through a different algorithm
to compare them is possible.

Two ship today, with deliberately different shapes so the interface is proven
rather than asserted: `speed-ladder` has no calendar at all, `sm2` schedules by
date. Adding a third is one file plus one `register()` call:

```js
import { register } from "./src/core/scheduler/index.js";
register(myScheduler);
```

Nothing else changes. In particular:

- **No schema migration.** Algorithm-private state lives in a JSON `algo` blob
  on the card. SM-2 keeps its ease factor there; FSRS would keep stability and
  difficulty there. The `cards` table never changes shape.
- **No UI work.** Schedulers declare their tunables as `ParamSpec[]`, and the
  settings screen builds its own controls from that declaration — including
  clamping, type coercion, and help text.

An unknown scheduler id falls back to the default instead of throwing, so a
database synced from a device running a newer build cannot brick an older one.

### About FSRS specifically

[`fsrs.js`](../src/core/scheduler/fsrs.js) is an **adapter, not an
implementation**. FSRS is a fitted model — its behaviour lives in a weight
vector trained on review history — and hand-rolling it with guessed constants
would schedule badly while looking plausible. Supply `ts-fsrs` (or anything
with its shape) and `makeFsrsScheduler` turns it into a `Scheduler`.

The prerequisite that actually mattered is already done: every answer is
written to the `reviews` table with its timestamp, from the first review
onward. Weights need history to train on, and retrofitting that later would
have meant starting the log over.

## Storage: SQLite over the GitHub Contents API

Reads are synchronous against an in-memory sql.js database. Only `load` and
`flush` touch the network.

`load` GETs the file (a 404 is the normal first-run state, not an error) and
`flush` PUTs the exported bytes back with the blob `sha` it last saw.

### Two devices don't clobber each other

A SQLite file is an opaque binary blob. Git cannot merge it, so a naive
last-write-wins push would silently discard whatever the other device did.

Instead every mutation is recorded twice: applied to the in-memory database,
and appended to a pending-operation log. On a `sha` conflict the store
re-downloads whatever is now on the remote, replays **only its own pending
operations** on top, and pushes that. The data is append-mostly — new
sentences, new reviews, card state keyed by id — so replaying converges.

Both paths call the same `applyOp`, so a merge can never diverge from what a
normal write would have done.

Replays are idempotent: reviews carry a client-generated `client_id` with a
unique index, so a push that landed but whose response was lost re-inserts the
same rows and the index drops them.

Writes are debounced ~8s and flushed on `pagehide`/`visibilitychange`, so a
session becomes a few commits rather than one per answer. `pagehide` is the
one that actually fires on iOS.

## Audio is never stored

Audio is fetched from ElevenLabs at review time, held in memory for the
current card so replays are instant, and released on the next card. Nothing is
written to disk and nothing goes in the database — which is what keeps the
database a few tens of KB and therefore viable to sync as a whole file.

Audio is always requested at **natural speed**. The practice range is applied
at playback via `playbackRate` with `preservesPitch`, which:

- covers 50–110%, wider than ElevenLabs' own `speed` parameter (0.7–1.2);
- makes changing speed instant and free, instead of a new render per step;
- keeps one render per card view rather than one per speed.

See [voicevox-wasm.md](voicevox-wasm.md) for the measurements behind that
choice, and for why there is no TTS engine compiled into the page.

## Credentials

All credentials travel as one JSON document in a single password field, so a
password manager stores and autofills them like any other login. The deployed
site contains no secrets, which is what makes it safe to publish, and a new
device needs one autofill rather than retyping tokens.

Secrets live in `localStorage` and are never written to the database — the
database is committed to a repository, so a token in it would be a published
token. `src/ui/config.js` is the only module that touches them.

## Testing

- `npm test` — 72 tests, no browser. Schedulers (including a contract suite
  every registered scheduler must pass), the SQLite layer, the Contents API
  client against a fake that enforces `sha` checking, multi-device merges, the
  session loop, the ElevenLabs adapter, and credential parsing.
- `npm run e2e` — the real UI in a phone-sized browser with both APIs
  intercepted at the network layer. Everything below `fetch` is real: sql.js,
  the store, the scheduler, actual audio playback. It also asserts the things
  that are easy to regress silently — no audio bytes in the database, replays
  costing no API call, `preservesPitch` on at every rate, no horizontal scroll,
  and every tap target at least 44px.
