// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://jegork.github.io",
  base: "/rusty-bot",
  integrations: [
    starlight({
      title: "Rusty Bot",
      description:
        "AI-powered PR review with configurable styles, focus areas, OpenGrep SAST, and ticket compliance.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/jegork/rusty-bot",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/jegork/rusty-bot/edit/main/docs/",
      },
      lastUpdated: true,
      pagination: true,
      sidebar: [
        { label: "Getting started", slug: "getting-started" },
        {
          label: "Providers",
          items: [
            { label: "GitHub Action", slug: "providers/github-action" },
            { label: "Azure DevOps", slug: "providers/azure-devops" },
          ],
        },
        {
          label: "Guides",
          autogenerate: { directory: "guides" },
        },
        {
          label: "Reference",
          autogenerate: { directory: "reference" },
        },
      ],
    }),
  ],
});
