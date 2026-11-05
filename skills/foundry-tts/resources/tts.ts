// Create SSML, synthesize speech with the Foundry Speech SDK and write a word timeline.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import type { TokenCredential } from "@azure/identity";
import { XMLValidator } from "fast-xml-parser";

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const AUDIO_FORMATS = {
  wav: ["Riff24Khz16BitMonoPcm", ".wav"],
  mp3: ["Audio24Khz160KBitRateMonoMp3", ".mp3"],
  ogg: ["Ogg24Khz16BitMonoOpus", ".ogg"],
} as const;
type AudioFormat = keyof typeof AUDIO_FORMATS;
const PROSODY_LIMITS = { pitch: [0.5, 2], rate: [0.5, 2], volume: [0, 2] } as const;
type Prosody = keyof typeof PROSODY_LIMITS;
const TICKS_PER_MS = 10_000;

export type Settings = Record<string, string | undefined>;
export interface Word { text: string; start_ms: number; end_ms: number; duration_ms: number; confidence?: number }
export interface Synthesis { audio: Uint8Array; durationMs: number; words: Word[] }
interface ServiceOptions { endpoint: string; credential: TokenCredential }
export interface Deps {
  credential?: TokenCredential;
  synthesize?: (ssml: string, options: ServiceOptions & { audioFormat: AudioFormat }) => Promise<Synthesis>;
  recognizeWords?: (audio: Uint8Array, options: ServiceOptions & { language: string; timeoutMs: number }) => Promise<Word[]>;
}

export class UsageError extends Error {}

export function loadSettings(): Settings {
  const defaults = join(SKILL_DIR, ".env");
  if (!existsSync(defaults)) throw new Error(`Missing defaults: ${defaults}`);
  const local = join(SKILL_DIR, ".env.local");
  return {
    ...parseEnv(readFileSync(defaults, "utf8")),
    ...(existsSync(local) ? parseEnv(readFileSync(local, "utf8")) : {}),
    ...process.env,
  };
}

export function multiplier(value: string, name: Prosody): number {
  const text = String(value).trim().replace(",", ".");
  const number = text === "" ? NaN : Number(text);
  const [low, high] = PROSODY_LIMITS[name];
  if (!Number.isFinite(number) || number < low || number > high) {
    throw new UsageError(`${name} must be a number between ${low} and ${high}, such as 1 or 1.1`);
  }
  return number;
}

export function speechEndpoint(settings: Settings): string {
  const raw = settings.SPEECH_ENDPOINT || settings.FOUNDRY_PROJECT_ENDPOINT || "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("FOUNDRY_PROJECT_ENDPOINT must be an HTTPS URL without credentials");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("FOUNDRY_PROJECT_ENDPOINT must be an HTTPS URL without credentials");
  }
  const [resource, ...rest] = url.hostname.split(".");
  const domain = rest.join(".");
  if (domain === "services.ai.azure.com" || domain === "cognitiveservices.azure.com") {
    return `https://${resource}.cognitiveservices.azure.com/`;
  }
  return `https://${url.hostname}/`;
}

export function voiceName(voice: string, model: string, language: string): string {
  if (voice.includes("-") || voice.includes(":")) return voice;
  return model ? `${language}-${voice}:${model}` : `${language}-${voice}Neural`;
}

const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (value: string) => `"${escapeText(value).replace(/"/g, "&quot;")}"`;
const percent = (value: number) => {
  const n = Math.round((value - 1) * 100);
  return `${n < 0 ? "" : "+"}${n === 0 ? 0 : n}%`;
};

export function buildSsml(
  text: string,
  { voice, language, pitch = 1, rate = 1, volume = 1, style = "" }:
    { voice: string; language: string; pitch?: number; rate?: number; volume?: number; style?: string },
): string {
  let body = escapeText(text.trim());
  if (pitch !== 1 || rate !== 1 || volume !== 1) {
    body = `<prosody rate="${percent(rate)}" pitch="${percent(pitch)}" volume="${percent(volume)}">${body}</prosody>`;
  }
  if (style) body = `<mstts:express-as style=${attr(style)}>${body}</mstts:express-as>`;
  return (
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ' +
    `xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang=${attr(language)}>\n` +
    `  <voice name=${attr(voice)}>${body}</voice>\n</speak>\n`
  );
}

