## 2026-11-05 — PressPlay cannot run Spirality's loop yet: add its settings, verify check, ticket door, loop skills and lanes (#4)

This pull request gives PressPlay the same working loop Spirality uses: a
settings file, a ticket door to the tracker, the build, review and intake
skills, the scheduled lanes, and a `verify` check that every pull request
must pass before it can merge.

Review sent the first version back for two things, both fixed here:

- **The lanes would have stayed stuck on this branch after it merged.** Each
  lane works in its own folder under `.claude/worktrees/`. Git counted those
  folders as "unsaved changes" in the main checkout, and the lanes only switch
  back to `main` when the checkout looks clean. Now `.gitignore` tells git to
  skip that folder, so after the merge the lanes return to `main` and pick up
  new work.
- **The skills, the docs and CI named the "done" check differently.** There is
  now one command, `npm run verify`, which builds the site and then runs the
  loop's own tests. CI runs exactly that, and every skill and doc points to it.
