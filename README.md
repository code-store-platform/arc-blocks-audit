# arc-blocks-audit

Finds dead code in an Arc XP Fusion theme. It compares the theme's components, content sources and `blocks.json` packages with what the local PageBuilder database actually uses, and also lists what PageBuilder references but the code no longer has.

## Requirements

- Node.js 18+.
- The project's local `fusion start` is running:
  - `fusion-data` container with Mongo on `localhost:27017` (PageBuilder data: pages, templates, resolvers, stashed items);
  - `fusion-webpack` container (stock `@wpmedia` blocks are copied from it).
- `docker` CLI on the PATH.

## Run

Nothing is added to the project: npx installs the tool into its own cache (`~/.npm/_npx`) and runs it from there.

From the theme root (the folder with `blocks.json` and `components/`):

```sh
npx -y github:code-store-platform/arc-blocks-audit
```

From anywhere else, point it at the theme:

```sh
npx -y github:code-store-platform/arc-blocks-audit --project ~/path/to/theme
```

`-y` skips the "Need to install the following packages" prompt. Everything after the repo URL goes to the tool.

### Options

| Option | Default | What it does |
|---|---|---|
| `--project <dir>` | current directory | Theme root. |
| `--db <name>` | the only non-system database | PageBuilder database in Mongo. Required when Mongo has more than one (the error lists them). |
| `--mongo <uri>` | `mongodb://localhost:27017` | Mongo connection string. |
| `--container <name>` | `fusion-webpack` | Container to copy stock blocks from (`/opt/engine/bundle/node_modules/@wpmedia`). |
| `--wpmedia <dir>` | copy from the container, else `<project>/node_modules/@wpmedia` | Local folder with `@wpmedia` packages. When set, Docker is not used. |
| `-h`, `--help` | | Show the options and exit. |

If the project folder has no `blocks.json`, the tool stops with `not an Arc theme root: blocks.json not found in <path>`. Run it from the theme root or pass `--project`.

Options take `--name value` or `--name=value`. Use the space form for values that contain `=` (for example a Mongo URI with query parameters).

Colours are off when output is piped or `NO_COLOR` is set, so `... > audit.txt` gives plain text. `FORCE_COLOR=1` turns them back on.

## Updating

With npm 9+ npx checks the repo on every run: it resolves the latest commit of the default branch (`main`) and reinstalls only if the commit changed. So a plain run already uses the current version.

To pin or pick a branch, tag or commit, add it after `#`:

```sh
npx -y github:code-store-platform/arc-blocks-audit#main
npx -y github:code-store-platform/arc-blocks-audit#<commit-or-tag>
```

If an old version still runs (older npm, broken install), clear the npx cache and run again:

```sh
rm -rf ~/.npm/_npx
```

`npm cache clean --force` does not touch `~/.npm/_npx`.

## Report

The header shows:

- `Hints, not errors. Red = nothing found anywhere, check by hand before removing.`;
- the database used, with counts of pages, templates, renderings, resolvers and stashed items;
- `snapshot: last change YYYY-MM-DD (N days ago)` - the latest change in the PageBuilder data (taken from rendering timestamps). If it is older than 14 days, a yellow warning says so;
- where stock blocks were read from. If they could not be copied from the container (no Docker, Docker not running, container not found) and `--wpmedia` is not set, a yellow warning says `stock blocks not loaded`.

Then the sections, in this order:

- **Referenced in PageBuilder but not found in code** - features, chains, layouts and sources that pages, templates, resolvers or stashed items point to, but the theme and stock packages do not have. Each row shows where it is used and at what level (`live`, `draft`, `stashed`), `[live]` rows first. The title is red: these are errors, not hints.
- **Theme components: not found on any page or template** - features, chains and layouts from `components/` that nothing in PageBuilder references.
- **Theme components: found only in drafts, stage or stashed items** - not on any published page or template.
- **blocks.json packages: no usage found** - `@wpmedia` packages none of whose components or sources are used or called. Two quiet lines follow the section:
  - `imported by theme code (keep): <package> (N files)` - the theme imports the package (`import`, `export ... from`, `require()`, `import()`, the package itself or a subpath such as `@wpmedia/<pkg>/utils/...`). Such a package is a library for the theme's hooks or utils even when none of its blocks is on a page, so it is not a row;
  - `Arc Themes base packages (required by the theme, keep)` - `@wpmedia/alias-tokens`, `@wpmedia/global-tokens`, `@wpmedia/breakpoint-tokens`, `@wpmedia/global-phrases-block`.
