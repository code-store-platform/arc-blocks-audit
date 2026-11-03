#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { componentScope, findImports, findSourceCalls, readProject, readStock } from './inventory.js';
import { printHeader, printNote, printSection, printSummary, TONE } from './format.js';
import { LEVEL, readUsage } from './usage.js';

// Tokens and phrases every Arc Themes bundle needs: nothing in PageBuilder points to them, but they must stay.
const ARC_THEMES_BASE = new Set(['@wpmedia/alias-tokens', '@wpmedia/global-tokens', '@wpmedia/breakpoint-tokens', '@wpmedia/global-phrases-block']);

// Older PageBuilder data misses recent work, so new blocks look unused.
const STALE_DAYS = 14;

const HELP = `Usage: arc-blocks-audit [options]

Compares the theme's components, content sources and blocks.json packages with what
the local PageBuilder database (from \`fusion start\`) uses. Run from the theme root.

Options:
  --project <dir>     Theme root (default: current directory)
  --db <name>         PageBuilder database in Mongo (default: the only non-system database)
  --mongo <uri>       Mongo connection string (default: mongodb://localhost:27017)
  --container <name>  Container to copy stock blocks from (default: fusion-webpack)
  --wpmedia <dir>     Local folder with @wpmedia packages; Docker is not used
                      (default: copy from the container, else <project>/node_modules/@wpmedia)
  -h, --help          Show this help

Options take --name value or --name=value.`;

const parseArgs = (argv) => {
  const args = { project: process.cwd(), mongo: 'mongodb://localhost:27017', container: 'fusion-webpack' };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].replace(/^--?/, '').split('=');
    if (key === 'help' || key === 'h') {
      args.help = true;
      continue;
    }
    const value = inline ?? argv[++i];
    args[key] = value;
  }
  return args;
};

