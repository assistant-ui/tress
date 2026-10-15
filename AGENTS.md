# Working on Tress

## Product direction

The next milestone is terminal access to an existing assistant-ui application
with a server-owned Harness thread. Reuse the application's agent, tools,
identity, and conversation. See [the roadmap](docs/roadmap.md) for scope,
acceptance checks, and deferred work.

Keep current Tress clients and hosted sessions working during the integration.
Proposed commands and capabilities must be labeled as proposals until shipped.

## Git workflow

- Inspect branch, working-tree, and staged changes before editing. Preserve
  unrelated work, including changes made by other agents.
- Start each independent change from an up-to-date upstream base on a focused
  branch. Use conventional prefixes such as `feat/`, `fix/`, `chore/`, `docs/`,
  or `release/`. Do not commit directly to `main`. Keep commit messages, PR
  titles/descriptions, and labels free of agent branding.
- Prefer an isolated worktree when the existing checkout has unrelated work.
  In Codex, use its managed worktree tools when available. If isolation is
  unavailable, keep unrelated files and hunks out of the commit explicitly.
- Stage specific paths or hunks, inspect the staged diff, and make cohesive
  commits. Do not use blanket staging in a dirty checkout.
- Do not reset, discard, stash, or rewrite another task's changes. Avoid force
  pushes; rewrite a published branch only when explicitly authorized.
- Fetch before opening a PR and verify its base and complete diff. Push the
  topic branch with an explicit upstream; use a draft PR while scope or
  validation remains incomplete.
- Keep each PR focused on one reviewable outcome. Its description should state
  the problem, resulting behavior, checks performed, and material limitations.
  Clearly distinguish tests that passed from checks that were not run.
- Inspect CI and actionable review feedback before considering a change ready.
  Do not merge, publish a release, or deploy production without authorization.

## Verification

Run checks appropriate to the changed surface. For native Rust changes, use
`cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`, and
`cargo test`. CLI setup changes also need `python3 scripts/test-setup-pty.py`.
For site/workspace changes, use the relevant scripts in their `package.json`
files, including type checking and host integration tests when affected.

For documentation-only changes, inspect the diff, check local links, and run
`git diff --check`; application test suites are unnecessary. Never claim an
unfinished or untested scaffold works.