export function ssmlVoice(ssml: string): string {
  const valid = XMLValidator.validate(ssml);
  if (valid !== true) throw new Error(`Invalid SSML: ${valid.err.msg} (line ${valid.err.line})`);
  if (!/^\s*(<\?xml[^>]*>\s*)?<speak[\s>]/.test(ssml)) throw new Error("SSML root element must be <speak>");
  const match = /<voice\b[^>]*\bname\s*=\s*(["'])(.*?)\1/s.exec(ssml);
  if (!match?.[2]) throw new Error("SSML must contain a <voice name=...> element");
  return match[2];
}

export function word(text: string, offsetTicks: number, durationTicks: number, extra: Partial<Word> = {}): Word {
  const start = Math.round(offsetTicks / TICKS_PER_MS);
  const duration = Math.round(durationTicks / TICKS_PER_MS);
  return { text, start_ms: start, end_ms: start + duration, duration_ms: duration, ...extra };
}

async function loadSdk() {
  return (await import("microsoft-cognitiveservices-speech-sdk")).default;
}

function serviceError(reason: unknown, code: unknown, details: string): Error {
  return new Error(
    `Speech service error: ${reason}; code=${code}; ${details}. Check 'az login', the Speech ` +
      "endpoint, the voice name and style, and that your identity has the 'Cognitive Services Speech User' role.",
  );
}

export async function synthesize(
  ssml: string,
  { endpoint, credential, audioFormat }: ServiceOptions & { audioFormat: AudioFormat },
): Promise<Synthesis> {
  const sdk = await loadSdk();
  const config = sdk.SpeechConfig.fromEndpoint(new URL(endpoint), credential);
  config.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat[AUDIO_FORMATS[audioFormat][0]];
  config.setProperty(sdk.PropertyId.SpeechServiceResponse_RequestWordBoundary, "true");
  const synthesizer = new sdk.SpeechSynthesizer(config, null);
  const words: Word[] = [];
  synthesizer.wordBoundary = (_sender, event) => {
    if (event.boundaryType === sdk.SpeechSynthesisBoundaryType.Word) {
      words.push(word(event.text, event.audioOffset, event.duration));
    }
  };
  try {
    const result = await new Promise<InstanceType<typeof sdk.SpeechSynthesisResult>>((done, fail) =>
      synthesizer.speakSsmlAsync(ssml, done, (error) => fail(new Error(String(error)))),
    );
    if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
      const details = sdk.CancellationDetails.fromResult(result);
      throw serviceError(sdk.CancellationReason[details.reason], sdk.CancellationErrorCode[details.ErrorCode], details.errorDetails);
    }
    return {
      audio: new Uint8Array(result.audioData),
      durationMs: Math.round(result.audioDuration / TICKS_PER_MS),
      words,
    };
  } finally {
    synthesizer.close();
  }
}

export async function recognizeWords(
  audio: Uint8Array,
  { endpoint, credential, language, timeoutMs }: ServiceOptions & { language: string; timeoutMs: number },
): Promise<Word[]> {
  const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
  if (!token) throw new Error("Timeline alignment failed: no access token");
  const form = new FormData();
  form.append("audio", new Blob([audio]), "audio");
  form.append("definition", JSON.stringify({ locales: [language] }));
  const response = await fetch(new URL("speechtotext/transcriptions:transcribe?api-version=2024-11-15", endpoint), {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Timeline alignment failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const result = await response.json() as {
    phrases?: { words?: { text: string; offsetMilliseconds: number; durationMilliseconds: number; confidence?: number }[] }[];
  };
  return (result.phrases ?? []).flatMap((phrase) => phrase.words ?? []).map((item) =>
    word(item.text, item.offsetMilliseconds * TICKS_PER_MS, item.durationMilliseconds * TICKS_PER_MS,
      item.confidence === undefined ? {} : { confidence: Math.round(item.confidence * 1000) / 1000 }));
}

const USAGE = `Usage: node tts.ts (--text TEXT | --text-file PATH | --ssml-file PATH) --output AUDIO
  [--voice V] [--model M] [--language L] [--pitch N] [--rate N] [--volume N]
  [--style S] [--audio-format wav|mp3|ogg] [--ssml-only]
Writes <stem>.ssml, the audio and <stem>.json (word timeline) beside --output.`;

export async function run(argv: string[], deps: Deps = {}) {
  const settings = loadSettings();
  const setting = (name: string) => settings[`TTS_${name.toUpperCase()}`] ?? "";
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      options: {
        text: { type: "string" }, "text-file": { type: "string" }, "ssml-file": { type: "string" },
        output: { type: "string" }, voice: { type: "string", default: setting("voice") },
        model: { type: "string", default: setting("model") }, language: { type: "string", default: setting("language") },
        pitch: { type: "string", default: setting("pitch") }, rate: { type: "string", default: setting("rate") },
        volume: { type: "string", default: setting("volume") }, style: { type: "string", default: setting("style") },
        "audio-format": { type: "string", default: setting("audio_format") },
        "ssml-only": { type: "boolean", default: false }, help: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const args = parsed.values;
  if (args.help) {
    console.log(USAGE);
    return {};
  }
  const sources = [args.text, args["text-file"], args["ssml-file"]].filter((value) => value !== undefined);
  if (sources.length !== 1) throw new UsageError("Pass exactly one of --text, --text-file or --ssml-file");
  if (!args.output) throw new UsageError("--output is required");
  const audioFormat = args["audio-format"] as AudioFormat;
  if (!Object.hasOwn(AUDIO_FORMATS, audioFormat)) {
    throw new UsageError(`--audio-format must be one of ${Object.keys(AUDIO_FORMATS).join(", ")}`);
  }
  const output = resolve(args.output);
  if (extname(output).toLowerCase() !== AUDIO_FORMATS[audioFormat][1]) {
    throw new UsageError(`--output must end with ${AUDIO_FORMATS[audioFormat][1]}`);
  }
  if (!args.voice || !args.language) throw new UsageError("TTS_VOICE and TTS_LANGUAGE are required");

  let ssml: string;
  if (args["ssml-file"]) {
    ssml = readFileSync(args["ssml-file"], "utf8");
  } else {
    const text = args.text ?? readFileSync(args["text-file"]!, "utf8");
    if (!text.trim()) throw new UsageError("Text must not be empty");
    ssml = buildSsml(text, {
      voice: voiceName(args.voice, args.model ?? "", args.language),
      language: args.language,
      style: (args.style ?? "").trim(),
      pitch: multiplier(args.pitch ?? "", "pitch"),
      rate: multiplier(args.rate ?? "", "rate"),
      volume: multiplier(args.volume ?? "", "volume"),
    });
  }
  const voice = ssmlVoice(ssml);

  const stem = output.slice(0, -extname(output).length);
  const ssmlPath = `${stem}.ssml`;
  const timelinePath = `${stem}.json`;
  const targets = args["ssml-only"] ? [ssmlPath] : [ssmlPath, output, timelinePath];
  const existing = targets.filter((path) => existsSync(path));
  if (existing.length) throw new Error(`Refusing to overwrite ${existing.join(", ")}`);
  mkdirSync(dirname(output), { recursive: true });
  if (args["ssml-only"]) {
    writeFileSync(ssmlPath, ssml, { flag: "wx" });
    console.log(ssmlPath);
    return { ssml: ssmlPath };
  }

  const endpoint = speechEndpoint(settings);
  const timeoutMs = Number(settings.TTS_TIMEOUT || 300) * 1000;
  if (!(timeoutMs > 0 && Number.isFinite(timeoutMs))) throw new Error("TTS_TIMEOUT must be positive and finite");
  let credential = deps.credential;
  if (!credential) {
    const { AzureCliCredential } = await import("@azure/identity");
    credential = new AzureCliCredential();
  }
  const service = { endpoint, credential };
  const synthesis = await (deps.synthesize ?? synthesize)(ssml, { ...service, audioFormat });
  writeFileSync(ssmlPath, ssml, { flag: "wx" });
  writeFileSync(output, synthesis.audio, { flag: "wx" });

  let words = synthesis.words;
  let source = words.length ? "synthesis" : "none";
  const align = ["1", "true", "yes"].includes(String(settings.TTS_ALIGN_WITH_RECOGNITION ?? "true").toLowerCase());
  if (!words.length && align) {
    try {
      words = await (deps.recognizeWords ?? recognizeWords)(synthesis.audio, { ...service, language: args.language, timeoutMs });
      source = words.length ? "recognition" : "none";
    } catch (error) {
      console.error(`Warning: ${(error as Error).message}`);
    }
  }
  const timeline = {
    audio: basename(output),
    ssml: basename(ssmlPath),
    voice,
    language: args.language,
    duration_ms: synthesis.durationMs,
    source,
    words,
  };
  writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`, { flag: "wx" });
  for (const path of [ssmlPath, output, timelinePath]) console.log(path);
  return { ssml: ssmlPath, audio: output, timeline: timelinePath };
}

async function main() {
  try {
    await run(process.argv.slice(2));
    return 0;
  } catch (error) {
    const err = error as Error;
    if (err.name === "CredentialUnavailableError" || err.name === "AuthenticationError") {
      console.error(
        "Azure CLI authentication failed. Run 'az login' in the resource's tenant and " +
          "'az account set --subscription <subscription>'.",
      );
    } else {
      console.error(`Speech synthesis failed: ${err.message}`);
      if (err instanceof UsageError) console.error(USAGE);
    }
    return err instanceof UsageError ? 2 : 1;
  }
}

if (import.meta.main) process.exitCode = await main();
