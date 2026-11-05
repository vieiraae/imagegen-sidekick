# imagegen-sidekick

A portable Agent Plugins 1.0 plugin bundling media-generation skills:

- **gpt-imagegen** generates and edits images using the OpenAI Images API
  against Azure OpenAI, with guidance for Blender-ready 2D assets.
- **foundry-tts** creates SSML and synthesizes speech with the Foundry Speech
  SDK (MAI-Voice-2, Harper), writing the SSML, audio and a JSON word timeline.
- **walkthrough-video** records narrated web app walkthroughs (MP4) with
  Playwright. Actions follow the foundry-tts word timeline, with highlights,
  labels, an animated cursor, gpt-imagegen image cards and karaoke captions.

## Install and configure

```sh
copilot plugin install .
```

Or, after publishing this repository:

```sh
copilot plugin install vieiraae/imagegen-sidekick
```

Restart the session and check `/skills list`. Each skill installs its dependencies
on first use. For manual setup from the plugin root:

```sh
python3 -m venv skills/gpt-imagegen/resources/.venv
skills/gpt-imagegen/resources/.venv/bin/python -m pip install -r skills/gpt-imagegen/resources/requirements.txt
```

Install Azure CLI and sign in with your identity:

```sh
az login
az account set --subscription "<subscription-name-or-id>"
```

For a different directory, use `az login --tenant "<tenant-id>"`. Your identity
needs Azure OpenAI data-plane access, such as **Cognitive Services OpenAI User**
on the `foundry-imagegen` resource. Subscription Reader/Contributor alone does
not grant model-inference access.

The script uses `AzureCliCredential` with a refreshable bearer-token provider,
not API keys or a default credential chain. Copilot must run as the same OS user
with access to `az` and its login session. No credentials belong in `.env` or
`.env.local`; the latter is only for local setting overrides.
Installed plugins are cached: reinstall to pick up changes.

Defaults in [`skills/gpt-imagegen/.env`](skills/gpt-imagegen/.env):

| Setting | Default |
| --- | --- |
| Azure v1 endpoint | `https://foundry-imagegen.openai.azure.com/openai/v1` |
| Entra token scope | `https://ai.azure.com/.default` |
| Model/deployment | `gpt-image-2.5-sunburst` |
| Size | `1024x1024`; landscape `1536x1024` and portrait `1024x1536` supported |
| Quality | `auto`; also `low`, `medium`, `high`, `xhigh`, `max` |
| Background | `transparent`; choose `opaque` for scenes/textures, or `auto` |
| Format | `png`; also `jpeg` (opaque only) and `webp` |
| Moderation | `low` (provider safety filtering remains active) |
| Timeout / automatic retries | 180 seconds / 0 (avoid duplicate paid requests) |

Precedence: `.env` < `.env.local` < process environment < CLI flags.
Azure must already have the named deployment and support the requested parameters;
the plugin does not provision it or silently fall back to another model.

## Use

Ask Copilot to "generate a transparent leaf decal for Blender" or "edit this
photo to replace the sky, preserving the buildings." For direct CLI use:

```sh
skills/gpt-imagegen/resources/.venv/bin/python skills/gpt-imagegen/resources/imagegen.py generate \
  --prompt "Seamless stone base-color texture, orthographic, evenly lit, no shadows" \
  --background opaque --quality high --output outputs/stone.png

skills/gpt-imagegen/resources/.venv/bin/python skills/gpt-imagegen/resources/imagegen.py edit \
  --image source.png --mask mask.png --prompt "Replace only the masked area with moss" \
  --background opaque --output outputs/moss.png
```

Use a new output path for each run; existing files are never overwritten.
Repeat `--image` for references. See the [concise skill](skills/gpt-imagegen/SKILL.md)
for mask rules and asset guidance. Generated assets are images, not meshes,
calibrated PBR maps, or HDR environments; inspect them before use in Blender.

## foundry-tts

Written in TypeScript and run directly by Node 24+ (no Python, no build step):

```sh
npm install --prefix skills/foundry-tts/resources
```

It also uses `AzureCliCredential`; your identity needs **Cognitive Services
Speech User** on the Foundry resource. The Speech endpoint is derived from the
project endpoint (`<resource>.services.ai.azure.com` →
`<resource>.cognitiveservices.azure.com`); set `SPEECH_ENDPOINT` to override.

Defaults in [`skills/foundry-tts/.env`](skills/foundry-tts/.env):

| Setting | Default |
| --- | --- |
| Foundry project endpoint | `https://foundry-imagegen.services.ai.azure.com/api/projects/proj-imagegen` |
| Voice / model / language | `Harper` / `MAI-Voice-2` / `en-US` → `en-US-Harper:MAI-Voice-2` |
| Pitch / rate / volume (multipliers) | `1` / `1.1` / `1` |
| Style (`mstts:express-as`) | none; e.g. `narrator`, `happy`, `whispering` |
| Audio format | `wav` (24 kHz 16-bit mono PCM); also `mp3`, `ogg` |
| Recognition-aligned timeline | `true` (MAI voices emit no word-boundary events; uses Speech fast transcription) |
| Timeout | 300 seconds |

```sh
node skills/foundry-tts/resources/tts.ts \
  --text "Welcome to the scene." --style narrator --output outputs/intro.wav
```

This writes `outputs/intro.ssml`, `outputs/intro.wav` and `outputs/intro.json`
(`words[]` with `start_ms`/`end_ms`). Use `--ssml-file` for hand-written SSML and
`--ssml-only` to preview SSML without calling the service.

## walkthrough-video

Requires Node 24+ and `ffmpeg` on `PATH`:

```sh
npm install --prefix skills/walkthrough-video/resources
npx --prefix skills/walkthrough-video/resources playwright install chromium   # if missing
```

Describe the walkthrough as JSON steps: `say` is the narration, and `actions`
are `highlight`, `click`, `fill`, `hover`, `press`, `scroll`, `goto` or
`image`, optionally anchored to a phrase with `at`. Then:

```sh
W=skills/walkthrough-video/resources/walkthrough.ts
node $W check walkthrough.json
node $W narration walkthrough.json --output out/narration.txt
node skills/foundry-tts/resources/tts.ts --text-file out/narration.txt --output out/narration.wav
node $W record walkthrough.json --timeline out/narration.json --output out/walkthrough.mp4
```

Highlights, cursor, image cards and karaoke captions are drawn in the page
during recording. ffmpeg only trims the video, adds the audio and encodes
H.264/AAC. Defaults (1280x720, 30 fps, accent colours) are in
[`skills/walkthrough-video/.env`](skills/walkthrough-video/.env).

## Development

All executable code and dependencies live under the skill's `resources/`.
Run offline tests without credentials or paid API calls:

```sh
skills/gpt-imagegen/resources/.venv/bin/python -m unittest discover -s skills/gpt-imagegen/resources -p 'test_*.py'
npm test --prefix skills/foundry-tts/resources
npm test --prefix skills/walkthrough-video/resources   # also records a short local MP4 with Playwright + ffmpeg
```

API implementation follows the [OpenAI image-generation guide](https://developers.openai.com/api/docs/guides/image-generation?generate-images-api=image&streaming-api=image&reference-images-api=image)
and [Azure v1 endpoint guidance](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/switching-endpoints).
Speech follows the [MAI voices guide](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-voices).
