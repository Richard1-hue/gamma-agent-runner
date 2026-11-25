# Task: Welcome audit — review README.md and create a project overview

## Goal
Give a new teammate a fast, accurate orientation to this repository. Audit `README.md` for clarity and
completeness, then create a single project overview document that explains what the project is, how it is laid out,
and how to use it. This is a small, low-cost first task to confirm that Gamma works end to end.

## Inputs
- `README.md` (the document to audit)
- The repository file tree (use it to describe the real structure)
- `package.json` and any files in `tasks/`, `runner/` and `skills/` that are needed to describe the project accurately

## Variables and secrets
None. Do not read, mention or reproduce any secret values.

## Requirements and boundaries
1. Create `docs/PROJECT_OVERVIEW.md`, written in plain English for a newcomer.
2. The overview must contain these sections, in this order:
   - **What this project is** (2-4 sentences)
   - **Repository map** (every top-level folder and notable top-level file with a one-line purpose)
   - **How to run it** (only steps that are actually documented or visible in the repository)
   - **README audit** (a short list of what the README does well, and up to 5 concrete suggested improvements,
     each naming the README section it applies to)
3. Only describe things that exist in the repository. If something is unclear, say so instead of guessing.
4. Do NOT modify `README.md` or any other existing file — suggestions go inside the overview only.
5. Do NOT add dependencies and do NOT touch anything under `.github/`, `runner/` or `skills/`.

## Result and delivery
One new Markdown file: `docs/PROJECT_OVERVIEW.md`. Delivery follows the delivery mode chosen when the workflow was started.

## Completion criteria
- [ ] `docs/PROJECT_OVERVIEW.md` exists and contains the four required sections in the required order
- [ ] The repository map mentions every top-level folder that exists in the repository
- [ ] The README audit contains at least two strengths and between one and five improvement suggestions
- [ ] No file other than `docs/PROJECT_OVERVIEW.md` was created or modified
- [ ] The document contains no secrets and no invented features

## Tests
No automated tests configured; verify by inspection.

## Dependencies
None.

## Task owner
Not specified
