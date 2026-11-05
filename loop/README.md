# loop/

The ticket door for PressPlay: the commands a session uses to read and move
PressPlay's tickets (`npm run clickup -- <command>`) and to check its keys and
repository (`npm run doctor`).

Every file here except this README is copied byte for byte from
[Spirality](https://github.com/mentor24-maker/spirality) at commit
`521bb9a`, keeping Spirality's layout (`scripts/` beside `lib/`) so no import
changes. The project settings it reads are PressPlay's own
`spirality.project.json` at the repository root.

Do not edit these files here. A change is made in Spirality first, then
copied in by Spirality's setup wizard (`npm run onboard:copy`) from a newer
commit. `npm run test:loop` runs the copied tests.

## The runner scripts

The loop jobs on the Mini are run by files copied from the same Spirality
commit. They live in the repository's own `scripts/`, not here, because each
one finds the product's folder from where it sits. All are byte for byte
except `scripts/project_config.mjs`, which imports
`../loop/lib/projectConfig.mjs` instead of `../lib/projectConfig.mjs`.

The pull request that brought them in lists every file and how it was checked.
