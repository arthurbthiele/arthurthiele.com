# arthurthiele.com

Personal site. Astro, static, deployed to GitHub Pages on push to `main`.

```
yarn install
yarn dev      # local preview
yarn build    # output to dist/
```

Posts are markdown files in `src/content/writing/`. Frontmatter is validated at build time,
so a malformed post fails the build rather than publishing broken.
