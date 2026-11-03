import fs from 'node:fs';
import path from 'node:path';

const CODE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
const isCodeFile = (name) => CODE_EXTENSIONS.includes(path.extname(name)) && !/\.(test|spec|types|d)\.[^.]+$/.test(name);
const stripExt = (name) => {
  const ext = path.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
};

const readDir = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const walkFiles = (dir, files = []) => {
  for (const entry of readDir(dir)) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, files);
    else if (isCodeFile(entry.name)) files.push(full);
  }
  return files;
};

/**
 * Fusion component ids: `<root>/<name>.<ext>` or `<root>/<name>/<outputType>.<ext>`.
 * Only files named after an output type make a folder a component, so helper files
 * (helpers.ts, config.ts, ...) are not mistaken for one.
 */
const listComponents = (root, outputTypes, prefix = '') => {
  const ids = new Map();
  for (const entry of readDir(root)) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isFile() && isCodeFile(entry.name)) {
      ids.set(prefix + stripExt(entry.name), full);
    } else if (entry.isDirectory()) {
      const hasOutputTypeFile = readDir(full).some(
        (child) => child.isFile() && isCodeFile(child.name) && outputTypes.has(stripExt(child.name)),
      );
      if (hasOutputTypeFile) ids.set(prefix + entry.name, full);
    }
  }
  return ids;
};

// Features are namespaced one level deeper: `features/<namespace>/<name>`.
const listFeatures = (root, outputTypes, prefix = '') => {
  const ids = new Map();
  for (const entry of readDir(root)) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    for (const [id, file] of listComponents(path.join(root, entry.name), outputTypes, `${prefix}${entry.name}/`)) {
      ids.set(id, file);
    }
  }
  return ids;
};

const listSources = (root) => {
  const ids = new Map();
  for (const entry of readDir(root)) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && isCodeFile(entry.name)) ids.set(stripExt(entry.name), full);
    else if (entry.isDirectory() && readDir(full).some((child) => /^index\.[jt]sx?$/.test(child.name))) {
      ids.set(entry.name, full);
    }
  }
  return ids;
};

const listOutputTypes = (root) =>
  new Set(
    readDir(root)
      .filter((entry) => entry.isFile() && isCodeFile(entry.name))
      .map((entry) => stripExt(entry.name)),
  );

/** Components and content sources defined in the theme repository. */
export const readProject = (projectDir) => {
  const components = path.join(projectDir, 'components');
  const outputTypes = listOutputTypes(path.join(components, 'output-types'));
  // A component folder may hold only `default` while the output type folder is empty in tests.
  if (outputTypes.size === 0) outputTypes.add('default');

  const blocksJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'blocks.json'), 'utf8'));

  return {
    outputTypes,
    features: listFeatures(path.join(components, 'features'), outputTypes),
    chains: listComponents(path.join(components, 'chains'), outputTypes),
    layouts: listComponents(path.join(components, 'layouts'), outputTypes),
    sources: listSources(path.join(projectDir, 'content', 'sources')),
    stockPackages: (blocksJson.blocks ?? []).filter((name) => name.startsWith('@wpmedia/')),
    // Everything except tests and tooling: hooks, utils and sources can call content sources too.
    codeFiles: readDir(projectDir)
      .filter((entry) => entry.isDirectory() && !['node_modules', 'tests', 'dist', 'build', 'mocks', 'scripts', 'workspace'].includes(entry.name) && !entry.name.startsWith('.'))
      .flatMap((entry) => walkFiles(path.join(projectDir, entry.name))),
  };
};

/** Components and sources inside the installed `@wpmedia` block packages. */
export const readStock = (wpmediaDir, stockPackages, outputTypes) => {
  const packages = new Map();
  for (const packageName of stockPackages) {
    const dir = path.join(wpmediaDir, packageName.replace('@wpmedia/', ''));
    if (!fs.existsSync(dir)) {
      packages.set(packageName, { missing: true, features: new Map(), chains: new Map(), layouts: new Map(), sources: new Map(), codeFiles: [] });
      continue;
    }
    const prefix = `${packageName}/`;
    packages.set(packageName, {
      missing: false,
      features: listComponents(path.join(dir, 'features'), outputTypes, prefix),
      chains: listComponents(path.join(dir, 'chains'), outputTypes, prefix),
      layouts: listComponents(path.join(dir, 'layouts'), outputTypes, prefix),
      sources: listSources(path.join(dir, 'sources')),
      codeFiles: walkFiles(dir),
    });
  }
  return packages;
};

