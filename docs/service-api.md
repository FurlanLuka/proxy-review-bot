# Service API

The menu bar app starts the review service and talks to it over HTTP on 127.0.0.1.

## Launch

The service is compiled with `bun build --compile` (from `src/entry.ts`, with `.env` and `bunfig.toml` autoloading turned off) into `ProxyReviewBot.app/Contents/MacOS/proxy-review-bot-service`, so users don't need Bun. The installed app only runs that binary. When the app runs outside a `.app` bundle (development), it runs `<bun> --no-env-file <service>/src/entry.ts` instead.

Either way it starts with:

- `PRB_TOKEN`: a random token the app generates on each launch.
- `PATH`: the login shell's PATH.

stdin is kept open as a pipe. The service exits when stdin closes, which happens when the app quits or crashes.

### Command shims

On start the service writes `gh` and `git` shims into `<data dir>/bin` and puts that folder first on Claude's PATH. Each shim records the caller's directory in `PRB_SHIM_CWD`, changes to the shim folder, and re-runs the service with the internal `--command-shim <tool> <real path>` argument. That blocks writes and runs the real tool back in the caller's directory. Because Bun starts from the shim folder, a `.env` or `bunfig.toml` in the repo under review is never loaded. The shim also unsets every `BUN_*` variable and `NODE_OPTIONS` before starting Bun, and the service strips them from Claude's environment, so a `BUN_OPTIONS=--preload …` can't run code either. Only `gh` and `git` are accepted; any other tool name exits 2.

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
			"headRefName": "fix-auth-retry",
			"baseRefName": "main",
			"summary": "Retry logic sound, tests cover backoff",
			"reason": null,
			"retryAt": null,
			"isStarted": true,
			"isOwn": false,
			"isDraft": false,
			"isManualStart": false,
			"source": "requested",
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
  - `draft_ready` (Post reviews: `ask`): a finished review is waiting for you to check it. You can edit, post, approve or discard it. With `postReviews: auto`, reviews post on their own.
- `draft`: on `draft_ready` and `awaiting_approval` rows, `{ "filing": "comment" | "approve", "summary": "…", "commentCount": 3 }`; otherwise null.
- `summary`: the last one-line review summary.
- `reason`: why the PR is `needs_you`, `blocked` or failed.
- `retryAt`: epoch ms when a failed review is tried again, on a `waiting_on_author` row with a `reason`, with `reviewMode: auto` (Start reviews: Automatically) or once the review has started, and only when the PR's branches aren't in `manualStartBranches`; otherwise null.
- `isStarted`: true once the PR's first review was queued (you clicked Review or Retry, or `reviewMode: auto` queued it). A started PR keeps going on its own, even with `reviewMode: manual`: new commits (after the quiet period), a re-request from the author on the same commit, and a failed run after its backoff all queue the next round. With `postReviews: ask` each round is still held as a draft for you. Re-requesting a stopped PR starts over as not started. A re-request is read from the PR's own `requested_reviewers` each sync, not from search, so toggling draft or a lagging search index doesn't count as one; a re-request seen while the bot is paused, running or the PR is a draft is acted on once that ends. A re-request skips the quiet period.
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

- `isOwn`: true when you wrote the PR (author matches your `gh` login, ignoring case). GitHub only accepts comment reviews from a PR's author, so on your own PR every draft is a comment (an approve-level result is filed as a comment), approving answers 409 `own_pr`, posting with `APPROVE` or `REQUEST_CHANGES` answers 400 `invalid_draft` with the reason "you can only comment on your own PR", and your own comment reviews there don't count as you taking over.
- `isDraft`: the PR is a GitHub draft. A started draft PR waits in `needs_review` and is reviewed once it's marked ready. A draft whose branches match `manualStartBranches` keeps waiting for Review after it's marked ready.
- `headRefName`, `baseRefName`: the PR's head and base branch names; null until the first sync after the PR was found.
- `isManualStart`: true when the PR waits in `needs_review` because its branches match `manualStartBranches`, so only your click starts a round.
- `source`: `requested` when the bot found the PR because you were asked to review, `link` when you added it with POST /prs.

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
| `/prs/:id/review` | queue a review (`reviewMode: manual`, or Review again) | 404, 409 `busy` (a review or approval is running) |
| `/prs/:id/approve` | approve an `awaiting_approval` PR, or a `draft_ready` PR whose draft filing is `approve`, unedited | 404, 409 `head_moved` (the PR is re-queued), 409 `not_awaiting_approval`, 409 `busy` |
| `/prs/:id/stop` | stop the bot on this PR; a running Claude review is killed right away | 404 |
| `/prs/:id/post` | post the draft, edited or not; body below | 404, 400 `invalid_draft` with a `reason`, 409 `no_draft`, `head_moved` (the PR is re-reviewed), `busy` |
| `/prs/:id/discard` | throw the draft away; the PR waits for new commits | 404, 409 `no_draft` |
| `/prs/:id/retry` | reset rounds and attempts, then queue a review | 404, 409 `busy` |
| `/prs/:id/approve` on your own PR | refused | 409 `own_pr` |
| `/pause`, `/resume` | pause or resume the whole bot | |
| `/readiness/check` | re-run the setup checks | |

