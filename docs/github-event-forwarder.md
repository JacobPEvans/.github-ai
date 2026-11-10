# GitHub event forwarder

`github-event-forwarder.yml` posts event metadata to a Dify webhook trigger.
It accepts `agent_name` and `runner_label` (default `self-hosted`), and one
secret, `webhook_url`, which the caller passes explicitly. The runner provides
Bash, jq, curl, and access to the webhook. The older form, `secrets: inherit`
with `webhook_url_secret_name`, still works.

The JSON envelope contains:

| Field | Value |
| --- | --- |
| `id` | Workflow run ID, stable across reruns |
| `source` | `github` |
| `type` | Event name and action, such as `pull_request.opened` |
| `agent` | Caller-supplied agent name |
| `subject` | Pull request, check run, or repository HTML URL, in that order |
| `revision` | Pull request head, check run head, or workflow commit SHA |
| `actor` | GitHub actor login |
| `time` | UTC forwarding time in ISO 8601 format |
| `correlation_id` | Repository full name followed by `/` and workflow run ID |

Delivery uses HTTPS with a 10-second connection timeout and a 60-second total
timeout. Missing configuration, transport errors, and HTTP errors fail the job.
Responses are discarded. Reruns keep `id` and `correlation_id`; receivers can use
these values to deduplicate deliveries. Each caller job should invoke this
workflow once per run for its selected agent.

The dogfood caller forwards pull request and completed check run events to
`ci-fixer`. Enable it with the repository variable `DOGFOOD_SELF_HOSTED=true`
and the secret `DIFY_CI_FIXER_WEBHOOK_URL`. Fork pull requests are excluded.
GitHub's native check run trigger rules apply, including recursion prevention
for checks created by GitHub Actions. Check run triggers use the caller on the
default branch.
