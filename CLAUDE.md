See README.md for commands, layout and data scripts.

- Deploy with `yarn ship`, and only when Arthur asks; it pushes to `main`, which publishes immediately.
- Arthur keeps uncommitted notes in some posts under `src/content/writing/`. Never stage or commit changes there
  unless he asks; stage paths explicitly rather than `git add -A`.
- Check UI changes in a real browser (the dev server, or headless Playwright with `channel="chrome"`), including
  around 390px wide.
- Yarn 1 has a built-in `yarn check`, which is why the typecheck script is `typecheck`. `astro check` fails to load
  under Yarn 1 (missing `@emnapi/runtime`), so typechecking is plain `tsc`.
