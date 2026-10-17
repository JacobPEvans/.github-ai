# PR Agent

`pr-agent.yml` runs [PR-Agent](https://github.com/The-PR-Agent/pr-agent)
against the org's OpenAI-compatible model router. It replaces the hand-written
`local-review.yml` and the former `router` provider of the code simplifier: the
same three jobs (review the diff, suggest simplifications, rewrite the
description) are things PR-Agent already does, so this repository carries the
wiring and none of the prompting machinery.

| Tool | Input | What it does |
| --- | --- | --- |
| `review` | `review` (default `true`) | Verdicts on the diff as one comment, updated in place on later pushes |
| `improve` | `improve` (default `false`) | Code suggestions on the diff, as review comments |
| `describe` | `describe` (default `false`) | **Rewrites the pull request title and body** |

Leave `describe` off wherever something else owns the body — release-please's
release pull requests, or a provenance footer.

## Failure contract

Not advisory. If the router is down or at capacity the job fails, releasing
the runner: the router admits or refuses at once, and the job is capped
(`timeout_minutes`, five by default). The router role's fallback ladder absorbs load. A wrong key,
base URL or model fails at once. A
model error fails the job rather than being swallowed: PR-Agent 0.45.0's
CLI exits 0 either way (`config.propagate_tool_errors` only changes what it
logs; fixed upstream in qodo-ai/pr-agent#3368, not yet in an image), so
`run.sh` fails the step on its failure log line. Each model call is exactly
one request: a timed-out call is not replayed on the same model
(`config.retry_same_model_on_timeout=false`) and the completion client adds
no retries of its own (`config.num_retries=0`). The router bounds the
request and walks the role's ladder; a Gateway Timeout from it is final.
`config.ai_timeout` is 240 seconds inside the five-minute job cap, leaving a
60-second margin for setup and PR publication. It is a
number rather than the settings loader's null token because PR-Agent
re-reads its environment with casting off once it applies repo settings, and
the token then reaches the completion client as a literal string.

This is deliberate: the workflow this replaced reported success while doing
nothing for weeks, because "router credential not configured" was a
skip-and-succeed path. The org ruleset runs this workflow as a required check
on every pull request, so an outage blocks merges until the review is re-fired
(a push or a close/reopen) once the endpoint is back.

## Runner

`runner_label` defaults to `self-hosted`. The router is only reachable from
inside the estate, so nothing else can review anything. Repository visibility
picks the router key and role — a private repo uses `LLM_ROUTER_API_KEY` with
`model`, an open-source repo `LLM_ROUTER_OSS_API_KEY` with `oss_model` — and
each role carries its own fallback ladder on the router, so where a diff may
travel is decided there, never here.

PR-Agent runs as its published container through the CLI it documents, not as
a container action: the shared runner pool passes the Docker socket through
without a host-identical work directory, so a container action would receive an
empty workspace and no event payload. The CLI needs neither — it reads the pull
request over the API — and the image is pinned by digest in
`.github/scripts/pr-agent/run.sh`.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `runner_label` | `self-hosted` | Runner label; must reach the router |
| `model` | `medium` | Private repos: router **capability name** (never a vendor id) one `LLM_ROUTER_API_KEY` may call |
| `oss_model` | `review-oss` | Open-source repos: router capability name one `LLM_ROUTER_OSS_API_KEY` may call |
| `max_tokens` | `32000` | Input context to assume for the model (`custom_model_max_tokens`) |
| `timeout_minutes` | `5` | Maximum job time; pull-request runs are capped at five minutes |
| `review` | `true` | Run the review tool |
| `improve` | `false` | Run the improve tool |
| `describe` | `false` | Run the describe tool (rewrites title and body) |

## Configuration

| Name | Kind | Holds |
| --- | --- | --- |
| `LLM_ROUTER_BASE_URL` | Actions **secret** | The router's OpenAI-compatible base URL, ending in `/v1` |
| `LLM_ROUTER_API_KEY` | Actions **secret** | Scoped router virtual key for private repositories (never the router's master key) |
| `LLM_ROUTER_OSS_API_KEY` | Optional Actions **secret** | A second router virtual key, scoped to the open-source role; read only on such a repo |

Reusable-workflow callers pass the base URL and private-repository key, plus the
open-source key when reviewing public repositories. The required workflow entry
reads all three values from OpenBao instead of relying on GitHub secrets.

## Central rubric

The workflow checks out `pr-agent/rubric.toml` from the same commit as the
reusable workflow, then passes its `[pr_reviewer] extra_instructions` and
`[pr_code_suggestions] extra_instructions` through PR-Agent's environment
overrides. These values take precedence over matching settings in a consumer's
`.pr_agent.toml`, so every repository receives the same review and suggestion
rubric. Consumer settings unrelated to these two prompts can still apply.

## Calling it

```yaml
name: PR Agent
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  pr-agent:
    permissions:
      contents: read
      pull-requests: write
    uses: JacobPEvans/.github-ai/.github/workflows/pr-agent.yml@v1
    with:
      improve: true
    secrets:
      LLM_ROUTER_BASE_URL: ${{ secrets.LLM_ROUTER_BASE_URL }}
      LLM_ROUTER_API_KEY: ${{ secrets.LLM_ROUTER_API_KEY }}
      LLM_ROUTER_OSS_API_KEY: ${{ secrets.LLM_ROUTER_OSS_API_KEY }}
```

Do **not** give the caller a `concurrency:` block that repeats this workflow's
own group. A caller sharing the reusable workflow's exact concurrency group
produces an opaque zero-job `startup_failure` that appears nowhere in the API.

## Required workflow entry

`.github/workflows/ai-review.yml` is the input-free, secretless required entry.
It retains the scope classifier, dependency-bot skip, and fork rejection, then
reads the router credentials from OpenBao before its review step reads the pull
request. The OpenBao role binds to this required workflow's OIDC identity, so
the required entry runs the shared PR-Agent runner directly. The reusable
`pr-agent.yml` remains available to existing callers, which continue to pass
its current router secrets.

## Security notes

- `pull_request` only, never `pull_request_target`.
- Same-repo heads only, so a fork never receives the OIDC token or router key.
  Draft pull requests are reviewed too.
- The job token is read-only on contents and write only on pull requests.
- Credentials reach Docker by environment variable name, so their values do
  not appear in process arguments or temporary files.
- The base URL and its bare host are registered with `::add-mask::` before the
  first request: a connection error names the host, and that string is not the
  secret, so Actions would not mask it on its own.
- Review labels are off. Creating a label that does not exist would need
  `issues: write`, which no caller has to grant for a review.
- The diff is sent to the configured router and nowhere else.