// Stock blocks are installed inside the Fusion webpack container, not in the theme repo.
// Without it the local node_modules is used, which rarely has them, so the report says so.
const resolveWpmediaDir = (args) => {
  if (args.wpmedia) return { dir: path.resolve(args.wpmedia) };
  const local = path.join(args.project, 'node_modules', '@wpmedia');
  const cache = path.join(os.tmpdir(), 'arc-blocks-audit', 'wpmedia');
  fs.rmSync(cache, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  try {
    execFileSync('docker', ['cp', `${args.container}:/opt/engine/bundle/node_modules/@wpmedia`, cache], { stdio: 'pipe' });
    return { dir: cache };
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    let reason = `docker cp from "${args.container}" failed: ${stderr.trim().split('\n')[0] || error.message}`;
    if (error.code === 'ENOENT') reason = 'docker CLI not found';
    else if (/no such container/i.test(stderr)) reason = `container "${args.container}" not found`;
    else if (/cannot connect to the docker daemon/i.test(stderr)) reason = 'Docker is not running';
    return {
      dir: local,
      warning: `stock blocks not loaded (${reason}), results for @wpmedia are unreliable; start fusion or pass --wpmedia`,
    };
  }
};

const levelsOf = (usage, id) => usage.items.get(id)?.levels ?? new Set();
const isLive = (usage, id) => levelsOf(usage, id).has(LEVEL.LIVE);
const isUsed = (usage, id) => levelsOf(usage, id).size > 0;

const rel = (project, file) => path.relative(project, file);

const whereOf = (entry) => [...entry.where].slice(0, 2).join('; ');

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const projectDir = path.resolve(args.project);
  if (!fs.existsSync(path.join(projectDir, 'blocks.json'))) {
    throw new Error(`not an Arc theme root: blocks.json not found in ${projectDir}, run from the theme root or pass --project`);
  }
  const project = readProject(projectDir);
  const { dir: wpmediaDir, warning: stockWarning } = resolveWpmediaDir(args);
  const stock = readStock(wpmediaDir, project.stockPackages, project.outputTypes);
  const usage = await readUsage({ uri: args.mongo, db: args.db });

  // Source names called from code. Stock packages count only when something from them is used,
  // otherwise an unused package would keep its own sources alive.
  const usedPackages = new Set();
  for (const [name, pkg] of stock) {
    const ids = [...pkg.features.keys(), ...pkg.chains.keys(), ...pkg.layouts.keys()];
    if (ids.some((id) => isUsed(usage.features, id) || isUsed(usage.chains, id) || isUsed(usage.layouts, id))) {
      usedPackages.add(name);
    }
  }
  const codeCalls = findSourceCalls(
    [...project.codeFiles, ...[...stock].filter(([name]) => usedPackages.has(name)).flatMap(([, pkg]) => pkg.codeFiles)],
    { sourceFiles: project.sources },
  );

  // Folders of theme components nothing uses: a source called only from there is dead too.
  const unusedComponentDirs = [
    ...[...project.features].filter(([id]) => !isUsed(usage.features, id)),
    ...[...project.chains].filter(([id]) => !isUsed(usage.chains, id)),
    ...[...project.layouts].filter(([id]) => !isUsed(usage.layouts, id)),
  ].map(([, file]) => file);
  const isInUnusedComponent = (file) => unusedComponentDirs.some((dir) => file === dir || file.startsWith(`${dir}${path.sep}`));

  const { counts, lastChange } = usage;
  const warnings = stockWarning ? [stockWarning] : [];
  let snapshot = 'last change unknown, no dates in pages, templates or renderings';
  if (lastChange) {
    const days = Math.floor((Date.now() - lastChange.getTime()) / 86400000);
    snapshot = `last change ${lastChange.toISOString().slice(0, 10)} (${days} days ago)`;
    if (days > STALE_DAYS) warnings.push(`snapshot is ${days} days old, blocks added after it show as unused; refresh PageBuilder data`);
  }
  printHeader([
    ['database', `${usage.dbName} (pages ${counts.page}, templates ${counts.template}, renderings ${counts.rendering}, resolvers ${counts.resolver}, stashed ${counts.stashed})`],
    ['snapshot', snapshot],
    ['stock blocks', wpmediaDir],
  ], warnings);

  // 1. Theme components. An unused one that other theme code imports is a shared component, not a block.
  const imports = findImports(project.codeFiles, projectDir);
  const isInside = (file, dir) => file === dir || file.startsWith(`${dir}${path.sep}`);
  const importersOf = (file) => {
    const scope = componentScope(file, project.outputTypes);
    const bare = path.extname(scope) ? scope.slice(0, -path.extname(scope).length) : scope;
    const from = imports.filter((imp) => !isInside(imp.from, scope) && (isInside(imp.to, scope) || imp.to === bare));
    return [...new Set(from.map((imp) => imp.from))];
  };
  const unusedNote = (file) => {
    const importers = importersOf(file);
    if (importers.length === 0) return { note: 'review: not added to pages yet, or not needed' };
    const more = importers.length > 1 ? `, +${importers.length - 1} more` : '';
    return {
      note: `imported from code: not placed as a block, consider moving to components/ <- ${rel(projectDir, importers[0])}${more}`,
      noteTone: TONE.info,
    };
  };
  const unusedComponents = [];
  const draftOnlyComponents = [];
  for (const [kind, map, ids] of [
    ['feature', usage.features, project.features],
    ['chain', usage.chains, project.chains],
    ['layout', usage.layouts, project.layouts],
  ]) {
    for (const [id, file] of ids) {
      if (!isUsed(map, id)) unusedComponents.push({ kind, id, detail: rel(args.project, file), ...unusedNote(file) });
      else if (!isLive(map, id)) {
        draftOnlyComponents.push({ kind, id, levels: [...levelsOf(map, id)], detail: whereOf(map.items.get(id)) });
      }
    }
  }
  printSection('Theme components not used on any page or template', TONE.remove, unusedComponents);
  printSection('Theme components used only in drafts, stage or stashed items', TONE.review, draftOnlyComponents);

  // 2. Stock packages from blocks.json.
  const unusedPackages = [];
  for (const [name, pkg] of stock) {
    if (ARC_THEMES_BASE.has(name)) continue;
    if (pkg.missing) {
      unusedPackages.push({ id: name, detail: 'not installed, cannot check' });
      continue;
    }
    const hasCode = pkg.features.size + pkg.chains.size + pkg.layouts.size + pkg.sources.size > 0;
    const sourceUsed = [...pkg.sources.keys()].some((id) => isUsed(usage.sources, id) || codeCalls.has(id));
    if (!usedPackages.has(name) && !sourceUsed) {
      const note = hasCode
        ? `${pkg.features.size + pkg.chains.size + pkg.layouts.size} components, ${pkg.sources.size} sources`
        : 'no components or sources: tokens, phrases or a shared library, check by hand';
      unusedPackages.push({ id: name, detail: note });
    }
  }
  printSection('blocks.json packages with nothing used', TONE.remove, unusedPackages);
  const basePackages = project.stockPackages.filter((name) => ARC_THEMES_BASE.has(name));
  if (basePackages.length) printNote(`Arc Themes base packages (required by the theme, keep): ${basePackages.join(', ')}`);

  // 3. Content sources.
  const allSources = new Map([...project.sources].map(([id, file]) => [id, rel(args.project, file)]));
  for (const [name, pkg] of stock) for (const id of pkg.sources.keys()) if (!allSources.has(id)) allSources.set(id, name);
  const unusedSources = [];
  const deadCallerSources = [];
  const codeOnlySources = [];
  const describe = (f) => (f.startsWith(wpmediaDir) ? `@wpmedia/${path.relative(wpmediaDir, f)}` : rel(args.project, f));
  for (const [id, origin] of allSources) {
    if (isUsed(usage.sources, id)) continue;
    const calls = [...new Set(codeCalls.get(id) ?? [])];
    const more = calls.length > 2 ? `, +${calls.length - 2} more` : '';
    const callers = `${origin} <- ${calls.slice(0, 2).map(describe).join(', ')}${more}`;
    if (calls.length === 0) unusedSources.push({ id, detail: origin });
    else if (calls.every(isInUnusedComponent)) deadCallerSources.push({ id, detail: callers });
    else codeOnlySources.push({ id, detail: callers });
  }
  printSection('Content sources not used anywhere', TONE.remove, unusedSources);
  printSection('Content sources called only from unused theme components', TONE.remove, deadCallerSources);
  printSection('Content sources used only from code (keep, not set in PageBuilder)', TONE.info, codeOnlySources);

  // 4. Referenced in PageBuilder but not found in code.
  const known = new Set([
    ...project.features.keys(), ...project.chains.keys(), ...project.layouts.keys(),
    ...[...stock.values()].flatMap((pkg) => [...pkg.features.keys(), ...pkg.chains.keys(), ...pkg.layouts.keys()]),
  ]);
  const missing = [];
  for (const [kind, map] of [['feature', usage.features], ['chain', usage.chains], ['layout', usage.layouts]]) {
    for (const [id, entry] of map.items) {
      if (!known.has(id)) missing.push({ kind, id, levels: [...entry.levels], detail: whereOf(entry) });
    }
  }
  for (const [id, entry] of usage.sources.items) {
    if (!allSources.has(id)) missing.push({ kind: 'source', id, levels: [...entry.levels], detail: whereOf(entry) });
  }
  printSection('Referenced in PageBuilder but not found in code', TONE.error, missing);

  printSummary([
    { label: 'referenced in PageBuilder but missing in code', count: missing.length, tone: TONE.error },
    { label: 'of them on live pages or templates', count: missing.filter((row) => row.levels.includes(LEVEL.LIVE)).length, tone: TONE.error },
    { label: 'unused theme components', count: unusedComponents.length, tone: TONE.remove },
    { label: 'unused blocks.json packages', count: unusedPackages.length, tone: TONE.remove },
    { label: 'unused content sources', count: unusedSources.length + deadCallerSources.length, tone: TONE.remove },
    { label: 'components used only in drafts', count: draftOnlyComponents.length, tone: TONE.review },
  ]);
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
