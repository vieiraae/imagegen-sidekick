---
name: foundry-tts
description: Create SSML and synthesize speech with Microsoft Foundry Speech (MAI-Voice, default Harper), producing the SSML, an audio file and a JSON word timeline. Use for narration, voice-overs, dialogue, audiobook or podcast clips, lip-sync and subtitle timing, and Blender/video audio tracks — even when the user just says "read this aloud", "make a voice line" or "I need TTS".
---

# Foundry TTS

Run `resources/tts.ts` with Node 24 or later. No build step is needed. Each run writes three files with the same stem: `.ssml`, the audio, and a `.json` word timeline.

## Workflow

1. Settings come from `.env` in this skill folder. Defaults: Harper, MAI-Voice-2, en-US, pitch 1, rate 1.1, volume 1, WAV. Override a setting with a flag only when the user asks for it.
2. Plain narration: pass `--text` or `--text-file`. The script escapes the text and builds valid SSML for you.
3. Rich delivery (pauses, emphasis, several voices, or styles that change mid-text): write an SSML file and pass `--ssml-file`. It is synthesized exactly as written.
4. Run `--ssml-only` first when the user wants to review the SSML before paying for synthesis.
5. Report the three output paths. Mention the timeline `source`.

```bash
cd <skill-dir>/resources
npm install --silent   # first run only
node tts.ts --text "Welcome to the scene." --output outputs/intro.wav
node tts.ts --text-file script.txt --style narrator --rate 1 --output outputs/ch1.wav
node tts.ts --ssml-file dialogue.ssml --output outputs/dialogue.wav
```

## Choosing settings

- **Voice:** A short name like `Harper` expands to `<language>-Harper:<model>`, e.g. `en-US-Harper:MAI-Voice-2`. A full name such as `en-US-AvaNeural` is used as-is. Other MAI voices include Grant, Sage, Olivia, Ethan, Iris and Jasper (en-US), and Emily and Harry (en-GB).
- **Style** (`mstts:express-as`): pick one from the user's intent. Harper's styles are `narrator`, `audiobook`, `educational`, `agent`, `customer_call_center`, `happy`, `joyful`, `excited`, `hopeful`, `relieved`, `sad`, `regretful`, `angry`, `confused`, `determined`, `embarrassed`, `shouting`, `softvoice`, `whispering` and `neutral`. An unsupported style makes the service return `Bad MAI Request`.
- **Prosody:** `--pitch`, `--rate` and `--volume` are multipliers; `1` keeps the voice default. Stay within 0.8–1.3 so speech still sounds natural.
- **Format:** Use `wav` for Blender, video editors and lip-sync. Use `mp3` or `ogg` for small files meant for the web or sharing. All formats get a timeline.

## Word timeline

`<stem>.json` contains `audio`, `ssml`, `voice`, `language`, `duration_ms`, `source` and `words`. Each word is `{text, start_ms, end_ms, duration_ms}`.

- `source: synthesis` — taken from the voice's word-boundary events (standard neural voices).
- `source: recognition` — MAI voices emit no boundary events, so the script transcribes the audio with Speech fast transcription to get timings. Words are display text and may include punctuation (`"fans."`).
- `source: none` — alignment was disabled (`TTS_ALIGN_WITH_RECOGNITION=false`) or failed; a warning is printed.

For Blender, place the WAV on a Sequencer sound strip. Convert `start_ms` to frames with `frame = start_ms / 1000 * fps + start_frame`.

## Rules

- Authentication uses the Azure CLI identity; no keys are used. On a 401 or 403, run `az login`, then grant the **Cognitive Services Speech User** role on the Foundry resource.
- The script never overwrites existing outputs; pick a new `--output` instead.
- Speech only from voices the user is entitled to use; do not impersonate real people.
