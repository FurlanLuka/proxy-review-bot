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
			"retryAt": null,
			"reviewStartedAt": null,
			"updatedAt": 1793015179000,
			"progress": null
		}
	]
}
```

- `usageLimitedUntil`: epoch ms or null.
- `readiness.status`: `ready`, `setup_needed` or `checking`.
- `checks[].fix`: a shell command to show with a Copy button, or null.
- `status`: one of `needs_review`, `queued`, `reviewing`, `waiting_on_author`, `awaiting_approval`, `draft_ready`, `blocked`, `needs_you`, `done`, `stopped`.
  - `draft_ready` (manual mode): a finished review is waiting for you to check it. You can edit, post, approve or discard it. In auto mode, reviews post on their own.
- `draft`: on `draft_ready` and `awaiting_approval` rows, `{ "filing": "comment" | "approve", "summary": "…", "commentCount": 3 }`; otherwise null.
- `summary`: the last one-line review summary.
- `reason`: why the PR is `needs_you`, `blocked` or failed.
- `retryAt`: in auto mode, epoch ms when a failed review is tried again, on a `waiting_on_author` row with a `reason`; otherwise null. In manual mode a failed review waits for you.
- `reviewStartedAt`: epoch ms while the status is `reviewing`.
- `progress`: live progress while a review or reply is running, otherwise null. It's kept in memory only:

  ```json
  {
  	"phase": "review",
  	"message": "Waiting on 4 advisors and the bug check",
  	"updatedAt": 1793015300000,
  	"subagents": [
  		{
  			"id": "toolu_01…",
  			"agentType": "proxy:architect",
  			"label": "Architecture",
  			"description": "Review module design",
  			"status": "running",
  			"currentStep": "Running git show …",
  			"startedAt": 1793015200000,
  			"finishedAt": null
  		}
  	]
  }
  ```

  - `phase` and `message` come from the `PRB_STATUS {…}` lines the review prompt asks Claude to print.
  - `subagents` comes from Claude Code's own `task_started`, `task_progress` and `task_notification` stream events.
  - A subagent's `status` is `running`, `completed` or `failed`.
- Rows are ordered by `updatedAt` descending. `done` rows are only included for 24 hours.

## GET /history

Finished PRs from the last 30 days, newest first, at most 200.

```json
{
	"entries": [
		{
			"id": 3,
			"owner": "acme",
			"repo": "api",
			"number": 412,
			"title": "Fix auth retry",
			"url": "https://github.com/acme/api/pull/412",
			"author": "ana",
			"outcome": "approved_by_bot",
			"rounds": 2,
			"finishedAt": 1793015179000
		}
	]
}
```

- `outcome`: how the bot's work on the PR ended, checked in this order:
  - `approved_by_bot`: the bot posted an approval (auto-approve, Approve, or an approving draft). This wins even if the PR merged afterwards, or you pressed Stop while the approval was posting;
  - `stopped`: you stopped the bot on this PR;
  - `taken_over`: you reviewed the PR yourself, so the bot stepped back. This wins over a later merge or close;
  - `approved_by_you`: the PR was approved, but not by the bot;
  - `merged`, `closed`: the PR was merged or closed.
- Only the latest review cycle counts: a re-request or a Retry starts a new cycle, and earlier rounds don't affect `outcome`.
- A PR the bot gave up on is still open, so it isn't listed.
- `finishedAt`: epoch ms when the PR reached that state.

## Actions

Every action is a POST, returns `{ "ok": true }` with status 200, and returns `{ "error": "<code>" }` on failure.

| Route | Effect | Errors |
|---|---|---|
| `/prs/:id/review` | queue a review (manual mode, or Review again) | 404, 409 `busy` (a review or approval is running) |
| `/prs/:id/approve` | approve an `awaiting_approval` PR, or a `draft_ready` PR whose draft filing is `approve`, unedited | 404, 409 `head_moved` (the PR is re-queued), 409 `not_awaiting_approval`, 409 `busy` |
| `/prs/:id/stop` | stop the bot on this PR; a running Claude review is killed right away | 404 |
| `/prs/:id/post` | post the draft, edited or not; body below | 404, 400 `invalid_draft` with a `reason`, 409 `no_draft`, `head_moved` (the PR is re-reviewed), `busy` |
| `/prs/:id/discard` | throw the draft away; the PR waits for new commits | 404, 409 `no_draft` |
| `/prs/:id/retry` | reset rounds and attempts, then queue a review | 404, 409 `busy` |
| `/pause`, `/resume` | pause or resume the whole bot | |
| `/readiness/check` | re-run the setup checks | |

## GET /prs/:id/draft

Returns the draft held for a `draft_ready` or `awaiting_approval` PR. It responds 404 when the PR doesn't exist, and 409 `no_draft` when the PR has no draft.

```json
{
	"headSha": "abc123",
	"filing": "comment",
	"summary": "Retry loop never backs off",
	"mainReview": "The retry loop needs a backoff…",
	"comments": [{ "path": "src/retry.ts", "line": 12, "side": "RIGHT", "body": "No delay between attempts." }],
	"fileComments": [{ "path": "src/old.ts", "body": "This file can go." }],
	"coverage": "Checked retry paths; couldn't run the tests."
}
```

## POST /prs/:id/post

Posts what you send, which can differ from the stored draft:

```json
{
	"headSha": "abc123",
	"event": "COMMENT",
	"mainReview": "…edited text…",
	"comments": [{ "path": "src/retry.ts", "line": 12, "side": "RIGHT", "body": "…" }],
	"fileComments": []
}
```

- `headSha` must be the `headSha` from GET /prs/:id/draft. A draft that was replaced since you opened it returns 409 `head_moved`.
- `event` is `COMMENT`, `APPROVE` or `REQUEST_CHANGES`.
  - `COMMENT` and `REQUEST_CHANGES` are always allowed.
  - `APPROVE` only when the draft's filing is `approve`.
  - The skill never proposes `REQUEST_CHANGES` itself; it is only ever your choice.
- Drop a comment by leaving it out. Only the `path`, `line` and `side` values from the draft are accepted, so an anchor can't be invented.
- The bot's marker is added to every body when posting.
- Before posting, the service checks the PR head is still the drafted one.
- Afterwards the status becomes `waiting_on_author` for `COMMENT`, or `done` for `APPROVE`.

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
