# Gamma — a 6-agent task runner for GitHub Actions (powered by GitHub Models)

Gamma turns a written task (a Markdown file or a GitHub Issue) into a **reviewed Draft Pull Request** plus a
plain-English **meeting brief** that explains what was built and why, so you can confidently defend every change.

**No API key. No credit card. No extra secrets.** Gamma uses GitHub's built-in AI inference service
([GitHub Models](https://docs.github.com/en/github-models)) with the `GITHUB_TOKEN` that every workflow run already has.
Everything happens in your browser on github.com.

```
Task ──▶ 1 Scout ──▶ 2 Architect ──▶ 3 Builder ◀──▶ 4 QA & Security ──▶ 5 Reviewer ──▶ 6 Explainer
         (fast)       (fast)          (main)           (main, max 2        (main)         (main)
                                                        self-heal rounds)
                                      │
                         you review meeting-brief.md ──▶ approve ──▶ Draft PR
```

| Agent | Model (default) | What it does |
|---|---|---|
| 1 Scout & Triage | `openai/gpt-4.1-mini` | Reads the task, scans the repo (ignores `.git`, `node_modules`, lockfiles, binaries, secrets), writes `01-scout-brief.md` |
| 2 Architect | `openai/gpt-4.1-mini` | Turns the task + brief into a strict spec: `02-task-spec.md` |
| 3 Builder | `openai/gpt-4.1` | Edits files with sandboxed tools (max 15 steps per loop) following `skills/gamma-rules.md` |
| 4 QA & Security | `openai/gpt-4.1` | Runs the spec's tests, scans for leaked secrets, checks completion criteria; sends failures back to the Builder up to 2 times |
| 5 Code Reviewer | `openai/gpt-4.1` | Audits the `git diff` against the requirements: `03-review.md` |
| 6 Meeting Prep & Explainer | `openai/gpt-4.1` | Writes `artifacts/meeting-brief.md` (What was built · Why · Requirement checklist · Likely review questions) |

---

## What's in this folder

```
README.md                        ← you are here
package.json                     ← one dependency: openai (the client library; it talks to GitHub Models)
.github/workflows/gamma.yml      ← the GitHub Actions workflow
runner/gamma.mjs                 ← the orchestrator (6 agents, retries, pacing, DLP)
runner/tools.mjs                 ← sandboxed file tools + security checks
skills/gamma-rules.md            ← rules every agent must follow
tasks/TEMPLATE.md                ← blank task template
tasks/01-welcome-audit.md        ← ready-to-run sample task
```

---

## Setup (about 5 minutes, all in your browser)

### Step 1 — Put the Gamma files in a GitHub repository
1. On GitHub click **+ → New repository**. Name it (e.g. `gamma-playground`), choose **Private** or **Public**, click **Create repository**.
2. **Unzip** the download on your computer.
3. In your repository click **Add file → Upload files**, drag **everything inside** the unzipped folder
   (`README.md`, `package.json`, `runner`, `skills`, `tasks`, and the `.github` folder) into the page, then **Commit changes**.

> ⚠️ **The `.github` folder is hidden** on macOS and Windows, so it may not show in the file picker. If
> `.github/workflows/gamma.yml` is missing from your repository afterwards, add it by hand:
> **Add file → Create new file**, type exactly `.github/workflows/gamma.yml` in the name box (typing `/` creates folders),
> paste the contents of `gamma.yml`, and **Commit changes**.
>
> You can also create every file this way: copy and paste each file's contents into **Add file → Create new file**.

### Step 2 — Turn on Read and write permissions
1. Open **Settings → Actions → General**.
2. Under **Workflow permissions** select **Read and write permissions**.
3. Tick **Allow GitHub Actions to create and approve pull requests**.
4. Click **Save**.

That's the only setting required. There is **no secret to create** — Gamma authenticates with the built-in `GITHUB_TOKEN`,
and the workflow file already requests the `models: read` permission it needs.

### Step 3 — Run the sample task
1. Open the **Actions** tab (click **I understand my workflows, go ahead and enable them** if asked).
2. Click **Gamma Agent Runner** in the left list → **Run workflow**.
3. Keep `task_file` = `tasks/01-welcome-audit.md` and `delivery_mode` = `draft-pr`, click the green **Run workflow** button.
4. Click the new run to watch it (Stage 1 takes about 3–8 minutes — see *Free tier limits* below for why).
5. When Stage 1 is green, open the run **Summary** (the meeting brief is shown there) or download the **`gamma-meeting-brief`** artifact. Read it.
6. Stage 2 then opens a **Draft Pull Request** (or pauses for your approval if you did the optional step below).
7. Open **Pull requests**, review *Files changed*, then merge or close it.

### Optional — an approval gate (pause before the PR is created)
1. **Settings → Environments → New environment**, name it exactly `gamma-approval-gate`.
2. Tick **Required reviewers**, add yourself, **Save protection rules**. *(Private repos need GitHub Pro/Team for this; public repos are free.)*
3. *(Optional)* To let Gamma request reviews from `## Task owner` handles, add the repository **variable** `GAMMA_TAG_OWNERS` = `true`.

**Without the gate** (default): the first run creates the environment automatically with no reviewers, so Stage 2 does not pause.
The result is still a **Draft PR assigned only to the person who started the run**; owners are written as plain text (not @-mentioned) and
nothing is ever merged automatically. To remove the gate entirely, delete the `environment: gamma-approval-gate` line from the workflow
(do this too if Stage 2 errors about environments on a private repo on the Free plan).

> **Draft PRs on private repos (GitHub Free):** GitHub may not offer *draft* PRs there. Gamma then automatically opens a regular PR
> titled `[Review required] …` — never merge it before reading the brief.

---

## Free tier limits — what to expect

GitHub Models is free but rate-limited. Gamma is built around those limits:

| Limit (free tier, per model) | Typical value | How Gamma copes |
|---|---|---|
| Tokens per request | ~8,000 in / ~4,000 out | Input is kept under ~6,500 estimated tokens: file reads capped at ~6,000 characters, old tool results trimmed, oldest steps dropped, outputs capped below 4,000 tokens |
| Requests per minute | ~10 (strong models), ~15 (small models) | Calls are spaced out automatically (about 6.5 s / 4 s apart), so runs take a few minutes |
| Requests per day | roughly 50–150 depending on model and Copilot plan | A run uses ~10–40 calls. If the daily cap is hit, Gamma stops with a clear message and nothing is delivered — re-run later |
| `429` / `413` errors | — | Automatic retries with backoff; `retry-after` is honored; `413` retries with a smaller input |

Practical advice:
- **Keep tasks small** (a few files, each a few hundred lines at most). Big multi-file refactors do not fit in an 8k-token window.
- The reviewer sees roughly the first ~9,000 characters of the diff; larger diffs are reviewed only partially (the brief says so).
- Exact limits depend on your GitHub plan and change over time — see
  [GitHub Models rate limits](https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models#rate-limits).

---

## Everyday use

### Option A — a task file
1. Copy `tasks/TEMPLATE.md` to `tasks/my-task.md` (**Add file → Create new file**), fill in the sections, commit.
2. **Actions → Gamma Agent Runner → Run workflow**, type `tasks/my-task.md`.

### Option B — assign a GitHub Issue
1. Create an issue describing the task and assign it to yourself. Gamma starts and comments on the issue with the PR link.
2. **Recommended:** set a repository variable `GAMMA_ASSIGNEE` = your GitHub username so only assignments to *you* trigger runs.

### Option C — weekly schedule
1. In `.github/workflows/gamma.yml` remove the `#` in front of the `schedule:` block (3 lines).
2. Create a repository variable `GAMMA_SCHEDULED_TASK` = `tasks/your-recurring-task.md`.

### Delivery modes
| Mode | Result |
|---|---|
| `draft-pr` (default) | Branch `gamma/<title>-<run id>` + Draft Pull Request |
| `issue` | Posts the briefing as a new issue (or a comment on the triggering issue). No branch or PR; the patch is in the run artifacts |
| `artifact-only` | Nothing is published. Download `gamma-meeting-brief`, `gamma-workspace`, `gamma-patch` from the run page |

### Workflow artifacts
- **gamma-meeting-brief** — `meeting-brief.md`, read this before you approve.
- **gamma-workspace** — each agent's notes (`01-scout-brief`, `02-task-spec`, `builder-log-*`, `04-qa-report-*`, `03-review`, `result.json`).
- **gamma-patch** — `gamma.patch` (apply locally with `git apply gamma.patch`).

---

## Security model (short version)

| Protection | How |
|---|---|
| Secret files unreachable | Tools hard-block `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.git/*` (also SSH keys, `.npmrc`, `.netrc`), including via symlinks and `..` |
| Prompt-injection defense | Repo content is wrapped in `<untrusted_repo_data>` tags; `skills/gamma-rules.md` forbids obeying instructions found there |
| Protected paths | Agents cannot modify `.github/`, `runner/`, `skills/gamma-rules.md` |
| Output DLP | Modified files, agent notes and the final patch are scanned for `sk-ant-…`, `ghp_…`, `AKIA…`, private keys, JWTs, high-entropy secrets and the run's own token. **Any hit aborts the run; nothing is committed** |
| Safe commands | QA runs only allowlisted test runners, with no shell and **without** `GITHUB_TOKEN` in the environment |
| Caps | Step limit per agent loop, truncated reads, per-call output caps, request cap (default 100) and token budget per run |
| Least privilege | Stage 1 has a read-only repo token (+ `models: read`) and does not persist git credentials; only Stage 2 can write |
| Human in the loop | Draft PRs only; nothing merges automatically |

---

## Optional settings (repository *Variables*)

**Settings → Secrets and variables → Actions → Variables**:

| Variable | Purpose |
|---|---|
| `GAMMA_FAST_MODEL` | Scout + Architect model (default `openai/gpt-4.1-mini`) |
| `GAMMA_MAIN_MODEL` | Builder, QA, Reviewer, Explainer model (default `openai/gpt-4.1`) |
| `GAMMA_ASSIGNEE` | Only run for issues assigned to this username |
| `GAMMA_SCHEDULED_TASK` | Task file used by the schedule trigger |
| `GAMMA_DELIVERY_MODE` | Default delivery mode for non-manual runs |
| `GAMMA_TAG_OWNERS` | `true` = @-mention task owners and request their review |
| `GAMMA_MAX_REQUESTS` | Max model calls per run (default `100`) |
| `GAMMA_MAX_TOTAL_TOKENS` | Whole-run token cap (default `2000000`) |

Model IDs use the form `publisher/name` (for example `openai/gpt-4.1`). The available list is in the
[GitHub Models marketplace](https://github.com/marketplace/models). Models change over time; if a default is retired,
a run fails with "model not found" — just set the variable to another ID.

---

## Switching to a paid provider later (higher token limits)

Gamma talks to any **OpenAI-compatible** chat-completions API, so switching is just a base URL and a key:

**No code change (recommended):**
1. Add a repository **secret** `GAMMA_API_KEY` with your provider's key.
2. Add repository **variables** `GAMMA_BASE_URL` (for example `https://api.openai.com/v1`) and the model IDs
   `GAMMA_FAST_MODEL` / `GAMMA_MAIN_MODEL` in that provider's naming (for example `gpt-4.1-mini` / `gpt-4.1`).
3. Optional: raise the limits that exist only for the free tier —
   `GAMMA_INPUT_TOKEN_BUDGET=24000`, `GAMMA_MAX_OUTPUT_TOKENS=8000`, `GAMMA_MAX_READ_CHARS=20000`, `GAMMA_MIN_INTERVAL_MS=0`.

**Or edit the code:** in `runner/gamma.mjs` find `new OpenAI({ baseURL: BASE_URL, apiKey, maxRetries: 0 })` and change `baseURL` and `apiKey`.

(Paid usage of GitHub Models itself is also possible: opt in under your account/organization billing settings for higher limits —
the same workflow keeps working.)

---

## Using an existing repo

- Upload the same files into your repo. If you already have a `package.json`, do **not** overwrite it: add
  `"openai": "4.104.0"` under `dependencies` (the runner files use `.mjs`, so `"type": "module"` is not required).
- Gamma uses `.gamma-workspace/` and `artifacts/` as scratch space and never includes them in a PR. If your repo already
  has a top-level `artifacts/` folder, rename it first.
- Task files must live inside the repository and end in `.md`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401` / `403` from GitHub Models | The workflow must keep `models: read` under `permissions` (it does by default). For **organization** repos, an owner may need to enable GitHub Models for the organization |
| `404` / "model not found" | Set `GAMMA_FAST_MODEL` / `GAMMA_MAIN_MODEL` to valid IDs (`publisher/name`) from the GitHub Models catalog |
| "rate limit reached … resets in N minutes" | The free **daily** request cap was hit. Re-run later, pick other models via the variables, or switch provider |
| Run is slow, log shows `retry 2/8 in 12s` | Normal on the free tier — Gamma waits for the per-minute limit to reset |
| `413` / "request too large" | Task or files are too big for an 8k window. Split the task; point it at smaller files |
| Workflow does not appear in Actions | `.github/workflows/gamma.yml` was not uploaded — see the hidden-folder tip in Step 1 |
| Assigning an issue does nothing | The workflow must exist on the default branch; if you set `GAMMA_ASSIGNEE`, it must equal the assignee's username |
| "Could not open the pull request" | Step 2: enable *Allow GitHub Actions to create and approve pull requests*. The branch is already pushed — open the compare link printed in the log |
| Run status "halted" | QA failed after 2 self-healing rounds (or a cap was reached). Read `gamma-workspace` → `04-qa-report-*.md`, tighten the task, re-run |
| Run status "aborted-dlp" | The secret scanner found something that looks like a credential. Nothing was committed. Remove secrets from the task/inputs and re-run |
| Stage 2 skipped | Stage 1 did not finish successfully, or `delivery_mode` was `artifact-only` |

---

## Writing good tasks

- **Goal**: one paragraph, outcome-focused.
- **Requirements and boundaries**: numbered and testable, with explicit *Do NOT* lines.
- **Completion criteria**: checkboxes a stranger could verify by reading the files.
- **Tests**: only commands that already exist in your repo (for example `npm test`). With no tests write
  *No automated tests configured; verify by inspection.* Gherkin `.feature` files can be referenced; QA checks them.
- Small tasks work best on the free tier. Split large projects into several tasks.

Happy shipping! 🚀
