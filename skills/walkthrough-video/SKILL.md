---
name: walkthrough-video
description: Record narrated walkthrough videos of web apps. Narration comes from foundry-tts; Playwright browser actions follow the spoken word timeline, with highlights, labels, an animated cursor, optional gpt-imagegen images and karaoke captions, producing an MP4. Use for product demos, UI tutorials, onboarding or how-to videos, feature tours and screen-recorded explainers of a website or local web app, even if the user just says "make a video showing how to use this page".
compatibility: Node 24+, ffmpeg on PATH, Playwright Chromium, and the sibling foundry-tts and gpt-imagegen skills.
---

# Walkthrough Video

Use `resources/walkthrough.ts`; don't write your own recorder. Settings and their defaults are in `.env`: 1280x720, 30 fps, captions on, and yellow `#FFD400` as the accent and caption-highlight colour. Write all outputs to the user's project, never into the skill folder.

## Workflow

1. **Explore the app.** Open the target URL with Playwright or ask the user for it. Find stable selectors for each UI element you will talk about. Prefer `#id`, `[data-testid=...]`, `role=button[name="Save"]` or `text=Save`.
2. **Write `walkthrough.json`** (format below). Explain one UI idea per step, in short, conversational sentences. Every step that talks about an on-screen element should also *show* it, with a `highlight`, `click`, `fill` or `hover`.
3. **Validate actions**, which is quick and free:
   `node <skill>/resources/walkthrough.ts check walkthrough.json`. Fix any failing selectors before going on.
4. **Create images** only when they help, using the **gpt-imagegen** skill (sibling folder `../gpt-imagegen`). Good uses are a title card, an outro, or a concept diagram for an idea the UI can't show. Use `--size 1536x1024 --background opaque`, save next to the script, and show the image with an `image` action.
5. **Narrate with the foundry-tts skill** (sibling folder `../foundry-tts`):
   ```bash
   node <skill>/resources/walkthrough.ts narration walkthrough.json --output out/narration.txt
   node <foundry-tts>/resources/tts.ts --text-file out/narration.txt --output out/narration.wav
   ```
   Add `--style`, `--voice` or `--rate` only when the user asks. Always narrate from the text that `narration` writes, because action timing is matched against it.
6. **Record:**
   `node <skill>/resources/walkthrough.ts record walkthrough.json --timeline out/narration.json --output out/walkthrough.mp4`
7. **Review before reporting.** Extract a few frames, for example `ffmpeg -ss 4 -i out/walkthrough.mp4 -frames:v 1 out/f4.png`, and view them. Check that highlights land on the right elements and that captions are readable. Fix the script and re-record if they aren't. Report the MP4 path and its duration.

The first time, run `npm install --silent` in `resources/`. If Chromium is missing, also run `npx playwright install chromium`.

## Script format

```json
{
  "url": "https://app.example.com/orders",
  "steps": [
    { "say": "Welcome to Contoso Orders.",
      "actions": [{ "do": "image", "path": "title.png", "caption": "Contoso Orders" }] },
    { "say": "Start by typing a product name in the search box.",
      "actions": [
        { "do": "highlight", "selector": "#search", "label": "Search box" },
        { "do": "fill", "at": "typing", "selector": "#search", "text": "laptops" } ] },
    { "say": "Then press Search to see matching orders.",
      "actions": [{ "do": "click", "at": "Search", "selector": "role=button[name=\"Search\"]" }] }
  ]
}
```

- Steps play in order. By default an action starts on the step's first spoken word. Use `"at": "<words from say>"` to start it on a specific phrase, so the visual lands exactly when that phrase is spoken.
- Pointer actions (`click`, `hover`, `fill`) start the cursor moving shortly before their word, so the click lands on the word.
- Highlights and images last until the next step starts. Their order and timing within a step follow the timeline.

| `do` | Fields | Effect |
| --- | --- | --- |
| `highlight` | `selector`, `label?` | Dims the page, draws a pulsing ring around the element and adds an optional callout label |
| `click` | `selector` | Animated cursor, click ripple, real click |
| `fill` | `selector`, `text` | Cursor, click, then visible typing |
| `hover` | `selector` | Cursor moves and hovers |
| `press` | `key` | Keyboard key, e.g. `Enter` |
| `scroll` | `selector` or `y` | Smooth scroll |
| `goto` | `url` (absolute or relative) | Navigate |
| `image` | `path` (relative to the script), `caption?` | Full-screen image card |

## Guidance

- **Draw attention to the UI.** Whenever the narration names a UI element, highlight it with a 1–3 word `label`, or interact with it. Highlight first, then act on a later phrase, so viewers see the element before it changes.
- **Pacing.** Each step needs enough words to cover its actions: about 1.5 s per click and 0.06 s per typed character. If the recorder warns that an action started late, lengthen that step's narration or shorten the typed text.
- **Captions** are drawn as an overlay at the bottom of the frame, and each word fills in yellow as it's spoken. They show what was actually spoken, as transcribed from the audio (or the voice's word timings). Set `WT_CAPTIONS=false` to turn them off.
- Record only sites the user is allowed to automate. Avoid real credentials and personal data on screen. Sign-in steps should use test accounts the user provides.
- The recorder never overwrites an existing output. Choose a new `--output` instead.
