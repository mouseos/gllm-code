#!/usr/bin/env python3
"""Minimal MCP client for testing the gllm-code MCP host server.

Reads `~/.gllm-code/mcp/registry.json`, picks the first live entry (or a
specific workspace via --workspace), negotiates an MCP initialize handshake
over Streamable HTTP, and calls tools interactively.

Usage:
    python mcp_host_probe.py ping
    python mcp_host_probe.py start_task --prompt "hello"
    python mcp_host_probe.py status
    python mcp_host_probe.py list_tasks --limit 5
    python mcp_host_probe.py send_message --text "continue"
    python mcp_host_probe.py cancel

No third-party deps.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import urllib.request
import urllib.error


REGISTRY = Path.home() / ".gllm-code" / "mcp" / "registry.json"


def load_registry(workspace: str | None) -> dict[str, Any]:
    if not REGISTRY.exists():
        print(f"ERROR: {REGISTRY} does not exist — is gllm-code with mcpHost.enabled running?", file=sys.stderr)
        sys.exit(2)
    entries = json.loads(REGISTRY.read_text())
    if not entries:
        print("ERROR: registry is empty.", file=sys.stderr)
        sys.exit(2)
    if workspace:
        entries = [e for e in entries if e["workspaceRoot"] == workspace]
        if not entries:
            print(f"ERROR: no entry with workspaceRoot={workspace}", file=sys.stderr)
            sys.exit(2)
    # default: newest startedAt
    entries.sort(key=lambda e: e.get("startedAt", ""), reverse=True)
    return entries[0]


class StreamableClient:
    def __init__(self, host: str, port: int, token: str):
        self.url = f"http://{host}:{port}/mcp"
        self.token = token
        self.session_id: str | None = None
        self._msg_id = 0

    def _next_id(self) -> int:
        self._msg_id += 1
        return self._msg_id

    def _request(self, method: str, params: dict[str, Any] | None = None, notification: bool = False) -> Any:
        body = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {},
        }
        if not notification:
            body["id"] = self._next_id()
        data = json.dumps(body).encode()
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {self.token}",
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        req = urllib.request.Request(self.url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                ct = resp.headers.get("content-type", "")
                sid = resp.headers.get("Mcp-Session-Id")
                if sid and not self.session_id:
                    self.session_id = sid
                raw = resp.read().decode()
        except urllib.error.HTTPError as e:
            raw = e.read().decode() if e.fp else ""
            print(f"HTTP {e.code}: {raw[:500]}", file=sys.stderr)
            sys.exit(1)
        if notification:
            return None
        if ct.startswith("text/event-stream"):
            # pull the last "data:" JSON out of the SSE stream
            last = None
            for line in raw.splitlines():
                line = line.strip()
                if line.startswith("data: "):
                    last = json.loads(line[6:])
            if last is None:
                return None
            return last
        # application/json
        return json.loads(raw)

    def initialize(self, client_name: str, client_version: str) -> dict[str, Any]:
        result = self._request(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": client_name, "version": client_version},
            },
        )
        # Complete the handshake (required by the spec).
        self._request("notifications/initialized", notification=True)
        return result

    def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        return self._request("tools/call", {"name": name, "arguments": arguments})

    def list_tools(self) -> Any:
        return self._request("tools/list")


def pretty(obj: Any) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", help="Pick registry entry whose workspaceRoot equals this.")
    ap.add_argument("--client-name", default="gllm-mcp-probe")
    ap.add_argument("--client-version", default="0.0.1")
    sub = ap.add_subparsers(dest="command", required=True)

    sub.add_parser("list-tools")
    sub.add_parser("ping")
    p_start = sub.add_parser("start_task")
    p_start.add_argument("--prompt", required=True)
    sub.add_parser("status")
    p_wait = sub.add_parser("wait")
    p_wait.add_argument("--timeout-ms", type=int, default=60_000)
    p_send = sub.add_parser("send_message")
    p_send.add_argument("--text", required=True)
    p_list = sub.add_parser("list_tasks")
    p_list.add_argument("--limit", type=int, default=10)
    p_list.add_argument("--favorites-only", action="store_true")
    sub.add_parser("cancel")

    args = ap.parse_args()

    entry = load_registry(args.workspace)
    print(
        f"→ connecting to {entry['workspaceRoot']}  port={entry['port']}  windowId={entry['windowId']}",
        file=sys.stderr,
    )
    client = StreamableClient("127.0.0.1", entry["port"], entry["token"])
    info = client.initialize(args.client_name, args.client_version)
    print(f"initialized: {pretty(info)}", file=sys.stderr)

    if args.command == "list-tools":
        print(pretty(client.list_tools()))
    elif args.command == "ping":
        print(pretty(client.call_tool("gllm_ping", {"message": "hi"})))
    elif args.command == "start_task":
        print(pretty(client.call_tool("gllm_start_task", {"prompt": args.prompt})))
    elif args.command == "status":
        print(pretty(client.call_tool("gllm_get_status", {})))
    elif args.command == "wait":
        print(pretty(client.call_tool("gllm_wait_for_completion", {"timeoutMs": args.timeout_ms})))
    elif args.command == "send_message":
        print(pretty(client.call_tool("gllm_send_message", {"text": args.text})))
    elif args.command == "list_tasks":
        print(
            pretty(
                client.call_tool(
                    "gllm_list_tasks",
                    {"limit": args.limit, "favoritesOnly": args.favorites_only},
                )
            )
        )
    elif args.command == "cancel":
        print(pretty(client.call_tool("gllm_cancel_task", {})))
    return 0


if __name__ == "__main__":
    sys.exit(main())
