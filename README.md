# 聴き取り — Japanese dictation practice

Hear a sentence, write it on paper, reveal the answer, mark yourself right or
wrong. Audio speed adapts to how you're doing.

Static site, built for a phone. Audio comes from ElevenLabs at review time;
progress lives in a SQLite file committed to this repo through the GitHub
Contents API. No server, no build step.

## Setup

### 1. Make a GitHub token

A fine-grained PAT, scoped to **this repository only**, with
**Contents: Read and write**. That is the only permission the app uses.

### 2. Build your credential JSON

Every credential travels as one JSON document so a password manager can hold
and autofill it. Nothing secret is ever committed, which is what makes the
deployed site safe to publish.

```json
{
  "github": {
    "owner": "eliyap",
    "repo": "JapaneseDictation",
    "branch": "main",
    "path": "data/dictation.sqlite",
    "token": "github_pat_…"
  },
  "elevenlabs": {
    "apiKey": "sk_…",
    "voiceId": "3JDquces8E8bkmvbh6Bc",
    "modelId": "eleven_multilingual_v2"
  }
}
```

Save it in your password manager under the site, with username
`japanese-dictation`. Then open **Settings → Credentials**, let the manager
autofill the field, and press **Unlock**. Settings → **Copy for password
manager** regenerates the blob later.

Only `github.token` and `elevenlabs.apiKey` are required; everything else
falls back to the defaults above.

### 3. Deploy

Settings → Pages → deploy from branch, root. There is nothing to build.

Run it locally with `npm run serve` (`http://127.0.0.1:8765`). Opening
`index.html` from the filesystem will not work — the app uses ES modules and
`fetch`.

## Using it

**Sentences** — add what you're studying. Text is all that's required.

**Review** — press Play, write on paper, press Show answer, then Correct or
Wrong. Grading is entirely yours; the app only records the bit. `−` and `+`
nudge the speed for the current card without counting as an answer.

**Settings** — pick the scheduling algorithm and tune it.

Progress syncs a few seconds after you stop, and whenever the page is
backgrounded. Sync status is in the top right.

## Scheduling

Two algorithms ship, and the interface is designed so a third can be dropped in
without touching the schema or the UI:

| | Speed ladder | SM-2 |
|---|---|---|
| Spacing | none — always available | intervals grow: 1d, 6d, ×ease |
| Speed | +5 on a hit, −10 on a miss, clamped 50–110% | same ladder, alongside intervals |
| Retires | after N correct in a row | once the interval passes a threshold |
| Good for | drilling a small deck | long-term retention |

Every knob in that table is a tunable parameter in Settings. The controls are
generated from each scheduler's own declarations, so a new algorithm gets a
settings panel for free.

FSRS is supported as a drop-in — see
[docs/architecture.md](docs/architecture.md#about-fsrs-specifically). Review
history is already being logged with timestamps, which is what training weights
needs.

## Cost

There is no audio cache by design: each time a card comes up, its audio is
re-synthesized. At ElevenLabs' $0.01/100 characters a ~40-character sentence is
about **$0.004 per view**, so a 30-card session runs roughly **$0.12**.

Replays within a card are free — the audio is held in memory until you move on
— and changing speed never re-synthesizes, because speed is applied at playback
rather than requested from the API.

## Two things to know about ElevenLabs

Both were found by probing the API directly, and both are account settings
rather than app bugs:

- **The key needs more than TTS permission if you want the voice picker.**
  A TTS-only key returns `missing_permissions` for `voices_read`, so voices
  can't be enumerated. The app takes a voice ID directly, so this only matters
  if you want to browse.
- **Free-tier accounts get IP-blocked from datacenters and VPNs.** Requests
  return `detected_unusual_activity` and free-tier access is disabled. Normal
  home or mobile networks are fine; this only bites if you run the app through
  a VPN or try to drive the API from a server.

The app surfaces both of these as plain-language errors rather than a bare 401.

## Security

- Secrets live in `localStorage` and in your password manager. They are never
  written to the database, which is a public artifact in this repo.
- Anything that can run script on this origin can read the token, which is the
  argument for a repo-scoped, short-lived PAT rather than a broad one.
- The database itself is committed in the clear — treat your sentences as
  public if the repo is public.

## Development

```bash
npm install
npm test                 # 72 tests, no browser needed
npm run serve            # then, in another terminal:
npm run e2e              # real UI, phone viewport, APIs intercepted
```

`PW_CHROMIUM=/path/to/chrome` uses an existing browser instead of Playwright's.

Layout, the module boundaries, and the multi-device merge design are in
[docs/architecture.md](docs/architecture.md).
