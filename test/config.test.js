import test from "node:test";
import assert from "node:assert/strict";

import { parseCredentialBlob, buildCredentialBlob, DEFAULTS } from "../src/ui/config.js";

const FULL = {
  github: {
    owner: "eliyap", repo: "JapaneseDictation", branch: "main",
    path: "data/dictation.sqlite", token: "github_pat_xxx",
  },
  elevenlabs: { apiKey: "sk_xxx", voiceId: "3JDquces8E8bkmvbh6Bc", modelId: "eleven_multilingual_v2" },
};

test("a full blob round-trips through build and parse", () => {
  const cfg = { ...DEFAULTS, ...FULL };
  const parsed = parseCredentialBlob(buildCredentialBlob(cfg));
  assert.deepEqual(parsed.github, FULL.github);
  assert.deepEqual(parsed.elevenlabs, FULL.elevenlabs);
});

test("omitted non-secret fields fall back to defaults", () => {
  const parsed = parseCredentialBlob(JSON.stringify({
    github: { owner: "eliyap", repo: "JapaneseDictation", token: "t" },
    elevenlabs: { apiKey: "k" },
  }));
  assert.equal(parsed.github.branch, DEFAULTS.github.branch);
  assert.equal(parsed.github.path, DEFAULTS.github.path);
  assert.equal(parsed.elevenlabs.voiceId, DEFAULTS.elevenlabs.voiceId);
  assert.equal(parsed.elevenlabs.modelId, DEFAULTS.elevenlabs.modelId);
});

test("either credential alone is enough", () => {
  assert.equal(parseCredentialBlob('{"github":{"token":"t"}}').github.token, "t");
  assert.equal(parseCredentialBlob('{"elevenlabs":{"apiKey":"k"}}').elevenlabs.apiKey, "k");
});

test("surrounding whitespace from a paste is tolerated", () => {
  const parsed = parseCredentialBlob(`\n  ${JSON.stringify(FULL)}  \n`);
  assert.equal(parsed.github.token, "github_pat_xxx");
});

test("values are trimmed, so a stray newline never lands in a header", () => {
  const parsed = parseCredentialBlob('{"github":{"token":"  t  ","owner":" me "}}');
  assert.equal(parsed.github.token, "t");
  assert.equal(parsed.github.owner, "me");
});

test("an empty field asks for a paste rather than throwing a parser error", () => {
  assert.throws(() => parseCredentialBlob(""), /Paste your credential JSON/);
  assert.throws(() => parseCredentialBlob("   "), /Paste your credential JSON/);
});

test("a bare token is diagnosed specifically", () => {
  assert.throws(
    () => parseCredentialBlob("github_pat_11ABC"),
    /looks like a bare token/,
  );
});

test("non-JSON and non-objects are rejected clearly", () => {
  assert.throws(() => parseCredentialBlob("hello"), /not valid JSON/);
  assert.throws(() => parseCredentialBlob("[1,2]"), /Expected a JSON object/);
  assert.throws(() => parseCredentialBlob("null"), /Expected a JSON object/);
});

test("valid JSON with no credentials in it is rejected", () => {
  assert.throws(() => parseCredentialBlob('{"github":{"owner":"x"}}'), /No credentials found/);
});

test("the built blob is what a person would paste into a manager", () => {
  const blob = buildCredentialBlob({ ...DEFAULTS, ...FULL });
  assert.ok(blob.includes("\n"), "pretty-printed so it is readable");
  assert.deepEqual(Object.keys(JSON.parse(blob)).sort(), ["elevenlabs", "github"]);
});
