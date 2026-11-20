# Stack routing

`i18next-cli instrument` parses `.js`, `.jsx`, `.ts`, `.tsx` out of the box.
Other file types (`.vue`, `.svelte`, `.pug`, …) need a plugin in the `plugins`
array of `i18next.config.ts`. Specifying extra extensions in `extract.input` is
**not** enough on its own.

## Plugins

| Stack | Package | Notes |
|---|---|---|
| Vue | [`i18next-cli-vue`](https://github.com/PBK-B/i18next-cli-vue) | Parses `.vue` SFCs. **Community-maintained** |
| Svelte | [`i18next-cli-plugin-svelte`](https://github.com/dreamscached/i18next-cli-plugin-svelte) | Parses `.svelte`. **Community-maintained** |
| Astro | [`i18next-cli-plugin-astro`](https://github.com/i18next/i18next-cli-plugin-astro) | Reads `.astro` for `extract`, `status` and `lint`; does not instrument. **Official** |
| Anything else | write one | Plugin hooks: `instrumentOnLoad` / `onLoad` |

The Vue and Svelte plugins are maintained outside the i18next org, so check they
still support the user's framework version before relying on them.

Add to `i18next.config.ts`:

```ts
import vue from 'i18next-cli-vue'

export default defineConfig({
  plugins: [vue()],
  // …
})
```

**Without a matching plugin**, `localize` does not fail: it skips the instrument
step with guidance and still runs extract → Locize → auto-translate. So the user
gets a working translation pipeline over whatever keys already exist; only the
automatic wrapping of hardcoded strings is unavailable. Say so rather than
wrapping those files by hand.

## Current setup guides

Verified against the framework versions named. Prefer these over improvising.

| Stack | Approach | Guide |
|---|---|---|
| Next.js App Router | `next-i18next` v16 (`getT()` / `useT()`, middleware locale detection) | [next-i18next-v16](https://www.locize.com/blog/next-i18next-v16) |
| Next.js App Router (manual) | i18next without passing `locale`/`t` around | [i18n-next-app-router](https://www.locize.com/blog/i18n-next-app-router) |
| React Router v7 (framework mode) | `remix-i18next` 7.x, SSR-friendly detection | [react-router-i18next](https://www.locize.com/blog/react-router-i18next) |
| Nuxt 4 | `@nuxtjs/i18n` + vue-i18n, build-time sync via `locize-cli` | [nuxt-i18n](https://www.locize.com/blog/nuxt-i18n) |
| Astro 7 | Built-in i18n routing + plain `i18next` at build time (no JavaScript in the browser) | [astro-i18n](https://www.locize.com/blog/astro-i18n) |
| React (SPA) | `react-i18next` | [react-i18next](https://www.locize.com/blog/react-i18next) |
| Vue (i18next path) | `i18next-vue` | [i18next-vue](https://www.locize.com/blog/i18next-vue) |
| Remix | `remix-i18next` | [remix-i18next](https://www.locize.com/blog/remix-i18next) |
| Side-by-side overview | React / Next / Vue / Angular / Svelte | [javascript-localization](https://www.locize.com/javascript-localization) |

## Guides that are known stale

Tell the user before following these; the concepts hold but the setup does not.

| Stack | Guide | Why |
|---|---|---|
| Svelte | [svelte-i18n](https://www.locize.com/blog/svelte-i18n) | Svelte 3/4 legacy mount API, and covers `svelte-i18n` rather than i18next. For SvelteKit / Svelte 5 use `i18next-cli-plugin-svelte` and wire i18next directly. |
| Angular | [angular-i18next](https://www.locize.com/blog/angular-i18next) | Written for the NgModule era (v12). Check the [angular-i18next repo](https://github.com/i18next/angular-i18next) for current examples. |

## Where Nuxt and Astro differ

- **Nuxt:** the guide uses the framework's own i18n layer (`@nuxtjs/i18n` with
  vue-i18n) rather than i18next calls, so `i18next-cli instrument` is not the
  tool. Follow the guide instead.
- **Astro:** use plain i18next, no integration package. Astro's built-in
  routing gives the URLs (`/en/`, `/de/`); one i18next instance holds the
  locale JSON, and each page gets its `t()` from `getFixedT(lang, ns)`. A
  static build runs i18next only at build time, so no JavaScript goes to the
  browser. Set `interpolation: { escapeValue: false }` (Astro escapes what
  `{t(...)}` renders) and write the hreflang links in the layout (Astro's
  routing does not add them). `i18next-cli` reads no `.astro` files on its own:
  install `i18next-cli-plugin-astro` (dev dependency), add `astro()` to
  `plugins` and `astro` to `extract.input` (`src/**/*.{astro,ts}`). Without it,
  `status` sees no keys in the pages and reports 100%. With it, make the build
  script `i18next-cli status && astro build`, so a missing translation fails
  the build. The plugin does not instrument, so `localize` skips that step for
  `.astro` files (see "Without a matching plugin" above). When the developer
  chose Locize, `locize-cli download` fills the locale folder before each build.
