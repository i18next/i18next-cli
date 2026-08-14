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
| Anything else | write one | Plugin hooks: `instrumentOnLoad` / `onLoad` |

Both plugins are maintained outside the i18next org, so check they still support
the user's framework version before relying on them.

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
| Astro 6 | Built-in i18n routing + Locize, build-time JSON sync | [astro-i18n](https://www.locize.com/blog/astro-i18n) |
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

Both guides use the framework's own i18n layer (`@nuxtjs/i18n` / Astro routing)
rather than instrumenting i18next calls, and sync locale JSON with `locize-cli`
at build time. So for those two stacks `i18next-cli instrument` is not the tool.
Follow the guide instead, and use Locize purely as the translation backend.
