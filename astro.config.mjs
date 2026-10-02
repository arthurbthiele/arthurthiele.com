import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://arthurthiele.com",
  markdown: {
    shikiConfig: {
      themes: { light: "github-light", dark: "github-dark" }
    }
  }
});
