#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSourceCalls, readProject, readStock } from './inventory.js';
import { printHeader, printSection, printSummary, TONE } from './format.js';
import { LEVEL, readUsage } from './usage.js';

const parseArgs = (argv) => {
  const args = { project: process.cwd(), mongo: 'mongodb://localhost:27017', container: 'fusion-webpack' };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].replace(/^--/, '').split('=');
    const value = inline ?? argv[++i];
    args[key] = value;
  }
  return args;
};

// Stock blocks are installed inside the Fusion webpack container, not in the theme repo.
const resolveWpmediaDir = (args) => {
  if (args.wpmedia) return path.resolve(args.wpmedia);
  const local = path.join(args.project, 'node_modules', '@wpmedia');
  const cache = path.join(os.tmpdir(), 'arc-blocks-audit', 'wpmedia');
  fs.rmSync(cache, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  try {
    execFileSync('docker', ['cp', `${args.container}:/opt/engine/bundle/node_modules/@wpmedia`, cache], { stdio: 'ignore' });
    return cache;
  } catch {
    return local;
  }
};

const levelsOf = (usage, id) => usage.items.get(id)?.levels ?? new Set();
const isLive = (usage, id) => levelsOf(usage, id).has(LEVEL.LIVE);
const isUsed = (usage, id) => levelsOf(usage, id).size > 0;

const rel = (project, file) => path.relative(project, file);

const whereOf = (entry) => [...entry.where].slice(0, 2).join('; ');

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const project = readProject(path.resolve(args.project));
  const wpmediaDir = resolveWpmediaDir(args);
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

  const { counts } = usage;
  printHeader([
    ['database', `${usage.dbName} (pages ${counts.page}, templates ${counts.template}, renderings ${counts.rendering}, resolvers ${counts.resolver}, stashed ${counts.stashed})`],
    ['stock blocks', wpmediaDir],
  ]);

  // 1. Theme components.
  const unusedComponents = [];
  const draftOnlyComponents = [];
  for (const [kind, map, ids] of [
    ['feature', usage.features, project.features],
    ['chain', usage.chains, project.chains],
    ['layout', usage.layouts, project.layouts],
  ]) {
    for (const [id, file] of ids) {
      if (!isUsed(map, id)) unusedComponents.push({ kind, id, detail: rel(args.project, file) });
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