- **Content sources: no usage found** - not set in PageBuilder, not used by a resolver, not called from code.
- **Content sources: found only in unused theme components** - their only callers are in components from the components section.
- **Content sources: found only in code** - called from code but not set in PageBuilder.
- **Summary** - the count of missing references (and how many are on live pages or templates), then the count of rows per level.

Every row except the missing references starts with a level. The label is printed in plain text too, so a piped report (`NO_COLOR`, `> audit.txt`) reads the same:

| Level | Colour | Meaning |
|---|---|---|
| `candidate` | red | Nothing found anywhere: not in PageBuilder, not called or mentioned in code, not imported. |
| `check` | yellow | A trace found: the name is mentioned in code, the code is imported, it is used only in drafts, or it cannot be checked. |
| `info` | grey | For reference, keep: sources used only from code, packages imported by the theme, Arc Themes base packages. |

## How to read the report

Start with the header. Two things make the whole report wrong:

- **An old snapshot.** The audit sees only what was in PageBuilder when the local data was exported. Blocks added to pages after that show as unused. If the snapshot is older than your recent work (or the header warns it is over 14 days old), refresh the PageBuilder data before deleting anything.
- **Stock blocks not loaded.** Without them every `@wpmedia` package looks unused and every stock block on a page looks missing. Start the project's `fusion start` or pass `--wpmedia`.

Then:

1. **Referenced in PageBuilder but not found in code** - read this first, `[live]` rows matter most: a published page or template points to a block or source the bundle does not have, so that part of the page does not render. Restore the code or fix the page. `[draft]` and `[stashed]` rows can wait, they break only when someone publishes or uses them.
2. **Red, `candidate`** - nothing points to it. Still a hint, not a verdict: check by hand (search the name, ask whoever owns the feature), remove, then check the site. For a theme component the note says `not imported either: not added to pages yet, or not needed`. A package can go from `blocks.json` together with its blocks.
3. **Yellow, `check`** - something points to it, read the note:
   - `name mentioned in code: <file>, +N` (sources) - the source name is a string literal somewhere in the theme, for example `fetchSource('my-source')` in a wrapper. Likely a call with the name passed as a string or a variable. Open the file before removing anything;
   - `source "<name>" mentioned in code` (packages) - the same for a source of a stock package;
   - `imported from code: not placed as a block, consider moving to components/` (components) - other theme code imports it (by relative path, `~/` or a tsconfig/jsconfig `paths` alias; imports from inside the block itself do not count). Do not delete it. Consider moving it to `components/` outside `features/`, so it stops showing up in the PageBuilder block list;
   - drafts, stage or stashed items - someone may be about to publish it. Ask before removing;
   - sources called only from unused theme components - they go together with those components, if those go;
   - `not installed, cannot check` and `no components or sources and not imported: tokens or styles, check by hand` (packages) - nothing to match, look by hand.
4. **Grey, `info`** - keep, listed so the picture is complete.

## Limitations

- Code is searched with regular expressions (`useContent({ source: ... })`, `getContent({ sourceName: ... })`, `contentService: ...`, `/content/fetch/<name>`, imports between sources). A name passed as a variable or built at runtime is not a call the audit can see; a source whose name appears as a whole word in any string literal of the theme (outside its own file and outside import paths) is shown as `check` instead of `candidate`. A template string such as `` `/content/fetch/${name}` `` alone proves nothing, the name itself must be a literal somewhere. The reverse also happens: a name in quotes inside a comment counts as a mention. The report is a hint, not a delete list: remove things by hand and check the site after.
- Package imports are looked for in the theme's own code only, not inside other `@wpmedia` packages.
- Only one `fusion start` can run at a time, so the audit sees one project's data. Start the right project before running it.
- If Mongo has several PageBuilder databases, pass `--db`.
- Without Docker (or without the `fusion-webpack` container) stock packages are not read from the container. The tool falls back to `<project>/node_modules/@wpmedia`, which is usually empty, so stock packages show as not installed, and the header warns about it. Pass `--wpmedia` if you have them locally.
- Imports are found with regular expressions too (`import ... from`, `import()`, `require()`), resolved by relative path, `~/` and wildcard `paths` from `tsconfig.json` or `jsconfig.json`. Other webpack aliases are not read.
- The snapshot date comes from rendering timestamps in Mongo. If the data has none, the header says the date is unknown.

## License

MIT
