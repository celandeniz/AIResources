# OpenCode + oh-my-openagent (omo) — setup

Two distinct uses. Don't confuse them:

1. **Developer productivity (B):** OpenCode + omo on a developer's machine — a multi-provider,
   multi-agent coding assistant for *us* while we build this platform. Independent of the product runtime.
2. **Product integration (C):** the platform's `code_task` tool drives a headless **`opencode serve`**
   instance (approval-gated) so an AI Resource can propose code changes. See the bottom section.

---

## 1) Install OpenCode (developer machine)

```bash
# Official installer (macOS/Linux)
curl -fsSL https://opencode.ai/install | bash
# or: brew install sst/tap/opencode   |   npm i -g opencode-ai

opencode --version
```

## 2) Point OpenCode at our models

Put this at `~/.config/opencode/opencode.json` (or repo-local `opencode.json`). It exposes our
local Ollama **coding** models (same `qwen2.5-coder:14b` the platform's Technical/Functional/AL
resources now use) plus Anthropic for heavier work. See `infra/opencode.json` for a ready copy.

- Local models: Ollama on `http://localhost:11434/v1` (OpenAI-compatible endpoint).
- Anthropic: `export ANTHROPIC_API_KEY=...` then `opencode auth login` (or set in config).

Pull more coding models any time:
```bash
ollama pull qwen2.5-coder:14b      # already present
ollama pull deepseek-coder-v2:16b  # optional, stronger for some langs
```

## 3) Install oh-my-openagent (omo) — the multi-agent harness on top of OpenCode

Requires Bun.
```bash
curl -fsSL https://bun.sh/install | bash      # if Bun is missing
bunx oh-my-openagent install                  # Ultimate edition (OpenCode)
# Light edition (Codex CLI):  npx lazycodex-ai install
```
omo registers its agents (Sisyphus/Hephaestus/Prometheus), built-in MCPs (web/docs/GitHub search),
skills and hooks into your OpenCode config. Run `opencode` and the omo agents are available.

> These are external installers (`curl|bash`, `bunx`). Review them before running on your machine.

---

## 4) Product integration: run a headless server for `code_task` (C)

The platform's `code_task` executor talks to OpenCode's HTTP server. Start it **inside the repo you
want the AI to edit**, reachable from the api container:

```bash
cd /path/to/target-repo
OPENCODE_SERVER_PASSWORD=$OPENCODE_SERVER_PASSWORD opencode serve --hostname 0.0.0.0 --port 4096
# OpenAPI spec: http://localhost:4096/doc
```

Then set these in the platform `.env` (api service reads them; empty ⇒ `code_task` runs in MOCK mode):

```env
OPENCODE_SERVER_URL=http://host.docker.internal:4096
OPENCODE_SERVER_PASSWORD=<same as above>     # HTTP basic; username defaults to "opencode"
OPENCODE_MODEL=ollama/qwen2.5-coder:14b      # default model for code tasks
OPENCODE_AGENT=build                          # default agent
```

Flow: an AI Resource (e.g. AL Developer) proposes a `code_task` → Human Approval Center → on approve
the executor calls `POST /session` + `POST /session/:id/message`, then returns the summary + diff.
Nothing is committed/pushed automatically — the diff is returned for human review (draft-first).
