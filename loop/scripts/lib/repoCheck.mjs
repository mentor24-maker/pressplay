/**
 * Does the tracker project's GitHub repository field (SP-80) agree with the
 * project config's `githubRepo`? The loops read `githubRepo`; the field is a
 * record a person fills on the project's Edit form, so the two can drift
 * apart unnoticed. `npm run doctor` asks this, through
 * `npm run clickup -- repo-check`, which reads the field with the loop's own
 * tracker sign-in. Read-only: nothing here writes the field.
 */

/**
 * `owner/name`, lower case (GitHub ignores case), from any form a GitHub
 * repository is written in: `owner/name`, its https:// address, or a git
 * remote (`git@github.com:owner/name.git`, `ssh://git@github.com/...`).
 * The one normaliser: `npm run doctor`'s repo-check and the setup look's
 * checkout row both use it, so the two cannot disagree on what is the same.
 */
export function normalRepo(value) {
  return String(value ?? '').trim()
    .replace(/^git@github\.com:/i, '').replace(/^(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\//i, '')
    .replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * Compare the two. `trackerRepo` is the field as the tracker gave it (null or
 * '' for none). `editUrl` is the project's Edit form, named in the advice.
 * Returns `{ verdict, ok, line }`: `same` and `empty` are ok (an empty field
 * is reported, never failed), `different` is not.
 */
export function compareRepo({ configRepo, trackerRepo, slug, editUrl }) {
  if (trackerRepo == null || String(trackerRepo).trim() === '') {
    return {
      verdict: 'empty',
      ok: true,
      line: `repository: the tracker project "${slug}" has no GitHub repository recorded; the loops use githubRepo ${configRepo}. Fill it in on ${editUrl}.`,
    };
  }
  if (normalRepo(trackerRepo) === normalRepo(configRepo)) {
    return { verdict: 'same', ok: true, line: `repository: the tracker project "${slug}" and githubRepo agree: ${configRepo}.` };
  }
  return {
    verdict: 'different',
    ok: false,
    line: `repository: DIFFERENT. The tracker project "${slug}" records ${trackerRepo}, but githubRepo in spirality.project.json is ${configRepo}, which is where the loops open pull requests. Correct whichever is wrong (the field on ${editUrl}).`,
  };
}

/**
 * The project's Edit form on the tracker page. `pageUrl` is the address a
 * person opens, the config FILE's trackerUrl (lib/substrateConfig.js
 * filedTrackerUrl), not the loops' 127.0.0.1 override.
 */
export function projectEditUrl(pageUrl, slug) {
  return `${String(pageUrl).replace(/\/+$/, '')}/projects/${encodeURIComponent(slug)}/edit`;
}
