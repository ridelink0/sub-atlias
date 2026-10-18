# Direct model engines and explicit hosts

Atlias owns the model/tool loop for `responses`, `anthropic`, `gemini`, `openai`,
`ollama` and the optional local personal `chatgpt` prototype. File tools,
permissions, verification, task authority and compaction remain in Atlias.
`claude` and `codex` preserve existing saved-session names and explicitly run
the unmodified Claude Code/Codex harness. They are labelled host modes.

`auto` selects exactly one configured direct route. Multiple available routes
require a choice. Missing credentials never select another host, account or
billing source. Existing explicit host settings remain explicit host settings.

| Engine | Configuration | Credentials and billing |
| --- | --- | --- |
| `responses` | `agent.responsesModel`, `responsesUrl`, `responsesReasoningEffort` | `OPENAI_API_KEY` or dedicated `ATLIAS_RESPONSES_API_KEY`; separate API billing |
| `anthropic` | `agent.anthropicModel`, `anthropicUrl`, `anthropicMaxTokens` | `ANTHROPIC_API_KEY`; separate API billing |
| `gemini` | `agent.geminiModel`, `geminiUrl` | `GEMINI_API_KEY` or `GOOGLE_API_KEY`; separate API billing |
| `openai` | Existing compatible Chat settings remain supported | Existing environment keys; endpoint billing may apply |
| `ollama` | Existing local endpoint/model/context settings | Local models; setup uses `/api/tags` without inference |
| `chatgpt` | `agent.chatgptModel`, `chatgptReasoningEffort` | Dedicated, approved ChatGPT plan grant in the separate personal runtime |

Set a model and engine through `atlias config set agent.<setting> <value>`.
Keep keys in your local environment; never paste them into a website, model
prompt, public configuration or support transcript. `/status` reports the route,
model, reasoning, billing mode and the token counts actually reported. Missing
usage stays unknown. Stand-in provider tests establish protocol behavior, not
live account eligibility, model quality or subscription savings.

## ChatGPT local personal prototype

This optional integration is a separate personal experiment for Gev. The official
DevKit is **not bundled** in Atlias's public subharness or a paid Max release.
Commercial development, distribution or hosted use requires separate written
license/access authorization; personal preparation does not grant it.

In the downloaded local source, using Node 22.12 or newer:

```text
node scripts/setup-chatgpt-personal.mjs --personal
atlias auth chatgpt status
atlias auth chatgpt login
atlias auth chatgpt models
atlias auth chatgpt use gpt-6.1-sol xhigh
```

The setup pins official DevKit commit
`0a36fefeb913055c8c7a1a29b63d82b96b2e841a` outside the app checkout, preserves its
license and notices, and strips TypeScript with Node's runtime transformer.
It does not invoke a type checker. The only local SDK extension is a trusted
request callback; the official OAuth state/nonce/PKCE, registration, host ID,
profile binding, refresh locking and cancellation remain intact.

Credentials use Windows CurrentUser DPAPI. There is no plaintext fallback.
Other platforms require an OS-backed encryption adapter before this prototype
can sign in. Existing Codex/Claude credentials are never read or reused.

The browser must approve `chatgpt.tokens.use.direct`; identity-only login cannot
discover models or infer. `/auth chatgpt status`, `profiles`, `select <id>`,
`logout` and `cancel` manage the separate connection. Ctrl+C cancels a pending
sign-in. Logout removes local credentials and reports if remote revocation could
not be confirmed. Sign in again to recover an expired or revoked account.

The account's model catalog must include the exact requested model. Sol's
documented reasoning support includes `xhigh`; it does not include `none` or
`minimal`. The app refuses unavailable models or unverified effort choices.
No model or reasoning replacement, API-key fallback or paid request is made.
Plan inference uses only public `/v1/responses`, `store:false`, `stream:true`,
and requires a completed terminal event before tools may run. Plan usage is
visible at <https://chatgpt.com/settings/usage>.

## Claude and Google

Direct Claude uses supported Anthropic API credentials. Claude subscription
OAuth is not a third-party API credential; explicit `claude` host mode uses the
unmodified native client instead. Direct Gemini uses the supported API path.
Antigravity consumer login/token extraction and `agy -p` wrappers are not an
Atlias engine. Enterprise routes need their documented credentials/endpoint;
this implementation makes no claim of an unverified enterprise sign-in.

Primary references:

- [Official ChatGPT integration](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
- [DevKit and noncommercial license](https://github.com/openai/sign-in-with-chatgpt-devkit)
- [Plan Responses contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Sol model capabilities](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [Claude credential rules](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
- [Antigravity FAQ](https://www.antigravity.google/docs/faq)
