# Service API

The menu bar app starts the Bun service and talks to it over HTTP on 127.0.0.1.

## Launch

The app runs `<bun> <service>/src/main.ts` with:

- `PRB_TOKEN`: a random token the app generates on each launch.
- `PATH`: the login shell's PATH.

stdin is kept open as a pipe. The service exits when stdin closes, which happens when the app quits or crashes.

Once it's listening, the service prints one JSON line to stdout:

```json
{"event":"listening","port":54321}
```

The service writes its logs to `~/Library/Logs/ProxyReviewBot/service.log`.

## Authentication

Every request carries `Authorization: Bearer <PRB_TOKEN>`. A request without it gets 401.

## GET /state

```json
{
	"viewerLogin": "FurlanLuka",
	"isPaused": false,
	"usageLimitedUntil": null,
	"readiness": {
		"status": "ready",
		"checks": [
			{ "name": "claude_logged_in", "isOk": true, "label": "Claude logged in (max)", "fix": null }
		]
	},
	"settings": { "...": "same shape as GET /settings" },
	"pullRequests": [
		{
			"id": 1,
			"owner": "acme",
			"repo": "api",
			"number": 412,
			"title": "Fix auth retry",
			"url": "https://github.com/acme/api/pull/412",
			"author": "ana",
			"status": "awaiting_approval",
			"rounds": 2,
			"maxRounds": 5,
			"additions": 84,
			"deletions": 12,
			"headSha": "abc123",
			"summary": "Retry logic sound, tests cover backoff",
			"reason": null,
			"reviewStartedAt": null,
			"updatedAt": 1793015179000
		}
	]
}
```

- `usageLimitedUntil`: epoch ms or null.
- `readiness.status`: `ready`, `setup_needed` or `checking`.
- `checks[].fix`: a shell command to show with a Copy button, or null.
- `status`: one of `needs_review`, `queued`, `reviewing`, `waiting_on_author`, `awaiting_approval`, `blocked`, `needs_you`, `done`, `stopped`.
- `summary`: the last one-line review summary.
- `reason`: why the PR is `needs_you`, `blocked` or failed.
- `reviewStartedAt`: epoch ms while the status is `reviewing`.
- Rows are ordered by `updatedAt` descending. `done` rows are only included for 24 hours.

## Actions

Every action is a POST, returns `{ "ok": true }` with status 200, and returns `{ "error": "<code>" }` on failure.

| Route | Effect | Errors |
|---|---|---|
| `/prs/:id/review` | queue a review (manual mode, or Review again) | 404, 409 `busy` (a review or approval is running) |
| `/prs/:id/approve` | approve an `awaiting_approval` PR | 404, 409 `head_moved` (the PR is re-queued), 409 `not_awaiting_approval`, 409 `busy` |
| `/prs/:id/stop` | stop the bot on this PR | 404 |
| `/prs/:id/retry` | reset rounds and attempts, then queue a review | 404, 409 `busy` |
| `/pause`, `/resume` | pause or resume the whole bot | |
| `/readiness/check` | re-run the setup checks | |

## GET /settings, PUT /settings

```json
{
	"reviewMode": "manual",
	"autoApprove": "off",
	"smallPullRequestLineLimit": 200,
	"maxRounds": 5,
	"pollIntervalSeconds": 60,
	"answerQuestions": true,
	"watch": ["acme"],
	"skip": ["acme/infra"],
	"toolPaths": { "claude": null, "gh": null, "git": null }
}
```

- `reviewMode`: `manual` or `auto`.
- `autoApprove`: `off`, `on` or `small`.
- `toolPaths`: each value is a string or null. null means look it up on PATH.
- PUT takes the full object and returns the saved settings. An invalid body gets 400 `{ "error": "invalid_settings" }` and leaves the saved settings unchanged.
