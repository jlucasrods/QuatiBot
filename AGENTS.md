# QuatiBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

## Before every commit

Run `pnpm ci:local` from the repository root before committing. It forces a fresh
TypeScript check and runs four application-test shards in parallel, offline evals, packaged smoke
and real UI/browser checks in disposable environments. Linux, Node.js 24+, pnpm,
Chrome and `xvfb-run` are required. Browser fixtures may download their pinned tools.
Do not substitute an incremental typecheck or silently skip unavailable checks.
Report failures or missing dependencies explicitly; never claim the run passed
when it did not. No Docker, publication or paid model inference is part of this command.

## Comments

Write a comment only for what the code cannot say:

- a license or attribution notice;
- a fact forced by something outside this code (a vendor, CLI, OS, browser,
  Electron or protocol behaviour), with its version when it has one;
- the doc comment of a public contract: the wire types in `shared/`, the
  driver interface, the preload bridge, `config.json` fields people edit;
- a link to an upstream issue;
- a security invariant or a known open risk.

Do not narrate what the next line does, restate a name, record history ("used
to", "no longer", PR or issue numbers, plan or slice names: git has it), point
at other files, draw banners or leave commented-out code. When our own code
needs a paragraph to explain a surprise, change the code instead: a better
name, a type, an extracted function, one shared helper. A rule ("never X",
"must match Y") belongs in a type, a test or a lint rule. Never suppress a lint
rule that guards correctness; fix the code.

More specific `AGENTS.md` files override this note within their directories.
