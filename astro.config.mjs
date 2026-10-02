import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://arthurthiele.com",
  // GitHub Pages caches HTML for 10 minutes and each deploy deletes the previous hashed assets, so a cached page
  // linking last deploy's stylesheet renders unstyled. Inlined CSS can't go missing.
  build: { inlineStylesheets: "always" },
  markdown: {
    shikiConfig: {
      themes: { light: "github-light", dark: "github-dark" }
    }
  }
});
