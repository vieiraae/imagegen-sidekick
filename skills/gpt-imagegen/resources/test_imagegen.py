"""Offline tests exercise the real SDK with a mocked HTTP transport."""

import base64
import io
import json
import os
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from email import policy
from email.parser import BytesParser
from pathlib import Path
from unittest.mock import patch

import httpx
from azure.core.credentials import AccessToken
from azure.core.exceptions import ClientAuthenticationError
from azure.identity import CredentialUnavailableError
from dotenv import dotenv_values
from openai import OpenAI
from PIL import Image

import imagegen


def image_bytes(fmt="PNG", size=(1024, 1024), mode="RGBA"):
    buffer = io.BytesIO()
    Image.new(mode, size).save(buffer, format=fmt)
    return buffer.getvalue()


class ImagegenTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.settings = dict(dotenv_values(imagegen.SKILL_DIR / ".env"))
        credential_patch = patch.object(imagegen, "AzureCliCredential", autospec=True)
        self.credential_factory = credential_patch.start()
        self.addCleanup(credential_patch.stop)
        self.credential = self.credential_factory.return_value
        self.credential.__enter__.return_value = self.credential
        self.get_token = getattr(self.credential, "get_token_info", self.credential.get_token)
        self.get_token.return_value = AccessToken(
            "test-cli-token", int(time.time()) + 3600
        )
        self.requests = []
        self.status = 200
        self.response = {
            "created": 0,
            "data": [{"b64_json": base64.b64encode(image_bytes()).decode()}],
        }
        settings_patch = patch.object(imagegen, "load_settings", return_value=self.settings)
        self.original_load = imagegen.load_settings
        settings_patch.start()
        self.addCleanup(settings_patch.stop)
        client_patch = patch.object(
            imagegen,
            "OpenAI",
            side_effect=lambda **kwargs: OpenAI(
                **kwargs, http_client=httpx.Client(transport=httpx.MockTransport(self.handle))
            ),
        )
        client_patch.start()
        self.addCleanup(client_patch.stop)

    def handle(self, request):
        request.read()
        self.requests.append(request)
        return httpx.Response(
            self.status, json=self.response, headers={"x-request-id": "test-request"}
        )

    def invoke(self, *flags, action="generate", suffix=".png"):
        path = self.root / f"output{suffix}"
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            return imagegen.run(
                [action, "--prompt", "A leaf", "--output", str(path), *flags]
            )

    def input(self, name, **kwargs):
        path = self.root / name
        path.write_bytes(image_bytes(**kwargs))
        return str(path)

    def test_generation_defaults_and_azure_route(self):
        path = self.invoke()
        self.assertTrue(path.is_file())
        request = self.requests[0]
        self.assertEqual(request.method, "POST")
        self.assertEqual(
            str(request.url),
            "https://foundry-imagegen.openai.azure.com/openai/v1/images/generations",
        )
        self.assertEqual(request.headers["authorization"], "Bearer test-cli-token")
        self.credential_factory.assert_called_once_with()
        self.assertEqual(
            self.get_token.call_args.args, ("https://ai.azure.com/.default",)
        )
        self.assertNotIn("api-key", request.headers)
        self.assertEqual(
            json.loads(request.content),
            {
                "model": "gpt-image-2.5-sunburst",
                "prompt": "A leaf",
                "size": "1024x1024",
                "quality": "auto",
                "background": "transparent",
                "output_format": "png",
                "moderation": "low",
            },
        )
        with Image.open(path) as image:
            self.assertEqual(image.size, (1024, 1024))
            self.assertEqual(image.mode, "RGBA")

    def test_override_sizes_formats_and_qualities(self):
        for size, fmt, quality in (
            ("1536x1024", "jpeg", "low"),
            ("1024x1536", "webp", "medium"),
            ("1024x1024", "png", "high"),
            ("1024x1024", "png", "xhigh"),
            ("1024x1024", "png", "max"),
        ):
            with self.subTest(size=size, fmt=fmt, quality=quality):
                data = image_bytes(fmt.upper(), tuple(map(int, size.split("x"))), "RGB")
                self.response["data"][0]["b64_json"] = base64.b64encode(data).decode()
                output = self.invoke(
                    "--size", size, "--format", fmt, "--quality", quality,
                    "--background", "opaque", suffix=f".{fmt}",
                )
                body = json.loads(self.requests[-1].content)
                self.assertEqual(
                    (body["size"], body["output_format"], body["quality"]),
                    (size, fmt, quality),
                )
                self.assertEqual(output.read_bytes(), data)
                output.unlink()

    def test_edit_multiple_references_and_mask_multipart(self):
        first = self.input("first.png")
        second = self.input("second.webp", fmt="WEBP")
        mask = self.input("mask.png")
        self.invoke(
            "--image", first, "--image", second, "--mask", mask, action="edit"
        )
        request = self.requests[0]
        self.assertEqual(request.url.path, "/openai/v1/images/edits")
        self.assertEqual(request.headers["authorization"], "Bearer test-cli-token")
        message = BytesParser(policy=policy.default).parsebytes(
            f"Content-Type: {request.headers['content-type']}\r\n\r\n".encode()
            + request.content
        )
        parts = list(message.iter_parts())
        fields = {
            part.get_param("name", header="content-disposition"): part.get_payload(decode=True)
            for part in parts
        }
        self.assertEqual(fields["moderation"], b"low")
        self.assertEqual(fields["quality"], b"auto")
        self.assertEqual(fields["mask"], Path(mask).read_bytes())
        uploads = [
            part for part in parts
            if part.get_param("name", header="content-disposition") == "image[]"
        ]
        self.assertEqual(len(uploads), 2)
        self.assertEqual(uploads[0].get_payload(decode=True), Path(first).read_bytes())

    def test_edit_without_mask(self):
        self.invoke("--image", self.input("source.jpg", fmt="JPEG", mode="RGB"), action="edit")
        self.assertEqual(self.requests[0].url.path, "/openai/v1/images/edits")
        self.assertNotIn(b'name="mask"', self.requests[0].content)

    def test_invalid_arguments_do_not_call_api(self):
        cases = (
            (["--format", "jpeg"], "generate", ".jpeg"),
            (["--size", "512x512"], "generate", ".png"),
            (["--quality", "ultra"], "generate", ".png"),
            (["--image", "missing.png"], "generate", ".png"),
            (["--mask", "missing.png"], "generate", ".png"),
            ([], "edit", ".png"),
            (["--prompt", "  "], "generate", ".png"),
            ([], "generate", ".jpg"),
            (["--image", "x.png"] * 17, "edit", ".png"),
        )
        for flags, action, suffix in cases:
            with self.subTest(flags=flags, action=action, suffix=suffix):
                with self.assertRaises(SystemExit):
                    self.invoke(*flags, action=action, suffix=suffix)
        self.assertEqual(self.requests, [])

    def test_invalid_configuration(self):
        for key, value in (
            ("IMAGE_QUALITY", "invalid"),
            ("AZURE_OPENAI_ENDPOINT", "http://example.com"),
            ("IMAGE_MODEL", ""),
            ("AZURE_OPENAI_SCOPE", ""),
            ("IMAGE_TIMEOUT", "nan"),
            ("IMAGE_MAX_RETRIES", "-1"),
        ):
            with self.subTest(key=key), patch.dict(self.settings, {key: value}):
                with self.assertRaises((ValueError, SystemExit)):
                    self.invoke()
        self.assertEqual(self.requests, [])

    def test_invalid_masks_and_inputs(self):
        first = self.input("first.png")
        masks = [
            self.input("no-alpha.png", mode="RGB"),
            self.input("wrong-size.png", size=(32, 32)),
        ]
        for mask in masks:
            with self.subTest(mask=mask), self.assertRaises(ValueError):
                self.invoke("--image", first, "--mask", mask, action="edit")
        corrupt = self.root / "corrupt.png"
        corrupt.write_bytes(b"not an image")
        with self.assertRaises(OSError):
            self.invoke("--image", str(corrupt), action="edit")
        self.assertEqual(self.requests, [])

    def test_existing_output_is_preserved_without_request(self):
        output = self.root / "output.png"
        output.write_bytes(b"keep")
        with self.assertRaises(FileExistsError):
            self.invoke()
        self.assertEqual(output.read_bytes(), b"keep")
        self.assertEqual(self.requests, [])

    def test_invalid_api_results_do_not_write_output(self):
        for data in (
            [], [{"b64_json": None}], [{"b64_json": "invalid!"}],
            [{"b64_json": base64.b64encode(b"not an image").decode()}],
            [{"b64_json": base64.b64encode(image_bytes(size=(32, 32))).decode()}],
        ):
            with self.subTest(data=data):
                self.response["data"] = data
                with self.assertRaises((ValueError, OSError)):
                    self.invoke()
                self.assertFalse((self.root / "output.png").exists())

    def test_http_error_reports_request_id_without_retry(self):
        self.status = 429
        self.response = {"error": {"message": "No quota", "code": "insufficient_quota"}}
        output = self.root / "output.png"
        stderr = io.StringIO()
        with patch("sys.argv", ["imagegen", "generate", "--prompt", "A leaf",
                                "--output", str(output)]), redirect_stderr(stderr):
            self.assertEqual(imagegen.main(), 1)
        self.assertIn("HTTP 429", stderr.getvalue())
        self.assertIn("test-request", stderr.getvalue())
        self.assertIn("insufficient_quota", stderr.getvalue())
        self.assertNotIn("test-cli-token", stderr.getvalue())
        self.assertEqual(len(self.requests), 1)
        self.assertFalse(output.exists())

    def test_api_keys_are_ignored(self):
        with patch.dict(self.settings, {"AZURE_OPENAI_API_KEY": "unused-key"}), patch.dict(
            os.environ, {"OPENAI_API_KEY": "unused-key"}
        ):
            self.invoke()
        self.assertEqual(self.requests[0].headers["authorization"], "Bearer test-cli-token")
        self.assertNotIn("api-key", self.requests[0].headers)

    def test_cli_authentication_failures_are_actionable_and_do_not_call_api(self):
        output = self.root / "output.png"
        for error in (
            CredentialUnavailableError("Azure CLI not found"),
            ClientAuthenticationError("Expired login"),
        ):
            with self.subTest(error=type(error).__name__):
                self.get_token.side_effect = error
                stderr = io.StringIO()
                with patch("sys.argv", ["imagegen", "generate", "--prompt", "A leaf",
                                        "--output", str(output)]), redirect_stderr(stderr):
                    self.assertEqual(imagegen.main(), 1)
                self.assertIn("az login", stderr.getvalue())
                self.assertIn("tenant", stderr.getvalue())
                self.assertNotIn("test-cli-token", stderr.getvalue())
        self.assertEqual(self.requests, [])
        self.assertFalse(output.exists())

    def test_settings_precedence_independent_of_working_directory(self):
        (self.root / ".env").write_text("IMAGE_QUALITY=auto\nIMAGE_SIZE=1024x1024\n")
        (self.root / ".env.local").write_text("IMAGE_QUALITY=high\n")
        with patch.object(imagegen, "SKILL_DIR", self.root), patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.original_load()["IMAGE_QUALITY"], "high")
            with patch.dict(os.environ, {"IMAGE_QUALITY": "max"}):
                settings = self.original_load()
                self.assertEqual(settings["IMAGE_QUALITY"], "max")
                self.assertEqual(settings["IMAGE_SIZE"], "1024x1024")


if __name__ == "__main__":
    unittest.main()
