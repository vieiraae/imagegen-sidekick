---
name: gpt-imagegen
description: Generate or edit images with GPT Image on Azure OpenAI. Use for requested illustrations, photos, icons, transparent cutouts, reference-image compositions, masked edits, and Blender textures, decals, billboards or modeling references. Not for creating 3D meshes or merely discussing image APIs.
compatibility: Python 3.10+, pip, network access, and Azure CLI signed in with Azure OpenAI access.
---

# GPT Image

Use `resources/imagegen.py`; do not rewrite the API client. Resolve paths relative
to this skill's directory, not the user's working directory. All defaults live
in `.env`; `.env.local`, then process environment, then CLI flags override them.

## Workflow

1. Identify generate versus edit, intended use, subject, composition, and what
   must remain unchanged. Inspect provided images before editing. Ask only when
   essential intent is unclear. Send only images the user authorizes uploading.
2. Use the skill's `resources/.venv/bin/python`. If missing, create the venv with
   `python3 -m venv <skill>/resources/.venv`, then install
   `resources/requirements.txt` using that venv's `python -m pip install -r`.
   Authenticate only with `AzureCliCredential` using the user's `az login`
   session. The identity needs Azure OpenAI data-plane access (for example,
   Cognitive Services OpenAI User on the resource). On auth failure, ask the
   user to sign in to the correct tenant/subscription; never request API keys,
   print tokens, or silently switch identities.
3. Write a specific prompt and select flags using the guidance below. Save to a
   new path in the user's project, not the installed plugin directory.
4. Run the command, inspect the saved image, and report its path and settings.
   Do not claim success on an API error or promise pixel-exact edits. Report
   deployment/parameter errors rather than silently switching models or settings.

## Choose settings from intent

- **Size:** default `1024x1024`; use `1536x1024` for landscape compositions and
  `1024x1536` for portraits.
- **Quality:** default `auto`; `low` for drafts, `medium` for balanced iterations,
  `high` for final detail. Reserve `xhigh` or `max` for explicitly demanding
  fidelity, explaining the additional latency/cost.
- **Background:** default `transparent` when no background is needed (icons,
  isolated objects, decals). Use `opaque` for scenes, backgrounds and full
  surface textures; describe the background in the prompt. For edits preserve
  the existing background unless asked to remove/change it; `auto` is available
  when model selection is appropriate.
- **Format:** default `png` for lossless assets and alpha. Use `jpeg` for opaque
  photos when size/latency matters, or `webp` for compact web assets with optional
  alpha. JPEG requires `--background opaque`. Match the output extension.
- Keep moderation `low`; it does not disable provider safety filtering.

## Commands

Replace `<skill>` with the resolved skill directory; quote paths and prompts.

```sh
<skill>/resources/.venv/bin/python <skill>/resources/imagegen.py generate --prompt "An isolated oak leaf, clean silhouette, no ground shadow" --output outputs/leaf.png
<skill>/resources/.venv/bin/python <skill>/resources/imagegen.py edit --image input.png --mask mask.png --prompt "Make the masked fabric blue; preserve everything else" --background opaque --output outputs/edited.png
```

Repeat `--image` for multiple references (up to 16); the mask applies to the
first. Inputs: PNG/JPEG/WebP under 50 MB each. For masked edits use a PNG first
image and same-dimension PNG mask under 4 MB with alpha: transparent pixels mark
the edit region, opaque pixels mark areas to preserve. Masks guide, not guarantee,
the result. For follow-up edits pass the previous output as `--image`.

## Blender assets

- **Base color:** request an opaque, seamless/tileable, edge-to-edge surface,
  orthographic view, even neutral lighting, no baked shadows/highlights or
  perspective. Prefer square PNG; inspect repeated tiles for visible seams.
- **Decals/billboards:** transparent PNG, clean alpha edges, no ground plane or
  baked shadow, centered subject with padding. Connect Color to Principled Base
  Color and Alpha to Alpha; enable the Blender version's alpha render method.
- **Modeling references:** request aligned front/side/back orthographic views
  with consistent proportions; these are images, not meshes or `.blend` files.
- Use sRGB for base color; Non-Color for roughness/metallic/height/normal data.
  Generated PBR maps are approximations, not calibrated material data. Derive or
  bake aligned maps from a common source; validate tiling and normals in Blender.
  Do not describe an ordinary PNG/JPEG/WebP as an HDR environment map.
