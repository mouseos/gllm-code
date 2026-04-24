# MCP Host

Expose this GLLM Code instance as a local MCP server so other tools
(Claude Code, Claude Desktop, custom scripts) can connect and drive
tasks — effectively making GLLM a sub-agent in someone else's conversation.

## Enabling

Set `gllm.mcpServer.enabled` to `true` in settings (default: off) and
reload the window. On startup the extension:

1. Binds an HTTP server to `127.0.0.1:<random>` with a fresh Bearer token
2. Writes `~/.gllm-code/mcp/registry.json` with `{ port, token, workspaceRoot, pid, windowId }`
3. Cleans stale entries whose `pid` is no longer alive

Each VS Code window you have open gets its own port — clients can pick by
`workspaceRoot`.

## Approval model

The **first** time a given MCP client name connects, a modal asks the user:

> `"Claude Code" wants to connect to GLLM Code via MCP and may start, modify,
> or read your tasks. Allow?` — [Allow] [Deny]

- Allow → recorded in global state, no more modals for that client.
- Deny → also recorded permanently (per user request). To re-enable, either
  edit `mcpHostApprovedClients` in the extension's global state or
  uninstall/reinstall.

The readonly probes (`gllm_ping`, `gllm_get_status`, `gllm_wait_for_completion`)
bypass approval so clients can diagnose connectivity.

Set `gllm.mcpServer.requireApproval=false` to skip approval (development only).

## Tools

| Tool | Purpose |
|---|---|
| `gllm_ping` | Smoke-test / capability probe |
| `gllm_host_info` | Like ping but returns controller availability |
| `gllm_start_task` | New task with a prompt (stamps `origin="mcp"` on the HistoryItem) |
| `gllm_send_message` | Follow-up / reply to an `ask` / continue after `attempt_completion` |
| `gllm_get_status` | Snapshot of the active task |
| `gllm_wait_for_completion` | Blocks until the task stops streaming (or timeout) |
| `gllm_list_tasks` | Full task history (all origins). Requires approval. |
| `gllm_cancel_task` | Cancels the active task |

## Connecting from Claude Code

```bash
# Look up the port and token:
cat ~/.gllm-code/mcp/registry.json | jq '.[0]'

# Then, from Claude Code:
claude mcp add gllm-code \
  --transport http \
  --url "http://127.0.0.1:<PORT>/mcp" \
  --header "Authorization: Bearer <TOKEN>"
```

## Manual testing

```bash
python scripts/experiments/mcp_host_probe.py list-tools
python scripts/experiments/mcp_host_probe.py ping
python scripts/experiments/mcp_host_probe.py start_task --prompt "say hi"
python scripts/experiments/mcp_host_probe.py status
python scripts/experiments/mcp_host_probe.py wait --timeout-ms 120000
python scripts/experiments/mcp_host_probe.py list_tasks --limit 5
```

## Architecture notes

- Transport: Streamable HTTP (MCP SDK's modern transport). SSE multiplexed on
  `/mcp`.
- Origin propagation: `tools.ts` writes to `pendingOriginForNextInitTask`
  before calling `controller.initTask()`; `Controller.updateTaskHistory()`
  consumes it on the first save and stamps the HistoryItem. Subsequent saves
  preserve the prior origin.
- UI: HistoryViewItem and TaskHeader show an `MCP · <clientName>` pill when
  `item.origin === "mcp"`.

## Files

- `McpHostServer.ts` — HTTP + transport + client identification
- `tools.ts` — tool implementations + approval gate
- `ApprovalStore.ts` — global-state-backed `{client → allow/deny}` map
- `originHook.ts` — one-shot slot the Controller reads from
- `currentController.ts` — `WebviewProvider.getInstance()` helpers, auto-opens
  the sidebar if no controller is mounted
- `registry.ts` — atomic registry JSON with stale-pid cleanup
