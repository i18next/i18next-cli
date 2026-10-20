# ICU MessageFormat and MF2 with i18next

The full guide is <https://www.i18next.com/how-to/using-icu-or-mf2>. Read it
before you switch an existing project's message format.

## Which format

| Format | Plugin | Choose it when |
|---|---|---|
| i18next JSON (`{{name}}`, `key_one`, `key_male`) | none | Default. Every i18next feature works and `extract` writes the plural keys. Keep it unless the developer asks otherwise. |
| ICU MessageFormat (`{name}`, `{count, plural, ...}`) | `i18next-icu` | Translations already exist in ICU (react-intl, FormatJS, a translation tool export), translators expect ICU, or plurals and selects should live inside one message, also nested. |
| Unicode MessageFormat 2 (`{$name}`, `.match`) | `i18next-mf2` | The developer explicitly wants the MF2 standard. Tool support is newer than ICU's. |

Only one `i18nFormat` plugin works per i18next instance; a second `.use()`
replaces the first.

## Setup

- ICU: `npm install i18next-icu intl-messageformat`. `intl-messageformat` is a
  peer dependency, so install it too. Then `i18next.use(ICU)`.
- MF2: `npm install i18next-mf2` (it brings `messageformat`). Then
  `i18next.use(MF2)`. If the invisible bidi marks around placeholders get in the
  way (titles, attributes, tests), set `i18nFormat: { bidiIsolation: 'none' }`.
- With `debug: true`, i18next-icu 2.6.0+ and i18next-mf2 2.1.0+ log a warning
  for each of the problems below.

## What silently stops working

The plugins replace i18next's message handling. None of these throws an error,
so rewrite them:

| i18next | ICU | MF2 |
|---|---|---|
| plural suffix keys `key_one`, `key_other` | `{count, plural, one {# item} other {# items}}` | `.input {$count :number} .match $count one {{{$count} item}} * {{{$count} items}}` |
| context keys `key_male` | `{context, select, male {...} other {...}}` | `.input {$context :string} .match $context male {{...}} * {{...}}` |
| `{{name}}` | `{name}` | `{$name}` |
| nesting `$t(other.key)` | `t('a', { b: t('b') })` | `t('a', { b: t('b') })` |
| formatters `{{value, number}}`, `formatter.add` | `{value, number}`, `{d, date, medium}`, the `formats` option | `:number`, `:integer`, the `mf2Functions` option |
| `interpolation.escapeValue` | i18next-icu `escapeVariables: true` | escape values before passing them |

React escapes on its own, so `escapeValue` only matters outside React. Also set
`saveMissingPlurals: false`. In ICU an apostrophe before `{` starts quoted text:
write `l''{place}` or the typographic `’`.

## Writing MF2 plurals

These three mistakes are the common ones:

- The catch-all key is `*`, never `other`. Without a `*` variant the message
  does not parse (Missing Fallback Variant).
- A pattern that starts with a placeholder opens with three braces and no
  space: `{{{$count} files}}`, never `{{ {$count} files}}`.
- A space inside `{{ }}` is text and shows in the app.

## Rich text in React

`Trans` with numbered tags (`<0>text</0>`) works with both plugins. For ICU,
react-i18next also has `IcuTrans`: `defaultTranslation` holds the ICU message
with numbered tags and `content` declares the elements, e.g.
`<IcuTrans i18nKey="invite" defaultTranslation="We invited <0>{user}</0>." content={[{ type: 'strong' }]} values={{ user }} />`.
See <https://react.i18next.com/latest/icu-trans-component>.

## TypeScript

The type-safe `t` reads `{{variable}}` from the translation values by default,
and ICU and MF2 plurals contain double braces, so these calls do not compile.
Set `parseInterpolation: 'icu'` (or `'mf2'`) in `CustomTypeOptions` (i18next
26.5.0+): `t()` options, and the `values` of `Trans` and `IcuTrans`, are then
checked against the message's arguments, so a missing or misspelled `{name}`, a
string for a `plural` count or leaving out the options is a type error. With
i18next 26.2.0 to 26.4.x set `parseInterpolation: false`: keys are checked, the
values are not (`lint` covers them). `npx i18next-cli types` writes the right
value for the installed i18next into a new `i18next.d.ts` when
`extract.messageFormat` is set; for an existing file it prints a warning and you
add the line. Typed arguments need literal message types, which the generated
resources file has.

## i18next-cli

Set this in `i18next.config.ts`:

```ts
extract: {
  // ...
  messageFormat: 'icu', // or 'mf2'
}
```

`extract` then writes one key per message (no `key_one`/`key_other` or
`key_male` keys), writes `Trans` children with `{name}` / `{$name}`, and reads
`IcuTrans` and the `icu.macro` components. `instrument` writes the placeholders
and plurals in the chosen syntax, and its i18n init file registers the plugin
(install the packages its header comment lists).

`npx i18next-cli lint` then parses every translation value of every locale and
reports syntax errors, argument names that differ from the primary language, and
plural categories that do not fit a locale (`ru` needs `one`, `few` and `many`;
`fr` may leave out `many`; `zero` in English is never used; `=1` covers English `one`).
For MF2 it warns when whitespace at the start or end of a pattern differs from
the primary language. Its `t()` check
reads the arguments with the same parser. Run it after `instrument`, after
`extract` and after every translation change, and fix what it reports.
