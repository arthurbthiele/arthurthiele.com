import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://arthurthiele.com",
  redirects: { "/writing": "/" },
  markdown: {
    shikiConfig: {
      themes: { light: "github-light", dark: "github-dark" }
    }
  }
});
