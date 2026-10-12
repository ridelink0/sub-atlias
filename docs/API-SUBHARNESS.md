# Your model inside the native subharness

Atlias can launch Claude Code or Codex with your API endpoint and model. The
host keeps its own conversation, tools, follow-up messages and resume commands.
Atlias's local meter forwards the complete request and response without changing
instructions, skill bodies, tools or tool results. This is optional: existing
Atlias installations and the normal standalone agent keep their current setup.

Claude Code requires an Anthropic Messages-compatible endpoint; Codex requires
a Responses-compatible endpoint, including its tool formats and compaction.
A model supporting only Chat Completions can instead use the existing standalone
`atlias exec --engine openai` loop with `agent.openaiUrl`, `agent.openaiModel` and
`ATLIAS_API_KEY`. Choosing a model does not guarantee native tool compatibility.
Qualify the endpoint against the tools and context size your tasks need.

Create a profile. `baseUrl` is the API prefix before `/messages` or `/responses`,
usually ending in `/v1`. Put the credential in an environment variable; the JSON
contains its name, never the credential itself.

```json
{
  "protocol": "responses",
  "baseUrl": "https://your-provider.example/v1",
  "model": "your-model",
  "keyEnv": "MY_MODEL_API_KEY",
  "authHeader": "bearer"
}
```

For Claude Code use `"protocol": "anthropic"` and, when your provider uses it,
`"authHeader": "x-api-key"`. Omit `keyEnv` for a local server requiring no key.
Remote endpoints require HTTPS; loopback HTTP is accepted. Check the profile
offline before launching:

```text
atlias provider check provider.json
atlias sub --host codex --profile provider.json
atlias sub --host claude --profile claude-provider.json
```

The launcher loads the Atlias plugin for Claude Code and merges Atlias's hooks,
MCP server and instruction block into the configured Codex home. It enables the
exact authority ledger for this launched session. Other existing rules remain
in the host's configuration. Installed host permission settings still apply.
Use `--executable` if the native CLI is outside PATH.

Enter follow-ups in the same native session. To resume a saved session, put the
native arguments after `--`:

```text
atlias sub --host claude --profile claude-provider.json -- --resume SESSION_ID
atlias sub --host codex --profile provider.json -- resume SESSION_ID
atlias sub --host codex --profile provider.json -- exec "Fix the failing test"
```

The exact ledger retains each original request and later amendment in order,
without character clipping. A selected `SKILL.md` read through a native Read
hook is retained with its complete contents. Compact/resume hooks reinject this
session's ledger outside the bounded evidence handoff. It does not inherit a
different session's requests. Complete authority still consumes context; a
provider must have room for it. Native hook delivery must be qualified for your
installed client version; cancelled hooks cannot establish retention.

Token prices are optional user-supplied **rates per one million tokens**, in one
currency. Add a `pricing` object with your provider's current rates:

```json
{
  "currency": "USD",
  "input": 1.0,
  "output": 3.0,
  "cacheRead": 0.1,
  "cacheWrite": 1.25,
  "source": "your provider's pricing page",
  "asOf": "2026-10-12"
}
```

Those numbers illustrate the format; they are not any model's advertised price.
Anthropic providers can specify separate `cacheWrite5m` and `cacheWrite1h` rates.
A category with tokens but no configured rate makes cost unknown. Zero rates
are accepted for local inference. Responses cache reads/writes are subtracted
from inclusive input before pricing; Anthropic cache categories are added to
its uncached input. Reasoning tokens are already part of output.

The launcher prints the receipt path and a summary at session exit. Receipts
store raw provider usage, token categories, prices and status; they do not store
API keys, prompts or response text. Retries remain separate physical calls.
Interrupted streams and missing/invalid usage remain unknown. Inspect later:

```text
atlias provider usage path/to/receipts.jsonl
```

Estimated token cost is not a provider invoice. Service tier, long-context,
tool, media, tax and other charges are outside this text-token profile. API
traffic uses the account owning the key and its API billing; native subscription
allowances do not pay these API charges. The launcher makes requests only when
you explicitly run the native session.

Protocol references: [Claude gateway compatibility](https://code.claude.com/docs/en/llm-gateway-protocol),
[Claude gateway credentials and billing](https://code.claude.com/docs/en/llm-gateway),
[Codex custom providers](https://developers.openai.com/codex/config-reference),
[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

The optional Claude efficiency mod remains off until explicitly enabled and
qualified against the endpoint. The presence of these features is not a claim
of 20x savings; only matched native inference benchmarks can establish that.
