# Gamma — a 6-agent task runner for GitHub Actions

Gamma turns a written task (a Markdown file or a GitHub Issue) into a **reviewed Draft Pull Request** plus a
plain-English **meeting brief** that explains what was built and why, so you can confidently defend every change.

Everything runs in GitHub Actions. You only use the **GitHub website** — nothing to install on your computer.

```
Task ──▶ 1 Scout ──▶ 2 Architect ──▶ 3 Builder ◀──▶ 4 QA & Security ──▶ 5 Reviewer ──▶ 6 Explainer
         (Haiku)      (Haiku)         (Sonnet)         (Sonnet, max 2       (Sonnet)       (Sonnet)
                                                        self-heal rounds)
                                      │
                         you review meeting-brief.md ──▶ approve ──▶ Draft PR
```

| Agent | Model | What it does |
|---|---|---|
| 1 Scout & Triage | Haiku | Reads the task, scans the repo (ignores `.git`, `node_modules`, lockfiles, binaries, secrets), writes `01-scout-brief.md` |
| 2 Architect | Haiku | Turns the task + brief into a strict spec: `02-task-spec.md` |
| 3 Builder | Sonnet | Edits files with sandboxed tools (max 15 steps per loop) following `skills/gamma-rules.md` |
| 4 QA & Security | Sonnet | Runs the spec's tests, scans for leaked secrets, checks completion criteria; sends failures back to the Builder up to 2 times |
| 5 Code Reviewer | Sonnet | Audits the `git diff` against the requirements: `03-review.md` |
| 6 Meeting Prep & Explainer | Sonnet | Writes `artifacts/meeting-brief.md` (What was built · Why · Requirement checklist · Likely review questions) |

---

## What's in this folder

```
README.md                        ← you are here
package.json                     ← one dependency: @anthropic-ai/sdk
.github/workflows/gamma.yml      ← the GitHub Actions workflow
runner/gamma.mjs                 ← the orchestrator (6 agents, retries, DLP)
runner/tools.mjs                 ← sandboxed file tools + security checks
skills/gamma-rules.md            ← rules every agent must follow
tasks/TEMPLATE.md                ← blank task template
tasks/01-welcome-audit.md        ← ready-to-run sample task
```

---

## Setup (about 10 minutes, all in your browser)

### Step 1 — Get an Anthropic API key
1. Go to <https://console.anthropic.com/> and sign in.
2. Open **API Keys → Create Key**. Copy the key (it starts with `sk-ant-`). You will not see it again.
3. Make sure the account has credits (a free-trial / Tier 1 account is fine for the sample task).

### Step 2 — Put the Gamma files in a GitHub repository
1. On GitHub click **+ → New repository**. Name it (e.g. `gamma-playground`), choose **Private**, tick
   **Add a README file** only if you want one, and click **Create repository**.
   (You can also use an existing repository — see *Using an existing repo* below.)
2. **Unzip** `gamma-agent-runner.zip` on your computer.
3. In your repository click **Add file → Upload files**.
4. Open the unzipped folder and **drag everything inside it** (`README.md`, `package.json`, `runner`, `skills`,
   `tasks`, and the `.github` folder) into the browser window. Wait until every file is listed, then click **Commit changes**.

> ⚠️ **The `.github` folder is hidden** on macOS and Windows, so you may not see it in the file picker.
> Dragging the whole unzipped folder usually works. If `.github/workflows/gamma.yml` does not show up in your
> repository, add it by hand:
> 1. **Add file → Create new file**.
> 2. In the name box type exactly `.github/workflows/gamma.yml` (typing the `/` creates the folders).
> 3. Paste the contents of `gamma.yml`, then **Commit changes**.

Check that your repository now contains `.github/workflows/gamma.yml`, `runner/`, `skills/`, `tasks/` and `package.json`.

### Step 3 — Add your API key as a secret
1. In your repository open **Settings → Secrets and variables → Actions**.
2. Click **New repository secret**.
3. Name: `ANTHROPIC_API_KEY` (exactly, capital letters). Secret: paste your key. Click **Add secret**.

### Step 4 — Allow the workflow to open Pull Requests
1. Open **Settings → Actions → General**.
2. Scroll to **Workflow permissions**.
3. Select **Read and write permissions**.
4. Tick **Allow GitHub Actions to create and approve pull requests**.
5. Click **Save**.

> If you skip this, Gamma still works: it pushes a branch and tells you the link to open the PR yourself.

