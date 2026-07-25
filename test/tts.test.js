import test from "node:test";
import assert from "node:assert/strict";

import { createElevenLabs, DEFAULT_VOICE_ID, DEFAULT_MODEL_ID } from "../src/adapters/tts/elevenlabs.js";

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return handler(url, init, calls.length);
  };
  return { fetchImpl, calls };
}

const audioResponse = () => ({
  ok: true,
  status: 200,
  blob: async () => new Blob([new Uint8Array([0xff, 0xfb, 0x90])], { type: "audio/mpeg" }),
});

const errorResponse = (status, detail) => ({
  ok: false,
  status,
  json: async () => ({ detail }),
  text: async () => JSON.stringify({ detail }),
});

test("synthesize posts to the configured voice with the multilingual model", async () => {
  const { fetchImpl, calls } = fakeFetch(audioResponse);
  const tts = createElevenLabs({ apiKey: "k", fetchImpl });

  const blob = await tts.synthesize("こんにちは。", {});
  assert.ok(blob.size > 0);

  const [call] = calls;
  assert.ok(call.url.includes(`/v1/text-to-speech/${DEFAULT_VOICE_ID}`));
  assert.equal(call.init.headers["xi-api-key"], "k");
  assert.equal(call.body.text, "こんにちは。");
  assert.equal(call.body.model_id, DEFAULT_MODEL_ID);
});

test("audio is always requested at natural speed", async () => {
  const { fetchImpl, calls } = fakeFetch(audioResponse);
  const tts = createElevenLabs({ apiKey: "k", fetchImpl });
  await tts.synthesize("テスト", {});
  // Speed is a playback concern; asking the API for it would cost a render per
  // speed step and still not reach 50%.
  assert.equal(calls[0].body.speed, undefined);
});

test("the voice can be overridden per call", async () => {
  const { fetchImpl, calls } = fakeFetch(audioResponse);
  const tts = createElevenLabs({ apiKey: "k", voiceId: "cfg-voice", fetchImpl });
  await tts.synthesize("テスト", { voiceId: "call-voice" });
  assert.ok(calls[0].url.includes("call-voice"));
});

test("a missing key fails before any request is made", async () => {
  const { fetchImpl, calls } = fakeFetch(audioResponse);
  const tts = createElevenLabs({ apiKey: "", fetchImpl });
  await assert.rejects(() => tts.synthesize("テスト", {}), /No ElevenLabs API key/);
  assert.equal(calls.length, 0);
});

test("empty text is rejected without a request", async () => {
  const { fetchImpl, calls } = fakeFetch(audioResponse);
  const tts = createElevenLabs({ apiKey: "k", fetchImpl });
  await assert.rejects(() => tts.synthesize("   ", {}), /Nothing to speak/);
  assert.equal(calls.length, 0);
});

test("the free-tier IP block is explained, not echoed as HTTP 401", async () => {
  const { fetchImpl } = fakeFetch(() =>
    errorResponse(401, {
      type: "authentication_error",
      status: "detected_unusual_activity",
      message: "Unusual activity has been detected...",
    }),
  );
  const tts = createElevenLabs({ apiKey: "k", fetchImpl });
  await assert.rejects(
    () => tts.synthesize("テスト", {}),
    (e) => /VPN, proxy or datacenter/.test(e.message) && e.code === "detected_unusual_activity",
  );
});

test("a missing key permission says which dashboard fix applies", async () => {
  const { fetchImpl } = fakeFetch(() =>
    errorResponse(401, { status: "missing_permissions", message: "missing voices_read" }),
  );
  const tts = createElevenLabs({ apiKey: "k", fetchImpl });
  await assert.rejects(() => tts.listVoices(), /grant it/);
});

test("rate limits and server errors are marked retryable; auth errors are not", async () => {
  for (const [status, retryable] of [[429, true], [500, true], [401, false]]) {
    const { fetchImpl } = fakeFetch(() => errorResponse(status, { message: "x" }));
    const tts = createElevenLabs({ apiKey: "k", fetchImpl });
    await assert.rejects(
      () => tts.synthesize("テスト", {}),
      (e) => e.retryable === retryable,
      `HTTP ${status} retryable=${retryable}`,
    );
  }
});

test("empty audio is treated as a failure", async () => {
  const { fetchImpl } = fakeFetch(() => ({
    ok: true, status: 200, blob: async () => new Blob([]),
  }));
  const tts = createElevenLabs({ apiKey: "k", fetchImpl });
  await assert.rejects(() => tts.synthesize("テスト", {}), /empty audio/);
});

test("listVoices maps the v2 response shape", async () => {
  const { fetchImpl } = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ voices: [{ voice_id: "v1", name: "Aoi", category: "cloned" }] }),
  }));
  const tts = createElevenLabs({ apiKey: "k", fetchImpl });
  assert.deepEqual(await tts.listVoices(), [{ id: "v1", name: "Aoi", category: "cloned" }]);
});
