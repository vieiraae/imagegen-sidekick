import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { after, before, describe, test } from "node:test";
import { SKILL_DIR, UsageError, captionLines, narration, parseScript, plan, run, tokenTimes, tokens, type Timeline } from "./walkthrough.ts";

const dir = mkdtempSync(join(tmpdir(), "walkthrough-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const words = (...items: [string, number, number][]) => items.map(([text, start_ms, end_ms]) => ({ text, start_ms, end_ms }));
const writeScript = (name: string, script: unknown) => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(script));
  return path;
};

describe("pure functions", () => {
  test("skill defaults", () => {
    const env = parseEnv(readFileSync(join(SKILL_DIR, ".env"), "utf8"));
    assert.deepEqual([env.WT_WIDTH, env.WT_HEIGHT, env.WT_CAPTIONS], ["1280", "720", "true"]);
  });

  test("tokens normalize punctuation and case", () => {
    assert.deepEqual(tokens("Click  'Save', then—done!"), ["click", "save", "thendone"]);
  });

  test("token times align and interpolate missing words", () => {
    const timeline: Timeline = { audio: "a.wav", duration_ms: 3000, words: words(["Open", 100, 400], ["the", 400, 500], ["menu.", 1000, 1400]) };
    assert.deepEqual(tokenTimes(["open", "the", "main", "menu"], timeline), [100, 400, 700, 1000]);
  });

  test("plan anchors actions to steps and at phrases", () => {
    const script = {
      url: "https://example.com",
      steps: [
        { say: "Welcome.", actions: [{ do: "goto", url: "/" }] },
        { say: "Now click Save to finish.", actions: [{ do: "click", at: "Save", selector: "#s" }] },
      ],
    };
    const timeline: Timeline = {
      audio: "a.wav", duration_ms: 3000,
      words: words(["Welcome.", 50, 500], ["Now", 800, 900], ["click", 900, 1100], ["save", 1100, 1400], ["to", 1400, 1500], ["finish.", 1500, 1900]),
    };
    const result = plan(script, timeline);
    assert.deepEqual(result.steps, [50, 800]);
    assert.deepEqual(result.actions.map((a) => [a.step, a.atMs]), [[0, 50], [1, 1100]]);
  });

  test("caption lines break at sentences, gaps and length", () => {
    const lines = captionLines(words(["One", 0, 100], ["two.", 100, 200], ["Three", 300, 400], ["four", 2000, 2100]), 42, 700);
    assert.deepEqual(lines.map((l) => l.words.map((w) => w.text).join(" ")), ["One two.", "Three", "four"]);
    assert.equal(lines[0].end, 300);
    const long = captionLines(words(...Array.from({ length: 12 }, (_, i) => [`word${i}`, i * 100, i * 100 + 90] as [string, number, number])), 20);
    assert.ok(long.every((l) => l.words.map((w) => w.text).join(" ").length <= 20));
  });

  test("script validation", () => {
    assert.throws(() => parseScript(writeScript("u.json", { url: "javascript:x", steps: [{ say: "Hi" }] })), UsageError);
    assert.throws(() => parseScript(writeScript("a.json", { url: "https://x", steps: [{ say: "Hi", actions: [{ do: "dance" }] }] })), /unknown action/);
    assert.throws(() => parseScript(writeScript("f.json", { url: "https://x", steps: [{ say: "Hi", actions: [{ do: "fill", selector: "#a" }] }] })), /needs "text"/);
    assert.throws(() => parseScript(writeScript("t.json", { url: "https://x", steps: [{ say: "Hi", actions: [{ do: "click", selector: "#a", at: "bye" }] }] })), /not in its say/);
    assert.throws(() => parseScript(writeScript("i.json", { url: "https://x", steps: [{ say: "Hi", actions: [{ do: "image", path: "missing.png" }] }] })), /image/);
    assert.equal(narration(parseScript(writeScript("ok.json", { url: "https://x", steps: [{ say: " Hi. " }, { say: "Bye." }] }))), "Hi.\n\nBye.\n");
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("record (local page, no Azure)", { skip: !hasFfmpeg && "ffmpeg not found" }, () => {
  let script: string;
  before(() => {
    writeFileSync(join(dir, "app.html"),
      '<!doctype html><h1>Orders</h1><input id="q"><button onclick="r.textContent=q.value">Search</button><p id="r"></p>');
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=3", "-ar", "24000", "-ac", "1", join(dir, "n.wav")]);
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", join(dir, "card.png")]);
    writeFileSync(join(dir, "n.json"), JSON.stringify({
      audio: "n.wav", duration_ms: 3000,
      words: words(["Welcome.", 100, 500], ["Type", 800, 1000], ["laptops", 1000, 1400], ["and", 1500, 1600], ["search.", 1600, 2000]),
    }));
    script = writeScript("demo.json", {
      url: new URL(`file://${join(dir, "app.html")}`).href,
      steps: [
        { say: "Welcome.", actions: [{ do: "image", path: "card.png", caption: "Orders" }] },
        { say: "Type laptops", actions: [{ do: "highlight", selector: "#q", label: "Search" }, { do: "fill", selector: "#q", text: "laptops" }] },
        { say: "and search.", actions: [{ do: "click", at: "search", selector: "text=Search" }] },
      ],
    });
  });

  test("check runs every action", async () => {
    await run(["check", script]);
  });

  test("check reports a missing selector", async () => {
    const bad = writeScript("bad.json", { url: new URL(`file://${join(dir, "app.html")}`).href, steps: [{ say: "Hi", actions: [{ do: "click", selector: "#nope" }] }] });
    process.env.WT_ACTION_TIMEOUT = "500";
    try {
      await assert.rejects(run(["check", bad]), /steps\[0\] click #nope failed/);
    } finally {
      delete process.env.WT_ACTION_TIMEOUT;
    }
  });

  test("records an mp4 with video and audio", async () => {
    const output = join(dir, "out", "demo.mp4");
    await run(["record", script, "--timeline", join(dir, "n.json"), "--output", output]);
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", output], { encoding: "utf8" });
    const info = JSON.parse(probe);
    assert.deepEqual(info.streams.map((s: { codec_type: string }) => s.codec_type).sort(), ["audio", "video"]);
    assert.ok(Math.abs(Number(info.format.duration) - 4.2) < 0.3, info.format.duration);
    await assert.rejects(run(["record", script, "--timeline", join(dir, "n.json"), "--output", output]), /Refusing to overwrite/);
  });

  test("narration writes the TTS text", async () => {
    const output = join(dir, "narration.txt");
    await run(["narration", script, "--output", output]);
    assert.ok(existsSync(output));
    assert.equal(readFileSync(output, "utf8"), "Welcome.\n\nType laptops\n\nand search.\n");
  });
});