### Step 5 — (Optional but recommended) Create the approval gate
This makes Stage 2 **pause** until you have read the meeting brief.

1. Open **Settings → Environments → New environment**.
2. Name it exactly `gamma-approval-gate` and click **Configure environment**.
3. Tick **Required reviewers**, add yourself (and teammates), click **Save protection rules**.
   *(On private repositories this needs GitHub Pro/Team; on public repositories it is free.)*
4. *(Optional)* To let Gamma request reviews from the `## Task owner` handles, add a repository variable:
   **Settings → Secrets and variables → Actions → Variables → New repository variable**,
   Name `GAMMA_TAG_OWNERS`, Value `true`.

**If you do not create the environment** (fallback): the first run creates it automatically with no reviewers,
so Stage 2 does not pause. That is still safe — the result is a **Draft PR assigned only to the person who started
the run**, owners are written as plain text (not @-mentioned), and nothing is ever merged automatically.
If you want to remove the gate entirely, delete the `environment: gamma-approval-gate` line from the workflow.

### Step 6 — Run the sample task
1. Open the **Actions** tab. If asked, click **I understand my workflows, go ahead and enable them**.
2. In the left list click **Gamma Agent Runner**.
3. Click **Run workflow**. Keep `task_file` = `tasks/01-welcome-audit.md` and `delivery_mode` = `draft-pr`. Click the green **Run workflow** button.
4. Click the new run to watch it. Stage 1 takes roughly 2–6 minutes.
5. When Stage 1 is green, scroll down the run page to **Artifacts** and download **`gamma-meeting-brief`** (also shown at the top of the run page under *Summary*). Read it.
6. If you created the approval gate, Stage 2 shows **Waiting** → click **Review deployments**, tick `gamma-approval-gate`, and click **Approve and deploy**.
7. Open the **Pull requests** tab: you will see a **Draft** PR with the briefing in its description. Review the *Files changed*, then merge it, or close it.

🎉 That's it. Gamma works.

---

## Everyday use

### Option A — a task file
1. Copy `tasks/TEMPLATE.md` to `tasks/my-task.md` (**Add file → Create new file**), fill in the sections, commit.
2. **Actions → Gamma Agent Runner → Run workflow**, type `tasks/my-task.md`.

### Option B — assign a GitHub Issue
1. Create an issue; describe the task (the Architect structures it for you, using the template sections helps).
2. Assign it to yourself. Gamma starts automatically and comments on the issue with the PR link.
3. **Recommended:** set a repository variable `GAMMA_ASSIGNEE` = your GitHub username. Then only assignments to
   *you* trigger runs (otherwise any assignment does, which can burn credits).

### Option C — weekly schedule
1. In `.github/workflows/gamma.yml` remove the `#` characters in front of the `schedule:` block (3 lines).
2. Create a repository variable `GAMMA_SCHEDULED_TASK` = `tasks/your-recurring-task.md`.

### Delivery modes
| Mode | Result |
|---|---|
| `draft-pr` (default) | Branch `gamma/<title>-<run id>` + Draft Pull Request after approval |
| `issue` | Posts the briefing as a new issue (or a comment on the triggering issue). No branch or PR; the patch is in the run artifacts |
| `artifact-only` | Nothing is published. Download `gamma-meeting-brief`, `gamma-workspace`, `gamma-patch` from the run page |

### What you get in the workflow artifacts
- **gamma-meeting-brief** — `meeting-brief.md`, the document to read before you approve.
- **gamma-workspace** — every agent's notes (`00-task-input`, `01-scout-brief`, `02-task-spec`, `builder-log-*`, `04-qa-report-*`, `03-review`, `result.json`).
- **gamma-patch** — `gamma.patch`; apply locally with `git apply gamma.patch` if you ever want to.

---

## Security model (short version)

| Protection | How |
|---|---|
| Secret files unreachable | Tools hard-block `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.git/*` (and SSH keys, `.npmrc`, `.netrc`) — also through symlinks and `..` paths |
| Prompt-injection defense | All repo content given to agents is wrapped in `<untrusted_repo_data>` tags; `skills/gamma-rules.md` forbids obeying instructions found there |
| Protected paths | Agents cannot modify `.github/`, `runner/`, `skills/gamma-rules.md` |
| Output DLP | Modified files, agent notes and the final patch are scanned for `sk-ant-…`, `ghp_…`, `AKIA…`, private keys, JWTs and high-entropy secrets. **Any hit aborts the run; nothing is committed** |
| Safe commands | QA runs only allowlisted test runners, with no shell and **without** your API key or git token in the environment |
| Token & step caps | Hard step limit per agent loop, truncated file reads, per-call output caps, and a whole-run token budget (default 2,000,000) |
| Least privilege | Stage 1 has a read-only token and does not persist git credentials; only Stage 2 can write |
| Human in the loop | Draft PRs only; nothing merges automatically |

