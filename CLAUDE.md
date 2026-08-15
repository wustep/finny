<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

Working on the sync engine, the Notion schema, or anything in `convex/`? Read
[.claude/skills/finny-sync/SKILL.md](.claude/skills/finny-sync/SKILL.md) first —
it lists the invariants that are easy to break silently.

## Writing UI copy

Length budget, because this app drifted past it once already:

- Helper text under a control: **one line** (~90 characters).
- A dialog description: **two sentences**.
- A destructive confirm: **three** — what happens, what does not, the one
  irreversible thing.

Anything past that belongs in a popover, on `/policy`, or in the README. If a
paragraph is explaining the system rather than the button in front of it, it
is in the wrong place. Two dialogs are allowed to be the wordiest things in
the app — Reset & resync, and Disconnect Notion — because both are
irreversible and land somewhere the app cannot reach.
