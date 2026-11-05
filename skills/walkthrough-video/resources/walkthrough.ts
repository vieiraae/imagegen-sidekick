// Record a narrated web UI walkthrough: actions follow a foundry-tts word timeline,
// with in-page highlights, cursor, image overlays and karaoke captions.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv, promisify } from "node:util";

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POINTER_ACTIONS = new Set(["click", "hover", "fill"]);
const REQUIRED: Record<string, string[]> = {
  goto: ["url"], click: ["selector"], hover: ["selector"], fill: ["selector", "text"], press: ["key"],
  scroll: [], highlight: ["selector"], image: ["path"],
};
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
};

export type Settings = Record<string, string | undefined>;
export interface Action {
  do: string; at?: string; selector?: string; url?: string; text?: string; key?: string;
  label?: string; path?: string; caption?: string; y?: number; src?: string;
}
export interface Step { say: string; actions?: Action[] }
export interface Script { url: string; steps: Step[] }
export interface Word { text: string; start_ms: number; end_ms: number }
export interface Timeline { audio: string; duration_ms: number; words: Word[] }
export interface PlannedAction { step: number; atMs: number; action: Action }
export interface CaptionLine { start: number; end: number; words: Word[] }

export class UsageError extends Error {}

export function loadSettings(): Settings {
  const read = (name: string) => {
    const path = join(SKILL_DIR, name);
    return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  };
  return { ...read(".env"), ...read(".env.local"), ...process.env };
}

export function parseScript(path: string): Script {
  let script: Script;
  try {
    script = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`Cannot read script ${path}: ${(error as Error).message}`);
  }
  const fail = (message: string) => { throw new UsageError(`Script: ${message}`); };
  if (!/^(https?|file):/.test(script?.url ?? "")) fail("url must be an http(s) or file URL");
  if (!Array.isArray(script.steps) || !script.steps.length) fail("steps must be a non-empty array");
  script.steps.forEach((step, i) => {
    if (typeof step.say !== "string" || !tokens(step.say).length) fail(`steps[${i}].say must contain words`);
    for (const action of step.actions ?? []) {
      const fields = REQUIRED[action.do];
      if (!fields) fail(`steps[${i}] has unknown action "${action.do}"; use ${Object.keys(REQUIRED).join(", ")}`);
      for (const field of fields) {
        if (action[field as keyof Action] === undefined) fail(`steps[${i}] ${action.do} needs "${field}"`);
      }
      if (action.do === "scroll" && action.selector === undefined && action.y === undefined) {
        fail(`steps[${i}] scroll needs "selector" or "y"`);
      }
      if (action.at !== undefined && !findPhrase(tokens(step.say), tokens(action.at))) {
        fail(`steps[${i}] at "${action.at}" is not in its say text`);
      }
      if (action.do === "image") {
        const file = resolve(dirname(path), action.path!);
        const type = IMAGE_TYPES[extname(file).toLowerCase()];
        if (!type || !existsSync(file)) fail(`steps[${i}] image ${file} must be an existing PNG, JPEG, WebP or GIF`);
        action.src = `data:${type};base64,${readFileSync(file).toString("base64")}`;
      }
    }
  });
  return script;
}

export const narration = (script: Script) => script.steps.map((step) => step.say.trim()).join("\n\n") + "\n";

export const tokens = (text: string) =>
  text.split(/\s+/).map((t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);

function findPhrase(haystack: string[], needle: string[]): number | undefined {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((t, j) => haystack[i + j] === t)) return i;
  }
  return undefined;
}

