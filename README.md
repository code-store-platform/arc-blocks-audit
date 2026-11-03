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

The header shows the database used (with counts of pages, templates, renderings, resolvers and stashed items) and where stock blocks were read from. Then:

- **Theme components not used on any page or template** - features, chains and layouts from `components/` that nothing references.
- **Theme components used only in drafts, stage or stashed items** - not on any published page or template. Review before removing.
- **blocks.json packages with nothing used** - `@wpmedia` packages none of whose components or sources are used. Packages without components or sources (tokens, phrases, shared libraries) and packages that are not installed are listed with a note to check by hand.
- **Content sources not used anywhere** - not set in PageBuilder, not used by a resolver, not called from code.
- **Content sources called only from unused theme components** - their only callers are in components from the first section.
- **Content sources used only from code** - called from code but not set in PageBuilder. Keep them, informational only.
- **Referenced in PageBuilder but not found in code** - features, chains, layouts and sources that pages, templates, resolvers or stashed items point to, but the theme and stock packages do not have. Each row shows where it is used and at what level (`live`, `draft`, `stashed`).
- **Summary** - counts per section, including how many missing references are on live pages or templates.

## Limitations

- Code is searched with regular expressions (`useContent({ source: ... })`, `contentService: ...`, `/content/fetch/...`, imports between sources). Dynamic names are missed. The report is a hint, not a delete list: remove things by hand and check the site after.
- Only one `fusion start` can run at a time, so the audit sees one project's data. Start the right project before running it.
- If Mongo has several PageBuilder databases, pass `--db`.
- Without Docker (or without the `fusion-webpack` container) stock packages are not read from the container. The tool falls back to `<project>/node_modules/@wpmedia`, which is usually empty, so stock packages show as not installed. Pass `--wpmedia` if you have them locally.
