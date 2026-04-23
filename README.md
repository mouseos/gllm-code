# GLLM Code

GLLM Code is an AI coding agent for VS Code. It can inspect a codebase, edit files, run terminal commands, use browser tooling, and work through multi-step development tasks with user approval at each critical step.

This repository is a fork/customization of the Cline codebase, but the shipped extension metadata in this repo is branded as `GLLM Code` (`mouseos.gllm-code`). Some internal package names, docs, and CLI assets still use the historical `cline` name.

## What is in this repo

- `src/`: VS Code extension host code, task engine, tools, providers, storage, and platform integrations
- `webview-ui/`: React-based sidebar and settings UI
- `cli/`: standalone CLI package and build pipeline
- `docs/`: product and integration documentation
- `evals/`: smoke tests, analysis tools, and evaluation scenarios
- `proto/`: protobuf definitions shared across services and UI bridges

## Key capabilities

- Agentic coding workflow inside VS Code
- File creation and editing with diff-based review flows
- Terminal command execution with approval gates
- Browser and web tooling support for debugging and testing flows
- MCP integration for extending the agent with external tools
- Multi-provider model support across Anthropic, OpenAI-compatible APIs, Gemini, Bedrock, Ollama, LM Studio, and more
- GLLM-specific multi-account support for `gemini`, `gemini-cli`, and `antigravity`
- Automatic model fallback/routing for configured GLLM accounts via the `gllm-auto` provider

## GLLM-specific changes in this fork

Compared with upstream Cline, this repo already contains GLLM-focused customization in the extension package and UI:

- Extension identity is `gllm-code`
- Branding in the product UI is `GLLM Code`
- Settings UI includes GLLM account management
- OAuth/API-key account flows exist for Gemini API, Gemini CLI, and Antigravity
- The task/runtime layer recognizes GLLM-backed web search and account-aware routing

There are still upstream leftovers in the repo, especially under `docs/`, `cli/`, GitHub templates, and some workflow files. If you continue productizing this fork, those areas still need a broader rename pass.

## Development setup

### Requirements

- Node.js 20+
- npm
- VS Code
- `git-lfs` recommended because the repo contains binary assets

### Install

```bash
npm run install:all
npm run protos
```

### Run the extension in development

```bash
npm run dev
```

Then press `F5` in VS Code to launch an Extension Development Host.

## Common commands

```bash
npm run dev              # generate protos, then start watch mode
npm run package          # production extension build
npm run test             # unit + integration tests
npm run test:webview     # webview tests
npm run build:webview    # build sidebar UI
npm run cli:build        # build standalone CLI package
npm run docs             # run docs site locally
```

## Notes on naming

- The VS Code extension in this repo is `GLLM Code`
- The standalone CLI package under `cli/` is still named `cline`
- Parts of the documentation still describe the product as `Cline`

That mismatch is real in the current codebase, so contributors should treat this repository as a partially renamed fork rather than a fully clean rebrand.

## Contributing

Start with [CONTRIBUTING.md](./CONTRIBUTING.md), but read it with the current fork state in mind: several links and process references still point to upstream Cline infrastructure and may need adjustment for this repository.

## License

[Apache 2.0](./LICENSE)
