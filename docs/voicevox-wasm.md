# Can VOICEVOX be compiled to a WASM asset served from GitHub Pages?

**Short answer: technically yes, practically no — and for this app it solves a
problem you don't have.**

Everything below was measured against `VOICEVOX/voicevox_core` @ `main` and
`pykeio/ort` @ `main`, cloned and inspected on 2026-07-25, not recalled from
memory.

---

## 1. Where upstream actually stands

`voicevox_core` has **no WASM support and no build target for it**. Grepping the
entire workspace for `wasm` or `emscripten` across `*.rs` and `*.toml` returns
nothing in `crates/`. The only build targets exercised are the C API
(`.so`/`.dll`/`.dylib`), Python wheels, and the Java API.

[Issue #491, "make a browser version and support WebGPU"][491], has been open
since **15 May 2023** with no implementation. So there is no supported path —
anything you build here you maintain yourself against a moving `main`.

There *is* an unofficial proof that it can be made to work: a Japanese blog post
building `voicevox_core_c_api` for `wasm32-unknown-emscripten` and running it in
a Chrome extension sidebar, reporting roughly **5 seconds of compute for 2
seconds of audio**. That build used a hand-added `web-release` profile — note
that no such profile exists in upstream's `Cargo.toml`, which carries only
`release` and `c-api`. It is a patched fork, not a supported configuration.

## 2. The one genuinely encouraging finding

`ort` — the ONNX Runtime binding `voicevox_core` depends on — ships a
first-party web backend, **`ort-web` v0.2.2+1.27**, described as "ONNX Runtime on
the web 🌐 — An alternative backend for `ort`". It bridges Rust/wasm-bindgen to
ONNX Runtime Web running in a separate Emscripten context.

Critically, `ort-web` requires `ort` with features `alternative-backend` and
`api-17`. `voicevox_core`'s manifest already pins exactly that:

```toml
ort = { workspace = true, features = ["std", "ndarray", "tracing", "api-17", "alternative-backend"], default-features = false }
```

So the inference layer is not the wall. That's the part everyone assumes will
sink this, and it wouldn't.

## 3. The three things that actually sink it

### 3.1 Payload — I measured it, it's ~160 MB

| Asset | Compressed | On disk / in memory |
|---|---:|---:|
| Open JTalk dictionary `open_jtalk_dic_utf_8-1.11` | 23.6 MB | **103 MB** (`sys.dic` alone is 99 MB) |
| `decode.onnx` (the talk vocoder, one voice) | — | **57 MB** |
| `predict_duration.onnx` + `predict_intonation.onnx` | — | 84 KB |
| ONNX Runtime wasm | — | ~10–25 MB |

The dictionary is the killer and it is not optional: Open JTalk does the
text→kana→accent-phrase work that gives VOICEVOX its pitch accent. It has to be
unpacked into the Emscripten heap, so that's ~103 MB of **resident wasm memory**
before a single sample is synthesised. Add the models and you're at roughly
**160 MB resident, ~90 MB over the wire**, for one voice.

For reference, the full `sample.vvm` directory unpacks to 181 MB; the `talk`
path in its `manifest.json` is what I costed above, and I excluded the singing
models (`sf_decode`, `predict_sing_*`) which you'd never load.

That's a hostile first load on desktop and simply won't run on most phones.

### 3.2 Licensing — you cannot host the models

This is the hard stop, and it's independent of the engineering.

VOICEVOX's terms prohibit unauthorised redistribution of the software and of
voice libraries. Putting `.vvm` files on a public GitHub Pages site **is**
redistribution. Individual character voices each carry their own additional
terms on top.

The asymmetry that matters:

- ❌ Redistributing the **model files** — not permitted.
- ✅ Publishing the **audio VOICEVOX generates** — permitted, with credit.

That asymmetry is what makes the recommended design below not just easier but
also the licensing-clean one.

### 3.3 Threading — GitHub Pages can't send the headers

`ort-web`'s default distribution is `ort-wasm-simd-threaded.wasm`. Threads mean
`SharedArrayBuffer`, which means the server must send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**GitHub Pages does not let you set response headers.** Workarounds exist — the
`coi-serviceworker` shim, or building single-threaded ORT and accepting the
slowdown on top of an already-slow 2.5×-realtime synthesis — but each is another
thing to own.

## 4. What the build would actually cost you

Roughly, if you did it anyway:

1. Fork `voicevox_core`; add a `web-release` profile and `wasm32-unknown-emscripten`
   plumbing that upstream doesn't have.
2. Get `open_jtalk-rs` (C: Open JTalk + hts_engine + mecab) through Emscripten,
   with the 103 MB dictionary preloaded or mounted into MEMFS.
3. Wire `ort-web` in as the backend, or build ORT to a static wasm lib yourself.
4. Solve COOP/COEP on a host that can't set headers.
5. Solve model hosting somewhere that isn't GitHub Pages, without redistributing
   anything you're not licensed to.
6. Re-do all of it whenever upstream `main` moves, since none of it is supported.

Call it multiple weeks, and the reward is a ~160 MB page that synthesises slower
than real time.

## 5. Why none of this is needed here

The requirement was **"work in a speed range of 50–110% natural speed."** That
reads like a TTS requirement. It isn't.

`HTMLMediaElement.preservesPitch` is **Baseline 2023**, defaults to `true`, and
makes `playbackRate` a proper pitch-preserving time-stretch. So:

> **One rendering per sentence covers the entire 50–110% range.**

I verified this in Chromium against a real file — the element reports
`playbackRate: 0.8` then `0.7` after a miss, with `preservesPitch: true` both
times (`test/e2e.mjs` asserts it).

Runtime TTS was only ever needed to vary speed. Speed is free in the browser.
Therefore no runtime TTS, therefore no engine in the page at all.

That collapses the whole problem:

- Your deck is small, self-made, and changes slowly — exactly the shape that
  wants pre-generation, not on-demand synthesis.
- Generate once, offline, at natural speed. Commit the audio.
- GitHub Pages serves a few hundred KB of Opus/WAV instead of 160 MB of engine.
- Works on phones. No COOP/COEP. No SharedArrayBuffer. No fork to maintain.
- Nothing unlicensed is redistributed — only generated audio, which is allowed
  with credit.

It also fixes the cost question. Rendering only at 1.0× means **one billed
render per sentence** instead of one per speed step. At ElevenLabs' $0.01/100
chars, a 40-character sentence is $0.004; a 500-sentence deck is about **$2
total, once**.

## 6. Recommendation

Use `tools/generate-audio.mjs`, which supports both:

- **VOICEVOX Engine locally** (`--provider voicevox`) — free, no API key, runs in
  Docker, and you keep VOICEVOX's voices. This gets you what you wanted from
  VOICEVOX without any of section 3's problems, because the engine stays on your
  machine and only its output ships.
- **ElevenLabs** (`--provider elevenlabs`) — better prosody for natural-speed
  listening practice, ~$2 for a large deck.

Renders are content-addressed (`sha256(provider + voice + text)`), so re-running
after editing one sentence costs exactly one call.

## 7. When would VOICEVOX-in-WASM be right?

If you wanted a page that synthesises **arbitrary user-typed text** offline, with
no server and no pre-generation. That's a real use case — it just isn't this one.
A fixed deck is the exact case where pre-generation dominates.

If you ever do want it, the lower-effort route is **not** VOICEVOX: use a model
built for the browser from the start (Piper/VITS Japanese voices or `sherpa-onnx`
WASM, tens of MB, permissively licensed) and skip the fork, the 103 MB
dictionary, and the redistribution problem entirely.

---

[491]: https://github.com/VOICEVOX/voicevox_core/issues/491

**Sources**

- [VOICEVOX/voicevox_core](https://github.com/VOICEVOX/voicevox_core) — inspected at `main`
- [Issue #491 — ブラウザ版を作り、WebGPUに対応させる](https://github.com/VOICEVOX/voicevox_core/issues/491)
- [pykeio/ort](https://github.com/pykeio/ort) and the [ort-web backend](https://ort.pyke.io/backends/web)
- [ずんだもん(VOICEVOX)をChrome拡張にしてサイドバーだけで動かしてみた](https://note.com/siathounder/n/n70c35abecc16) — the unofficial emscripten build
- [VOICEVOX ソフトウェア利用規約](https://voicevox.hiroshiba.jp/term/)
- [Open JTalk dictionary 1.11](https://sourceforge.net/projects/open-jtalk/files/Dictionary/open_jtalk_dic-1.11/) — sizes measured from this tarball
- [MDN — HTMLMediaElement.preservesPitch](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preservesPitch)