---

## Settings you can change (repository *Variables*)

Settings → Secrets and variables → Actions → **Variables**:

| Variable | Purpose |
|---|---|
| `GAMMA_ASSIGNEE` | Only run for issues assigned to this username |
| `GAMMA_SCHEDULED_TASK` | Task file used by the schedule trigger |
| `GAMMA_DELIVERY_MODE` | Default delivery mode for non-manual runs |
| `GAMMA_TAG_OWNERS` | `true` = @-mention task owners and request their review |
| `GAMMA_HAIKU_MODEL` | Override the Haiku model id (default `claude-haiku-4-5-20251001`) |
| `GAMMA_SONNET_MODEL` | Override the Sonnet model id (default `claude-sonnet-4-6`) |
| `GAMMA_MAX_TOTAL_TOKENS` | Whole-run token cap (default `2000000`) |

---

## Free-trial / Tier 1 notes

- Gamma retries automatically on `429` rate-limit errors, honoring the `retry-after` header and backing off
  exponentially (up to 8 retries). On a low tier a run can simply take longer — watch for lines like
  `retry 2/8 in 12s` in the log. That is normal.
- Keep tasks small and specific for the cheapest, fastest runs. The sample task is intentionally tiny.
- If a run ends with a rate-limit error after all retries, wait a few minutes and use **Re-run all jobs**.

---

## Using an existing repo

- Upload the same files into your repo. If you already have a `package.json`, do **not** overwrite it: just add
  `"@anthropic-ai/sdk": "0.39.0"` under `dependencies` (the runner files use `.mjs`, so `"type": "module"` is not required).
  The workflow runs `npm install` before Gamma.
- Gamma uses the folders `.gamma-workspace/` and `artifacts/` as scratch space and never includes them in a PR.
  If your repo already uses a top-level `artifacts/` folder, rename that folder first.
- Task files must live inside the repository and end in `.md`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Run fails immediately: "Missing secret" | Step 3 — secret name must be exactly `ANTHROPIC_API_KEY` |
| `401` from Anthropic | The key is wrong or revoked; create a new one and update the secret |
| `404 … model not found` | Set the `GAMMA_HAIKU_MODEL` / `GAMMA_SONNET_MODEL` variables to model IDs available to your account |
| "credit balance is too low" | Add credits in the Anthropic console |
| Workflow does not appear in Actions | `.github/workflows/gamma.yml` was not uploaded — see the hidden-folder tip in Step 2 |
| Assigning an issue does nothing | Workflow must exist on the default branch; if you set `GAMMA_ASSIGNEE`, it must equal the assignee's username |
| "Could not open the pull request" | Step 4: enable *Allow GitHub Actions to create and approve pull requests*. The branch was already pushed — open the compare link printed in the log |
| Run status "halted" | QA still failed after 2 self-healing rounds. Read `gamma-workspace` → `04-qa-report-*.md`, tighten the task's requirements and completion criteria, and re-run |
| Run status "aborted-dlp" | The secret scanner found something that looks like a credential. Nothing was committed. Remove secrets from the task/inputs and re-run |
| Stage 2 skipped | Stage 1 did not finish successfully, or `delivery_mode` was `artifact-only` |
| `git apply` conflict in Stage 2 | Very rare; the patch is built against the exact commit Stage 1 used. Re-run, or apply `gamma.patch` manually |

---

## Writing good tasks

- **Goal**: one paragraph, outcome-focused.
- **Requirements and boundaries**: numbered and testable; include explicit *Do NOT* lines.
- **Completion criteria**: checkboxes a stranger could verify by reading the files.
- **Tests**: only commands that already exist in your repo (for example `npm test`). With no tests, write
  *No automated tests configured; verify by inspection.* Gherkin `.feature` files can be referenced; the QA agent checks them.
- Small tasks (a few files) work best. Split large projects into several tasks.

Happy shipping! 🚀
