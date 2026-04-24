#!/usr/bin/env python3
"""Antigravity / Gemini CLI probe — send hand-crafted requests and classify errors.

Usage:
    python antigravity_probe.py --token "$ACCESS_TOKEN" --project "$PROJECT_ID" \
        [--provider antigravity|gemini-cli] [--ua "antigravity/1.20.0 linux/x64"] \
        [--model gemini-3.1-pro-high] [--with-tools]

The script mirrors gllm-code's streamGenerateContent call but lets you toggle
each dimension (endpoint host, user-agent, model id, with/without tools) so
we can see the real server responses and decide what to change.

Environment variables override flags: GLLM_TOKEN, GLLM_PROJECT, GLLM_UA.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from typing import Any

import urllib.request
import urllib.error


ANTIGRAVITY_HOSTS = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
]
GEMINI_CLI_HOST = "https://cloudcode-pa.googleapis.com"
STREAM_ENDPOINT = "/v1internal:streamGenerateContent?alt=sse"


@dataclass
class ProbeResult:
    host: str
    model: str
    status: int
    elapsed_ms: int
    headers: dict[str, str]
    body: str
    classification: str
    note: str


def classify(status: int, body: str) -> tuple[str, str]:
    """Return (classification, note)."""
    low = body.lower() if body else ""
    if status == 200:
        if not body.strip():
            return ("empty-ok", "200 but body empty")
        # Check for empty candidates stream
        if "\"candidates\"" not in body and "\"response\"" not in body:
            return ("empty-stream", "200 but no candidates/response in stream")
        return ("ok", "")
    if status == 429:
        if "quota" in low or "exceeded" in low:
            return ("quota-exceeded", "daily/project quota hit — switch account")
        if "rate" in low:
            return ("rate-limited", "rate limit — wait or rotate")
        return ("429-other", "429 without quota/rate hint")
    if status == 400:
        if "no longer available" in low or "please switch to" in low or "deprecated" in low:
            return ("model-retired", "server says the requested model is gone")
        if "not available on this version" in low or "upgrade to the latest" in low:
            return ("ua-too-old", "server requires newer client User-Agent")
        if "unknown name" in low or "cannot find field" in low:
            return ("bad-payload", "request body shape doesn't match server schema")
        if "function_declarations" in low:
            return ("tools-shape", "tools payload shape mismatch")
        return ("bad-request", "400 with an unknown message")
    if status == 401 or status == 403:
        return ("auth-error", "token invalid / lacks permission")
    if status == 404:
        if "model" in low or "gemini" in low:
            return ("model-not-found", "server does not recognize that model id")
        if "project" in low:
            return ("project-not-found", "projectId missing or wrong")
        return ("404-other", "404 without hint")
    if 500 <= status < 600:
        return ("server-error", f"upstream {status}")
    return ("unknown", f"status {status}")


def build_body(provider: str, model: str, project_id: str, with_tools: bool, system: str, user: str) -> dict[str, Any]:
    inner: dict[str, Any] = {
        "contents": [
            {"role": "user", "parts": [{"text": user}]},
        ],
        "systemInstruction": {"parts": [{"text": system}]},
        "generationConfig": {
            "maxOutputTokens": 4096,
        },
    }
    if provider == "antigravity":
        inner["sessionId"] = "probe-session"
        inner["systemInstruction"] = {"role": "user", "parts": [{"text": system}]}
        inner["generationConfig"]["stopSequences"] = ["\n\nHuman:", "[DONE]"]
    if with_tools:
        # Single trivial tool — enough to reproduce the "tools leak" case.
        inner["tools"] = [
            {
                "functionDeclarations": [
                    {
                        "name": "ping",
                        "description": "No-op tool used to verify native tool calling.",
                        "parameters": {
                            "type": "OBJECT",
                            "properties": {
                                "message": {"type": "STRING", "description": "anything"},
                            },
                        },
                    }
                ]
            }
        ]
        inner["toolConfig"] = {"functionCallingConfig": {"mode": "ANY"}}
    if provider == "antigravity":
        return {
            "model": model,
            "userAgent": os.environ.get("GLLM_UA", "antigravity/1.20.0 linux/x64"),
            "requestType": "agent",
            "project": project_id,
            "requestId": f"probe-{int(time.time() * 1000)}",
            "request": inner,
        }
    # gemini-cli shape: no userAgent/requestType/requestId/sessionId fields
    return {"model": model, "project": project_id, "request": inner}


def post(url: str, token: str, ua: str, body: dict[str, Any], timeout: int = 60) -> ProbeResult:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": ua,
            "Accept": "text/event-stream",
        },
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            status = resp.getcode()
            headers = dict(resp.headers.items())
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
        status = e.code
        headers = dict(e.headers.items()) if e.headers else {}
    except urllib.error.URLError as e:
        raw = f"URLError: {e}"
        status = 0
        headers = {}
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    classification, note = classify(status, raw)
    return ProbeResult(
        host=url.split("/v1internal")[0],
        model=body["model"],
        status=status,
        elapsed_ms=elapsed_ms,
        headers=headers,
        body=raw,
        classification=classification,
        note=note,
    )


def print_result(r: ProbeResult, verbose: bool) -> None:
    bar = "=" * 70
    print(bar)
    print(f"host      : {r.host}")
    print(f"model     : {r.model}")
    print(f"status    : {r.status}  ({r.elapsed_ms} ms)")
    print(f"class     : {r.classification}  — {r.note}")
    if verbose or r.classification not in ("ok",):
        snippet = r.body[:800]
        if len(r.body) > 800:
            snippet += f"\n... (+{len(r.body) - 800} more chars)"
        print("body      :", snippet.replace("\n", "\n            "))
    print(bar)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", default=os.environ.get("GLLM_TOKEN"), help="Bearer access token")
    ap.add_argument("--project", default=os.environ.get("GLLM_PROJECT"), help="Google Cloud project id")
    ap.add_argument("--ua", default=os.environ.get("GLLM_UA", "antigravity/1.20.0 linux/x64"))
    ap.add_argument(
        "--provider",
        default="antigravity",
        choices=["antigravity", "gemini-cli"],
        help="Which endpoint set to probe.",
    )
    ap.add_argument(
        "--models",
        nargs="+",
        default=None,
        help="Override model list. Default: a curated probe set for the chosen provider.",
    )
    ap.add_argument(
        "--with-tools",
        action="store_true",
        help="Include a sample native-tool declaration to isolate tool-related failures.",
    )
    ap.add_argument(
        "--no-with-tools",
        action="store_true",
        help="Force tools off (useful when the default set includes a tools sweep).",
    )
    ap.add_argument("--verbose", action="store_true", help="Print full body even on success.")
    ap.add_argument("--system", default="You are a concise helpful assistant.")
    ap.add_argument("--user", default="Say the single word PONG.")
    args = ap.parse_args()

    if not args.token:
        print("ERROR: --token / GLLM_TOKEN is required.", file=sys.stderr)
        return 2
    if not args.project:
        print("ERROR: --project / GLLM_PROJECT is required.", file=sys.stderr)
        return 2

    if args.models:
        models = args.models
    elif args.provider == "antigravity":
        models = [
            # New 3.1 family — primary target
            "gemini-3.1-pro-high",
            "gemini-3.1-pro-low",
            "gemini-3.1-flash",
            # Alternate shapes to probe what the server actually accepts
            "gemini-3.1-pro",
            "gemini-3.1-flash-lite",
            # Retired — should now fail with model-retired message
            "gemini-3-pro-high",
            "gemini-3-pro-low",
            "gemini-3-flash",
            # Known-good baseline
            "gemini-2.5-pro",
            "gemini-2.5-flash",
        ]
    else:
        models = [
            "gemini-3.1-pro-preview",
            "gemini-3-pro-preview",
            "gemini-3-flash-preview",
            "gemini-2.5-pro",
            "gemini-2.5-flash",
        ]

    hosts = ANTIGRAVITY_HOSTS if args.provider == "antigravity" else [GEMINI_CLI_HOST]
    # For first pass, try primary host only; --verbose users can loop manually.
    host = hosts[0]

    # Tool-calling sweep only when user hasn't forced it one way.
    tool_modes: list[bool]
    if args.with_tools and not args.no_with_tools:
        tool_modes = [True]
    elif args.no_with_tools:
        tool_modes = [False]
    else:
        # Sweep both so we can clearly see the tools-on-Gemini failure mode.
        tool_modes = [False, True]

    print(f"probing host = {host}")
    print(f"user-agent   = {args.ua}")
    print(f"project      = {args.project}")
    print(f"tool modes   = {tool_modes}")
    print(f"models       = {models}")
    print()

    summary: list[ProbeResult] = []
    for with_tools in tool_modes:
        print(f"\n###### tools={'on' if with_tools else 'off'} ######\n")
        for model in models:
            body = build_body(args.provider, model, args.project, with_tools, args.system, args.user)
            ua = args.ua
            if args.provider == "gemini-cli":
                # Use a GeminiCLI-style UA when probing the CLI endpoint
                ua = os.environ.get("GLLM_UA", "GeminiCLI/0.1.0/probe (linux; x64; terminal)")
            r = post(host + STREAM_ENDPOINT, args.token, ua, body)
            print_result(r, verbose=args.verbose)
            summary.append(r)

    # Summary table
    print("\n\nSUMMARY")
    print(f"{'model':<26} {'tools':<6} {'status':<7} {'class':<18} note")
    i = 0
    for with_tools in tool_modes:
        for _ in range(len(summary) // len(tool_modes)):
            r = summary[i]
            print(f"{r.model:<26} {'on' if with_tools else 'off':<6} {r.status:<7} {r.classification:<18} {r.note}")
            i += 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