## POST /prs

Adds a PR by its link and starts reviewing it, even if nobody requested your review. Body: `{ "url": "https://github.com/<owner>/<repo>/pull/<number>" }`. Trailing paths (`/files`, `/commits/<sha>`), a query, a fragment and a missing `https://` are fine. Only github.com is supported.

Returns `{ "id": 12, "isExisting": false }`. `isExisting` is true when the PR was already in review and nothing changed.

- A new PR is tracked with `source: "link"` and queued at once. A GitHub draft is started but waits in `needs_review` until it's ready.
- A PR the bot found but you hadn't started is queued, like clicking Review.
- A finished, stopped, given-up or blocked PR starts a fresh cycle (pasting the link is an explicit retry).
- Anything else already in review is left alone and answers `isExisting: true`.
- The log line `pull_request_added_by_link` and the `added_by_link` activity record an `outcome`: `inserted` (new), `started` (it was waiting for you to start it), `requeued` (a fresh cycle) or `existing` (left alone).
- Owner and repo come from GitHub's answer, so a link in different case or to a renamed repo finds the same PR.
- The watch and skip lists don't apply: adding a link is explicit.

| Status | Error | When |
|---|---|---|
| 400 | `invalid_link` | not a GitHub PR link |
| 400 | `unsupported_host` | a link to another host |
| 404 | `pr_not_found` | the PR doesn't exist, or your `gh` login can't see it |
| 403 | `no_access` | GitHub refused (SSO, or a 403/429 rate limit) |
| 409 | `pr_closed` | the PR is closed; `reason` is `merged` or `closed` |
| 502 | `github_unavailable` | GitHub couldn't be reached |

A PR added while a sync is running can, rarely, be set back to `needs_review` by that sync, the same as Retry.

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
	"coverage": "Checked retry paths; couldn't run the tests.",
	"isOwn": false
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
	"postReviews": "ask",
	"autoApprove": "off",
	"smallPullRequestLineLimit": 200,
	"maxRounds": 5,
	"pollIntervalSeconds": 60,
	"answerQuestions": true,
	"watch": ["acme"],
	"skip": ["acme/infra"],
	"toolPaths": { "claude": null, "gh": null, "git": null },
	"manualStartBranches": [
		{ "head": "develop", "base": "master" },
		{ "head": "develop", "base": "main" }
	],
	"claudeModel": null
}
```

- `reviewMode`: who starts reviews (Start reviews in the app). `manual`: you click Review. `auto`: requested PRs are reviewed on their own.
- `postReviews`: how finished reviews are posted (Post reviews in the app). `ask`: each review is held as a draft for you. `auto`: comment reviews post on their own, and an approving review follows `autoApprove`. It's independent of `reviewMode`. A body, or an older settings file, without it gets it derived from `reviewMode` (`auto` → `auto`, `manual` → `ask`). Changing it only affects reviews that finish afterwards; drafts already held stay until you act.
- `manualStartBranches`: head → base pairs (Start manually in the app) whose PRs never start a round on their own, in either start mode and even after you've started them: new commits, a re-request or a failed run's backoff move a started PR to `needs_review` once instead of queueing it, and the round limit doesn't apply. Review, Retry and POST /prs each run one round. Names match exactly (case-sensitive), fork heads included. Defaults to develop → master and develop → main, also for an older settings file without it; an empty list turns it off.
- `autoApprove`: `off`, `on` or `small`. It only applies when `postReviews` is `auto`; with `off`, an approving review waits for your click.
- `claudeModel`: the model passed to `claude --model` for reviews, their repair resumes and replies (Claude model in the app), or null for Claude Code's own default. An alias (`opus`, `sonnet`, `haiku`, `fable`) or a full model id; it must start with a letter or digit, up to 100 characters of letters, digits and `._:[]-`. Each job reads it once when it starts, so a change applies to the next run. Proxy's advisor agents pin their own model and aren't affected. A model Claude doesn't know fails the run, and the PR's `reason` is Claude's message. Defaults to null, also for an older settings file without it.
- `toolPaths`: each value is a string or null. null means look it up on PATH.
- PUT takes the full object (`postReviews`, `manualStartBranches` and `claudeModel` may be left out, see above) and returns the saved settings. An invalid body gets 400 `{ "error": "invalid_settings" }` and leaves the saved settings unchanged.