const SOURCE_CALL_PATTERNS = [
  // useContent({ source: 'name' }), including `source: enabled ? 'name' : null`.
  /\b(?:source|contentService)\s*:\s*[^,}\n]*?['"`]([\w.-]+)['"`]/g,
  // fetch('/pf/api/v3/content/fetch/name')
  /\/content\/fetch\/([\w.-]+)/g,
];
// One content source importing another: `import { x } from './product-api'`.
const SOURCE_IMPORT = /from\s+['"]\.\.?\/([\w.-]+)['"]/g;

const IMPORT_PATTERNS = [
  // import x from '...', import type { X } from '...', export * from '...'.
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  // import '...' for side effects.
  /\bimport\s*['"]([^'"]+)['"]/g,
  // import('...') and require('...').
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Import prefixes that point into the theme: `~/` (the bundle root in Fusion) plus wildcard
 * `paths` from tsconfig.json or jsconfig.json, e.g. `"@components/*": ["./components/*"]`.
 */
const readAliases = (projectDir) => {
  const aliases = new Map([['~/', projectDir]]);
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const options = readJson(path.join(projectDir, name))?.compilerOptions;
    const base = path.resolve(projectDir, options?.baseUrl ?? '.');
    for (const [pattern, [target] = []] of Object.entries(options?.paths ?? {})) {
      if (!pattern.endsWith('/*') || !target?.endsWith('/*')) continue;
      aliases.set(pattern.slice(0, -1), path.resolve(base, target.slice(0, -1)));
    }
  }
  return aliases;
};

/** Every import between theme files, as `{ from, to }` absolute paths (`to` has no extension resolved). */
export const findImports = (files, projectDir) => {
  const aliases = readAliases(projectDir);
  const resolve = (spec, from) => {
    if (spec.startsWith('.')) return path.resolve(path.dirname(from), spec);
    for (const [prefix, dir] of aliases) if (spec.startsWith(prefix)) return path.join(dir, spec.slice(prefix.length));
    return null;
  };
  const imports = [];
  for (const from of files) {
    const text = fs.readFileSync(from, 'utf8');
    for (const pattern of IMPORT_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const to = resolve(match[1], from);
        if (to) imports.push({ from, to });
      }
    }
  }
  return imports;
};

/**
 * Files that belong to a component: its folder (with `_children`), or for `<ns>/default.tsx`
 * the namespace folder its helpers sit in, or just the file for `<ns>/<name>.tsx`.
 */
export const componentScope = (file, outputTypes) => {
  if (fs.statSync(file).isDirectory()) return file;
  return outputTypes.has(stripExt(path.basename(file))) ? path.dirname(file) : file;
};

/** Content source names referenced from code, e.g. `useContent({ source: 'site-service-hierarchy' })`. */
export const findSourceCalls = (files, { sourceFiles = new Map() } = {}) => {
  const calls = new Map();
  const add = (name, file) => {
    // A source file naming itself (logs, fetch helpers) is not a caller.
    if (sourceFiles.get(name) === file) return;
    const list = calls.get(name) ?? [];
    list.push(file);
    calls.set(name, list);
  };
  const sourceByFile = new Map([...sourceFiles].map(([name, file]) => [file, name]));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of SOURCE_CALL_PATTERNS) {
      for (const match of text.matchAll(pattern)) add(match[1], file);
    }
    if (sourceByFile.has(file)) {
      for (const match of text.matchAll(SOURCE_IMPORT)) {
        const imported = stripExt(match[1]) || match[1];
        if (sourceFiles.has(imported) && imported !== sourceByFile.get(file)) add(imported, file);
      }
    }
  }
  return calls;
};
