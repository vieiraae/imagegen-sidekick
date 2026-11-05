import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { TokenCredential } from "@azure/identity";
import {
  SKILL_DIR, UsageError, buildSsml, multiplier, run, speechEndpoint, ssmlVoice, voiceName, word,
  type Deps, type Word,
} from "./tts.ts";

const WORDS: Word[] = [{ text: "hi", start_ms: 5, end_ms: 50, duration_ms: 45 }];
const credential = {} as TokenCredential;

describe("pure functions", () => {
  test("skill defaults", () => {
    const env = parseEnv(readFileSync(join(SKILL_DIR, ".env"), "utf8"));
    assert.deepEqual(
      [env.TTS_VOICE, env.TTS_MODEL, env.TTS_LANGUAGE, env.TTS_PITCH, env.TTS_RATE, env.TTS_VOLUME],
      ["Harper", "MAI-Voice-2", "en-US", "1", "1.1", "1"],
    );
  });

  test("voice name", () => {
    assert.equal(voiceName("Harper", "MAI-Voice-2", "en-US"), "en-US-Harper:MAI-Voice-2");
    assert.equal(voiceName("en-US-AvaNeural", "MAI-Voice-2", "en-US"), "en-US-AvaNeural");
    assert.equal(voiceName("Ava", "", "en-US"), "en-US-AvaNeural");
  });

  test("endpoint derivation", () => {
    assert.equal(
      speechEndpoint({ FOUNDRY_PROJECT_ENDPOINT: "https://res.services.ai.azure.com/api/projects/p" }),
      "https://res.cognitiveservices.azure.com/",
    );
    assert.equal(speechEndpoint({ SPEECH_ENDPOINT: "https://custom.example.com/x" }), "https://custom.example.com/");
    for (const bad of ["http://res.services.ai.azure.com", "https://u:p@res.services.ai.azure.com", ""]) {
      assert.throws(() => speechEndpoint({ FOUNDRY_PROJECT_ENDPOINT: bad }));
    }
  });

  test("multiplier", () => {
    assert.equal(multiplier("1,1", "rate"), 1.1);
    for (const bad of ["abc", "nan", "3", "-1", ""]) assert.throws(() => multiplier(bad, "rate"), UsageError);
  });

  test("ssml escapes text and adds prosody and style", () => {
    const ssml = buildSsml('Tom & "Jerry" <b>', { voice: "en-US-Harper:MAI-Voice-2", language: "en-US", rate: 1.1, style: "happy" });
    assert.match(ssml, /rate="\+10%" pitch="\+0%" volume="\+0%"/);
    assert.match(ssml, /<mstts:express-as style="happy">/);
    assert.match(ssml, /Tom &amp; "Jerry" &lt;b&gt;/);
    assert.equal(ssmlVoice(ssml), "en-US-Harper:MAI-Voice-2");
  });

  test("ssml omits neutral prosody", () => {
    const ssml = buildSsml("Hi", { voice: "v", language: "en-US" });
    assert.doesNotMatch(ssml, /prosody|express-as/);
  });

  test("word conversion", () => {
    assert.deepEqual(word("hi", 700_000, 4_400_000), { text: "hi", start_ms: 70, end_ms: 510, duration_ms: 440 });
  });
});

describe("run", () => {
  let dir: string;
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tts-test-"));
    saved = { ...process.env };
    Object.assign(process.env, {
      FOUNDRY_PROJECT_ENDPOINT: "https://res.services.ai.azure.com/api/projects/proj",
      SPEECH_ENDPOINT: "", TTS_VOICE: "Harper", TTS_MODEL: "MAI-Voice-2", TTS_LANGUAGE: "en-US",
      TTS_PITCH: "1", TTS_RATE: "1.1", TTS_VOLUME: "1", TTS_STYLE: "", TTS_AUDIO_FORMAT: "wav",
      TTS_ALIGN_WITH_RECOGNITION: "true", TTS_TIMEOUT: "30",
    });
  });
  afterEach(() => {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  function fakes(words: Word[] = []) {
    const calls = { synthesize: [] as unknown[][], recognize: 0 };
    const deps: Deps = {
      credential,
      synthesize: async (...args) => {
        calls.synthesize.push(args);
        return { audio: new TextEncoder().encode("AUDIO"), durationMs: 1200, words };
      },
      recognizeWords: async () => {
        calls.recognize++;
        return WORDS;
      },
    };
    return { deps, calls };
  }
  const timeline = (path: string) => JSON.parse(readFileSync(path, "utf8"));

  test("writes ssml, audio and recognition timeline", async () => {
    const { deps, calls } = fakes();
    const out = join(dir, "narration.wav");
    const result = await run(["--text", "Hello", "--output", out], deps);
    assert.equal((calls.synthesize[0][1] as { endpoint: string }).endpoint, "https://res.cognitiveservices.azure.com/");
    assert.equal(readFileSync(out, "utf8"), "AUDIO");
    assert.match(readFileSync(result.ssml!, "utf8"), /en-US-Harper:MAI-Voice-2/);
    const json = timeline(result.timeline!);
    assert.deepEqual([json.source, json.duration_ms, json.words, json.voice], ["recognition", 1200, WORDS, "en-US-Harper:MAI-Voice-2"]);
    assert.equal(calls.recognize, 1);
  });

  test("prefers synthesis word boundaries", async () => {
    const { deps, calls } = fakes(WORDS);
    const result = await run(["--text", "Hello", "--output", join(dir, "a.wav")], deps);
    assert.equal(timeline(result.timeline!).source, "synthesis");
    assert.equal(calls.recognize, 0);
  });

  test("mp3 also gets a recognition timeline", async () => {
    const { deps, calls } = fakes();
    const result = await run(["--text", "Hello", "--audio-format", "mp3", "--output", join(dir, "a.mp3")], deps);
    assert.equal(calls.recognize, 1);
    assert.equal(timeline(result.timeline!).source, "recognition");
  });

  test("ssml file is used as-is", async () => {
    const ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="en-US-Grant:MAI-Voice-2">Hi<break time="300ms"/></voice></speak>';
    const path = join(dir, "in.ssml");
    writeFileSync(path, ssml);
    const { deps, calls } = fakes();
    const result = await run(["--ssml-file", path, "--output", join(dir, "a.wav")], deps);
    assert.equal(calls.synthesize[0][0], ssml);
    assert.equal(timeline(result.timeline!).voice, "en-US-Grant:MAI-Voice-2");
  });

  test("invalid ssml is rejected", async () => {
    const path = join(dir, "bad.ssml");
    writeFileSync(path, "<speak>");
    await assert.rejects(run(["--ssml-file", path, "--output", join(dir, "a.wav")], fakes().deps), /Invalid SSML/);
  });

  test("--ssml-only does not call the service", async () => {
    const { deps, calls } = fakes();
    const out = join(dir, "a.wav");
    const result = await run(["--text", "Hello", "--ssml-only", "--output", out], deps);
    assert.equal(calls.synthesize.length, 0);
    assert.ok(existsSync(result.ssml!));
    assert.ok(!existsSync(out));
  });

  test("refuses to overwrite", async () => {
    writeFileSync(join(dir, "a.json"), "{}");
    await assert.rejects(run(["--text", "Hello", "--output", join(dir, "a.wav")], fakes().deps), /Refusing to overwrite/);
  });

  test("extension must match format", async () => {
    await assert.rejects(run(["--text", "Hello", "--output", join(dir, "a.mp3")], fakes().deps), UsageError);
  });
});
