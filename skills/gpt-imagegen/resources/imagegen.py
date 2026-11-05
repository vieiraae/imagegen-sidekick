"""Generate and edit images using the OpenAI Images API on Azure's v1 endpoint."""

import argparse
import base64
import binascii
import io
import os
import sys
from contextlib import ExitStack
from pathlib import Path
from urllib.parse import urlparse

from azure.core.exceptions import ClientAuthenticationError
from azure.identity import AzureCliCredential, get_bearer_token_provider
from dotenv import dotenv_values
from openai import APIError, APIStatusError, OpenAI
from PIL import Image

SKILL_DIR = Path(__file__).resolve().parent.parent
OPTIONS = {
    "size": ("1024x1024", "1536x1024", "1024x1536"),
    "quality": ("auto", "low", "medium", "high", "xhigh", "max"),
    "background": ("transparent", "opaque", "auto"),
    "format": ("png", "jpeg", "webp"),
    "moderation": ("low", "auto"),
}
EXTENSIONS = {"png": {".png"}, "jpeg": {".jpg", ".jpeg"}, "webp": {".webp"}}


def load_settings():
    if not (SKILL_DIR / ".env").is_file():
        raise ValueError(f"Missing defaults: {SKILL_DIR / '.env'}")
    return {
        **dotenv_values(SKILL_DIR / ".env"),
        **dotenv_values(SKILL_DIR / ".env.local"),
        **os.environ,
    }


def inspect_input(path, *, mask=False):
    limit = 4 if mask else 50
    if path.stat().st_size >= limit * 1024 * 1024:
        raise ValueError(f"{path}: must be smaller than {limit} MB")
    with Image.open(path) as image:
        if image.format not in ("PNG", "JPEG", "WEBP"):
            raise ValueError(f"{path}: expected PNG, JPEG or WebP")
        if mask and (image.format != "PNG" or "A" not in image.getbands()):
            raise ValueError("Mask must be a PNG with an alpha channel")
        details = image.size, image.format
        image.verify()
    return details


def run(argv=None):
    settings = load_settings()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("generate", "edit"))
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--image", action="append", type=Path)
    parser.add_argument("--mask", type=Path)
    for name, choices in OPTIONS.items():
        parser.add_argument(
            f"--{name}", choices=choices, default=settings.get(f"IMAGE_{name.upper()}")
        )
    args = parser.parse_args(argv)
    for name, choices in OPTIONS.items():
        if getattr(args, name) not in choices:
            parser.error(f"IMAGE_{name.upper()} must be one of {', '.join(choices)}")
    if not args.prompt.strip():
        parser.error("--prompt must not be empty")
    if args.action == "generate" and (args.image or args.mask):
        parser.error("--image and --mask require edit")
    if args.action == "edit" and not (args.image and 1 <= len(args.image) <= 16):
        parser.error("edit requires 1-16 --image arguments")
    if args.format == "jpeg" and args.background != "opaque":
        parser.error("JPEG requires --background opaque; use PNG/WebP for transparency")
    if args.output.suffix.lower() not in EXTENSIONS[args.format]:
        parser.error("--output extension must match --format")
    if args.output.exists():
        raise FileExistsError(f"Refusing to overwrite {args.output}")
    inputs = [inspect_input(path) for path in args.image or []]
    if args.mask:
        mask_size, _ = inspect_input(args.mask, mask=True)
        if inputs[0] != (mask_size, "PNG"):
            raise ValueError("Mask and first input must be PNGs with identical dimensions")
    endpoint = settings.get("AZURE_OPENAI_ENDPOINT", "")
    url = urlparse(endpoint)
    if url.scheme != "https" or not url.netloc or url.username or url.password:
        raise ValueError("AZURE_OPENAI_ENDPOINT must be an HTTPS URL without credentials")
    model = settings.get("IMAGE_MODEL")
    if not model:
        raise ValueError("IMAGE_MODEL must name your Azure deployment")
    scope = settings.get("AZURE_OPENAI_SCOPE")
    if not scope:
        raise ValueError("AZURE_OPENAI_SCOPE must specify the Azure token scope")
    timeout = float(settings["IMAGE_TIMEOUT"])
    retries = int(settings["IMAGE_MAX_RETRIES"])
    if not 0 < timeout < float("inf") or retries < 0:
        raise ValueError("IMAGE_TIMEOUT must be positive/finite; IMAGE_MAX_RETRIES >= 0")
    params = {
        "model": model,
        "prompt": args.prompt,
        "size": args.size,
        "quality": args.quality,
        "background": args.background,
        "output_format": args.format,
        # The SDK's edit signature does not expose moderation as a keyword.
        "extra_body": {"moderation": args.moderation},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with AzureCliCredential() as credential, OpenAI(
        api_key=get_bearer_token_provider(credential, scope),
        base_url=endpoint, timeout=timeout, max_retries=retries,
    ) as client, ExitStack() as stack:
        if args.action == "edit":
            params["image"] = [stack.enter_context(path.open("rb")) for path in args.image]
            if args.mask:
                params["mask"] = stack.enter_context(args.mask.open("rb"))
            result = client.images.edit(**params)
        else:
            result = client.images.generate(**params)
    if not result.data or len(result.data) != 1 or not result.data[0].b64_json:
        raise ValueError("API did not return exactly one base64-encoded image")
    data = base64.b64decode(result.data[0].b64_json, validate=True)
    with Image.open(io.BytesIO(data)) as image:
        expected_size = tuple(map(int, args.size.split("x")))
        if image.format.lower() != args.format or image.size != expected_size:
            raise ValueError("API image format or dimensions do not match the request")
        image.verify()
    with args.output.open("xb") as output:
        output.write(data)
    print(args.output.resolve())
    return args.output


def main():
    try:
        run()
    except ClientAuthenticationError:
        print(
            "Azure CLI authentication failed. Install Azure CLI and run 'az login' "
            "in the resource's tenant; select the correct subscription with "
            "'az account set --subscription <subscription>'.",
            file=sys.stderr,
        )
        return 1
    except APIStatusError as error:
        print(
            f"Image API error: HTTP {error.status_code}; code={error.code}; "
            f"request_id={error.request_id}. Check Azure CLI identity, Azure OpenAI "
            "data-plane permissions (Cognitive Services OpenAI User), deployment, quota "
            "and requested parameters; content filtering still applies.",
            file=sys.stderr,
        )
        return 1
    except (APIError, OSError, ValueError, KeyError, binascii.Error) as error:
        print(f"Image generation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
