# arc-blocks-audit

Finds dead code in an Arc XP Fusion theme. It compares the theme's components, content sources and `blocks.json` packages with what the local PageBuilder database actually uses, and also lists what PageBuilder references but the code no longer has.

## Requirements

- Node.js 18+.
- The project's local `fusion start` is running:
  - `fusion-data` container with Mongo on `localhost:27017` (PageBuilder data: pages, templates, resolvers, stashed items);
  - `fusion-webpack` container (stock `@wpmedia` blocks are copied from it).
- `docker` CLI on the PATH.
- SSH access to the `code-store-platform` GitHub organization. The repo is private, check with `ssh -T git@github.com`.

## Run

Nothing is added to the project: npx installs the tool into its own cache (`~/.npm/_npx`) and runs it from there.

From the theme root (the folder with `blocks.json` and `components/`):

```sh
npx -y git+ssh://git@github.com/code-store-platform/arc-blocks-audit.git
```

From anywhere else, point it at the theme:

```sh
npx -y git+ssh://git@github.com/code-store-platform/arc-blocks-audit.git --project ~/path/to/theme
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
npx -y git+ssh://git@github.com/code-store-platform/arc-blocks-audit.git#main
npx -y git+ssh://git@github.com/code-store-platform/arc-blocks-audit.git#<commit-or-tag>
```

If an old version still runs (older npm, broken install), clear the npx cache and run again:

```sh
rm -rf ~/.npm/_npx
```

`npm cache clean --force` does not touch `~/.npm/_npx`.

## Report

The header shows:

- the database used, with counts of pages, templates, renderings, resolvers and stashed items;
- `snapshot: last change YYYY-MM-DD (N days ago)` - the latest change in the PageBuilder data (taken from rendering timestamps). If it is older than 14 days, a yellow warning says so;
- where stock blocks were read from. If they could not be copied from the container (no Docker, Docker not running, container not found) and `--wpmedia` is not set, a yellow warning says `stock blocks not loaded`.

Then:

- **Theme components not used on any page or template** - features, chains and layouts from `components/` that nothing references. Each row has a note:
  - `imported from code: not placed as a block, consider moving to components/` - other theme code imports it (by relative path, `~/` or a tsconfig/jsconfig `paths` alias; imports from inside the block itself do not count);
  - `review: not added to pages yet, or not needed` - nothing imports it.
- **Theme components used only in drafts, stage or stashed items** - not on any published page or template. Review before removing.
- **blocks.json packages with nothing used** - `@wpmedia` packages none of whose components or sources are used. Packages without components or sources (tokens, phrases, shared libraries) and packages that are not installed are listed with a note to check by hand. The Arc Themes base packages (`@wpmedia/alias-tokens`, `@wpmedia/global-tokens`, `@wpmedia/breakpoint-tokens`, `@wpmedia/global-phrases-block`) are never listed here, they get one line after the section: `Arc Themes base packages (required by the theme, keep)`.
- **Content sources not used anywhere** - not set in PageBuilder, not used by a resolver, not called from code.
- **Content sources called only from unused theme components** - their only callers are in components from the first section.
- **Content sources used only from code** - called from code but not set in PageBuilder. Keep them, informational only.
- **Referenced in PageBuilder but not found in code** - features, chains, layouts and sources that pages, templates, resolvers or stashed items point to, but the theme and stock packages do not have. Each row shows where it is used and at what level (`live`, `draft`, `stashed`).
- **Summary** - counts per section, including how many missing references are on live pages or templates.

## How to read the report

Start with the header. Two things make the whole report wrong:

- **An old snapshot.** The audit sees only what was in PageBuilder when the local data was exported. Blocks added to pages after that show as unused. If the snapshot is older than your recent work (or the header warns it is over 14 days old), refresh the PageBuilder data before deleting anything.
- **Stock blocks not loaded.** Without them every `@wpmedia` package looks unused and every stock block on a page looks missing. Start the project's `fusion start` or pass `--wpmedia`.

Then by section:

- **Referenced in PageBuilder but not found in code** - read this first, rows marked `[live]` matter most: a published page or template points to a block or source the bundle does not have, so that part of the page does not render. Restore the code or fix the page. `[draft]` and `[stashed]` rows can wait, they break only when someone publishes or uses them.
- **Theme components not used on any page or template** - candidates for removal, but check the note:
  - `imported from code` - the block is used as a component by other code, not placed on pages. Do not delete it. Consider moving it to `components/` outside `features/`, so it stops showing up in the PageBuilder block list;
  - `review` - nothing uses it. Either it was built for a page that is not set up yet (ask whoever owns the feature), or it can go.
- **Theme components used only in drafts, stage or stashed items** - someone may be about to publish them. Ask before removing.
- **blocks.json packages with nothing used** - remove the line from `blocks.json`, then check the site. Packages marked "check by hand" have no blocks or sources to match. Do not touch the Arc Themes base packages (tokens and phrases) - the theme needs them even though no page refers to them.
- **Content sources not used anywhere** and **called only from unused theme components** - safe to remove together with those components. Check dynamic source names first (see Limitations).
- **Content sources used only from code** - keep them, they are listed for information.

## Limitations

- Code is searched with regular expressions (`useContent({ source: ... })`, `contentService: ...`, `/content/fetch/...`, imports between sources). Dynamic names are missed. The report is a hint, not a delete list: remove things by hand and check the site after.
- Only one `fusion start` can run at a time, so the audit sees one project's data. Start the right project before running it.
- If Mongo has several PageBuilder databases, pass `--db`.
- Without Docker (or without the `fusion-webpack` container) stock packages are not read from the container. The tool falls back to `<project>/node_modules/@wpmedia`, which is usually empty, so stock packages show as not installed, and the header warns about it. Pass `--wpmedia` if you have them locally.
- Imports are found with regular expressions too (`import ... from`, `import()`, `require()`), resolved by relative path, `~/` and wildcard `paths` from `tsconfig.json` or `jsconfig.json`. Other webpack aliases are not read.
- The snapshot date comes from rendering timestamps in Mongo. If the data has none, the header says the date is unknown.