// Map each script token to a spoken time; unmatched tokens are interpolated.
export function tokenTimes(scriptTokens: string[], timeline: Timeline): number[] {
  const spoken = timeline.words.map((w) => tokens(w.text).join(""));
  const n = scriptTokens.length;
  const m = spoken.length;
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = scriptTokens[i] === spoken[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const times: (number | undefined)[] = Array.from({ length: n });
  for (let i = 0, j = 0; i < n && j < m;) {
    if (scriptTokens[i] === spoken[j]) times[i++] = timeline.words[j++].start_ms;
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  return times.map((time, i) => {
    if (time !== undefined) return time;
    let p = i - 1;
    while (p >= 0 && times[p] === undefined) p--;
    let q = i + 1;
    while (q < n && times[q] === undefined) q++;
    const [t0, i0] = p >= 0 ? [times[p]!, p] : [0, -1];
    const [t1, i1] = q < n ? [times[q]!, q] : [timeline.duration_ms, n];
    return Math.round(t0 + ((t1 - t0) * (i - i0)) / (i1 - i0));
  });
}

export function plan(script: Script, timeline: Timeline): { steps: number[]; actions: PlannedAction[] } {
  const stepTokens = script.steps.map((s) => tokens(s.say));
  const times = tokenTimes(stepTokens.flat(), timeline);
  const steps: number[] = [];
  const actions: PlannedAction[] = [];
  let offset = 0;
  stepTokens.forEach((toks, step) => {
    steps.push(times[offset]);
    for (const action of script.steps[step].actions ?? []) {
      const index = action.at === undefined ? 0 : findPhrase(toks, tokens(action.at))!;
      actions.push({ step, atMs: times[offset + index], action });
    }
    offset += toks.length;
  });
  return { steps, actions };
}

export function captionLines(words: Word[], maxChars = 42, maxGapMs = 700): CaptionLine[] {
  const lines: CaptionLine[] = [];
  let current: Word[] = [];
  const flush = () => {
    if (current.length) lines.push({ start: current[0].start_ms, end: current.at(-1)!.end_ms, words: current });
    current = [];
  };
  for (const word of words) {
    const prev = current.at(-1);
    const length = current.reduce((sum, w) => sum + w.text.length + 1, word.text.length);
    if (prev && (length > maxChars || word.start_ms - prev.end_ms > maxGapMs || /[.!?]$/.test(prev.text))) flush();
    current.push(word);
  }
  flush();
  lines.forEach((line, i) => {
    line.end = Math.min(line.end + 400, lines[i + 1]?.start ?? Infinity);
  });
  return lines;
}

interface OverlayConfig {
  t0: number; lines: CaptionLine[]; captions: boolean; size: number; color: string; highlight: string; accent: string;
}

// Runs inside the page (serialized by Playwright); keep it self-contained.
function overlay(cfg: OverlayConfig) {
  const w = window as any;
  if (w.__wt) return;
  const host = document.createElement("wt-overlay");
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    *{box-sizing:border-box;font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
    .ring{position:fixed;display:none;border:3px solid ${cfg.accent};border-radius:10px;
      box-shadow:0 0 0 200vmax rgba(0,0,0,.45),0 0 18px ${cfg.accent};transition:all .3s ease;animation:pulse 1.4s infinite}
    @keyframes pulse{50%{box-shadow:0 0 0 200vmax rgba(0,0,0,.45),0 0 4px ${cfg.accent}}}
    .label{position:fixed;display:none;background:${cfg.accent};color:#111;font-weight:700;font-size:20px;
      padding:8px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4);white-space:nowrap}
    .cursor{position:fixed;display:none;width:30px;height:30px;transform:translate(-4px,-2px);
      transition-property:left,top;transition-timing-function:cubic-bezier(.4,0,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))}
    .ripple{position:fixed;width:16px;height:16px;margin:-8px;border-radius:50%;border:3px solid ${cfg.accent};animation:ripple .6s ease-out forwards}
    @keyframes ripple{to{transform:scale(4);opacity:0}}
    .image{position:fixed;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:18px;
      background:rgba(12,12,16,.94);animation:fade .4s}
    .image img{max-width:86%;max-height:72%;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.6)}
    .image div{color:#fff;font-size:30px;font-weight:700}
    @keyframes fade{from{opacity:0}}
    .captions{position:fixed;left:50%;bottom:5%;transform:translateX(-50%);display:none;max-width:90%;
      background:rgba(0,0,0,.72);border-radius:12px;padding:10px 20px;font-size:${cfg.size}px;font-weight:700;
      line-height:1.25;text-align:center;white-space:nowrap}
    .captions span{background:linear-gradient(90deg,${cfg.highlight} var(--p,0%),${cfg.color} var(--p,0%));
      -webkit-background-clip:text;background-clip:text;color:transparent}
  </style>
  <div class="ring"></div><div class="label"></div><div class="image"></div>
  <div class="captions"></div>
  <svg class="cursor" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.6L21 10.8z" fill="#fff" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  const $ = (s: string) => root.querySelector(s) as HTMLElement;
  const [ring, label, image, captions, cursor] = [".ring", ".label", ".image", ".captions", ".cursor"].map($);
  let target: Element | null = null;
  let line = -1;
  const mount = () => {
    if (!document.documentElement) return requestAnimationFrame(mount);
    document.documentElement.appendChild(host);
  };
  mount();
  const frame = () => {
    if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
    if (target) {
      const r = target.getBoundingClientRect();
      Object.assign(ring.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
      if (label.style.display !== "none") {
        const below = r.top < 70;
        const left = Math.max(8, Math.min(r.left, innerWidth - label.offsetWidth - 8));
        Object.assign(label.style, { left: `${left}px`, top: `${below ? r.bottom + 14 : r.top - label.offsetHeight - 14}px` });
      }
    }
    if (cfg.captions) {
      const now = Date.now() - cfg.t0;
      const index = cfg.lines.findIndex((l) => now >= l.start && now < l.end);
      if (index !== line) {
        line = index;
        captions.style.display = index < 0 ? "none" : "block";
        captions.replaceChildren(...(index < 0 ? [] : cfg.lines[index].words.flatMap((word, i) => {
          const span = document.createElement("span");
          span.textContent = word.text;
          return i ? [document.createTextNode(" "), span] : [span];
        })));
      }
      if (index >= 0) {
        captions.querySelectorAll("span").forEach((span, i) => {
          const word = cfg.lines[index].words[i];
          const p = Math.max(0, Math.min(1, (now - word.start_ms) / Math.max(1, word.end_ms - word.start_ms)));
          span.style.setProperty("--p", `${p * 100}%`);
        });
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  w.__wt = {
    highlight(el: Element, text?: string) {
      target = el;
      ring.style.display = "block";
      label.textContent = text ?? "";
      label.style.display = text ? "block" : "none";
    },
    moveTo(el: Element, from: { x: number; y: number } | null, ms: number) {
      const r = el.getBoundingClientRect();
      const to = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      if (cursor.style.display !== "block") {
        const start = from ?? { x: innerWidth / 2, y: innerHeight / 2 };
        Object.assign(cursor.style, { transitionDuration: "0ms", left: `${start.x}px`, top: `${start.y}px`, display: "block" });
        cursor.getBoundingClientRect();
      }
      Object.assign(cursor.style, { transitionDuration: `${ms}ms`, left: `${to.x}px`, top: `${to.y}px` });
      return to;
    },
    ripple(x: number, y: number) {
      const dot = document.createElement("div");
      dot.className = "ripple";
      Object.assign(dot.style, { left: `${x}px`, top: `${y}px` });
      root.appendChild(dot);
      setTimeout(() => dot.remove(), 700);
    },
    image(src: string, caption?: string) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = caption ?? "";
      const title = document.createElement("div");
      title.textContent = caption ?? "";
      image.replaceChildren(img, title);
      image.style.display = "flex";
    },
    clear() {
      target = null;
      ring.style.display = label.style.display = image.style.display = "none";
    },
  };
}

interface RunOptions { timing: boolean; cursorMs: number; log: (message: string) => void }
type Page = import("playwright").Page;

async function perform(page: Page, { action, step }: PlannedAction, state: { cursor: { x: number; y: number } | null }, opts: RunOptions) {
  const locator = action.selector ? page.locator(action.selector).first() : undefined;
  const moveCursor = async () => {
    await locator!.scrollIntoViewIfNeeded();
    state.cursor = await locator!.evaluate(
      (el, a) => (window as any).__wt?.moveTo(el, a.from, a.ms) ?? null,
      { from: state.cursor, ms: opts.timing ? opts.cursorMs : 0 },
    );
    if (opts.timing) await page.waitForTimeout(opts.cursorMs);
  };
  try {
    switch (action.do) {
      case "goto":
        await page.goto(new URL(action.url!, page.url()).href, { waitUntil: "load" });
        break;
      case "click":
        await moveCursor();
        if (state.cursor) await page.evaluate((p) => (window as any).__wt?.ripple(p.x, p.y), state.cursor);
        await locator!.click();
        break;
      case "hover":
        await moveCursor();
        await locator!.hover();
        break;
      case "fill":
        await moveCursor();
        await locator!.click();
        await locator!.fill("");
        await locator!.pressSequentially(action.text!, { delay: opts.timing ? 55 : 0 });
        break;
      case "press":
        await page.keyboard.press(action.key!);
        break;
      case "scroll":
        if (locator) await locator.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
        else await page.evaluate((y) => scrollBy({ top: y, behavior: "smooth" }), action.y!);
        break;
      case "highlight":
        await locator!.scrollIntoViewIfNeeded();
        await locator!.evaluate((el, text) => (window as any).__wt?.highlight(el, text), action.label);
        break;
      case "image":
        await page.evaluate((a) => (window as any).__wt?.image(a.src, a.caption), { src: action.src!, caption: action.caption });
        break;
    }
  } catch (error) {
    throw new Error(`steps[${step}] ${action.do} ${action.selector ?? action.url ?? ""} failed: ${(error as Error).message.split("\n")[0]}`);
  }
}

const sleepUntil = (time: number) => new Promise((done) => setTimeout(done, Math.max(0, time - Date.now())));

async function browse(script: Script, timeline: Timeline | null, settings: Settings, videoDir?: string) {
  const { chromium } = await import("playwright");
  const width = Number(settings.WT_WIDTH || 1280);
  const height = Number(settings.WT_HEIGHT || 720);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1, bypassCSP: true,
    ...(videoDir ? { recordVideo: { dir: videoDir, size: { width, height } } } : {}),
  });
  try {
    const page = await context.newPage();
    const created = Date.now();
    page.setDefaultTimeout(Number(settings.WT_ACTION_TIMEOUT || 15000));
    await page.goto(script.url, { waitUntil: "load" });
    const planned = timeline
      ? plan(script, timeline)
      : { steps: script.steps.map(() => 0), actions: script.steps.flatMap((s, step) => (s.actions ?? []).map((action) => ({ step, atMs: 0, action }))) };
    const cfg: OverlayConfig = {
      t0: Date.now() + 300,
      lines: timeline ? captionLines(timeline.words) : [],
      captions: !!timeline && !["0", "false", "no"].includes(String(settings.WT_CAPTIONS).toLowerCase()),
      size: Number(settings.WT_CAPTION_SIZE || 34),
      color: settings.WT_CAPTION_COLOR || "#FFFFFF",
      highlight: settings.WT_CAPTION_HIGHLIGHT || "#FFD400",
      accent: settings.WT_ACCENT || "#FFD400",
    };
    await context.addInitScript(overlay, cfg);
    await page.evaluate(overlay, cfg);
    const opts: RunOptions = { timing: !!timeline, cursorMs: Number(settings.WT_CURSOR_MS || 600), log: console.error };
    const state = { cursor: null };
    const events = [
      ...planned.steps.map((atMs, step) => ({ step, atMs, action: { do: "clear" } as Action })),
      ...planned.actions,
    ].sort((a, b) => a.atMs - b.atMs || (a.action.do === "clear" ? -1 : b.action.do === "clear" ? 1 : 0));
    for (const event of events) {
      if (timeline) {
        const lead = POINTER_ACTIONS.has(event.action.do) ? opts.cursorMs : 0;
        await sleepUntil(cfg.t0 + event.atMs - lead);
        const late = Date.now() - (cfg.t0 + event.atMs - lead);
        if (late > 500) opts.log(`Warning: steps[${event.step}] ${event.action.do} started ${late} ms late`);
      }
      if (event.action.do === "clear") await page.evaluate(() => (window as any).__wt?.clear()).catch(() => {});
      else await perform(page, event, state, opts);
    }
    if (timeline) await sleepUntil(cfg.t0 + timeline.duration_ms + Number(settings.WT_TAIL_MS || 1200));
    return { offsetMs: cfg.t0 - created, video: page.video() };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function encode(video: string, audio: string, output: string, offsetMs: number, durationMs: number, settings: Settings) {
  await promisify(execFile)(settings.WT_FFMPEG || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-ss", String(offsetMs / 1000), "-i", video, "-i", audio,
    "-map", "0:v:0", "-map", "1:a:0", "-t", String(durationMs / 1000),
    "-vf", `fps=${Number(settings.WT_FPS || 30)},format=yuv420p`, "-c:v", "libx264", "-preset", "medium",
    "-crf", String(Number(settings.WT_CRF || 20)), "-c:a", "aac", "-b:a", "192k", "-af", "apad", "-movflags", "+faststart", output,
  ]);
}

const USAGE = `Usage: node walkthrough.ts <command> SCRIPT.json [options]
  narration SCRIPT --output narration.txt   Write the text to send to foundry-tts
  check SCRIPT                              Run every action quickly, without recording
  record SCRIPT --timeline narration.json --output video.mp4
                                            Record actions on the word timeline and add audio`;

export async function run(argv: string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: { output: { type: "string" }, timeline: { type: "string" }, help: { type: "boolean", default: false } },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return void console.log(USAGE);
  const [command, scriptPath] = positionals;
  if (!["narration", "check", "record"].includes(command) || !scriptPath || positionals.length !== 2) {
    throw new UsageError("Pass a command (narration, check or record) and one script path");
  }
  const script = parseScript(scriptPath);
  const settings = loadSettings();
  if (command === "check") {
    await browse(script, null, settings);
    return void console.log(`OK: ${script.steps.length} steps`);
  }
  if (!values.output) throw new UsageError("--output is required");
  const output = resolve(values.output);
  if (existsSync(output)) throw new Error(`Refusing to overwrite ${output}`);
  mkdirSync(dirname(output), { recursive: true });
  if (command === "narration") {
    writeFileSync(output, narration(script), { flag: "wx" });
    return void console.log(output);
  }
  if (extname(output).toLowerCase() !== ".mp4") throw new UsageError("--output must end with .mp4");
  if (!values.timeline) throw new UsageError("--timeline is required (the .json written by foundry-tts)");
  const timeline: Timeline = JSON.parse(readFileSync(values.timeline, "utf8"));
  if (!timeline.words?.length) throw new Error("Timeline has no words; rerun foundry-tts with TTS_ALIGN_WITH_RECOGNITION=true");
  const audio = resolve(dirname(values.timeline), timeline.audio);
  if (!existsSync(audio)) throw new Error(`Audio not found: ${audio}`);
  const temp = mkdtempSync(join(tmpdir(), "walkthrough-"));
  try {
    const { offsetMs, video } = await browse(script, timeline, settings, temp);
    await encode(await video!.path(), audio, output, offsetMs, timeline.duration_ms + Number(settings.WT_TAIL_MS || 1200), settings);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  console.log(output);
}

async function main() {
  try {
    await run(process.argv.slice(2));
    return 0;
  } catch (error) {
    console.error(`Walkthrough failed: ${(error as Error).message}`);
    if (error instanceof UsageError) console.error(USAGE);
    return error instanceof UsageError ? 2 : 1;
  }
}

if (import.meta.main) process.exitCode = await main();
