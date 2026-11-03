import { MongoClient } from 'mongodb';

const SYSTEM_DBS = new Set(['admin', 'config', 'local']);

// Levels a rendering can be reached at. "live" wins over "draft" when both apply.
export const LEVEL = { LIVE: 'live', DRAFT: 'draft', STASHED: 'stashed' };

const pickDatabase = async (client, requested) => {
  if (requested) return requested;
  const { databases } = await client.db().admin().listDatabases();
  const candidates = databases.map((d) => d.name).filter((name) => !SYSTEM_DBS.has(name));
  if (candidates.length !== 1) {
    throw new Error(`Cannot pick a PageBuilder database, pass --db. Found: ${candidates.join(', ') || 'none'}`);
  }
  return candidates[0];
};

// Collects every contentService value nested anywhere in a customFields/contentConfig tree.
const collectContentServices = (value, found) => {
  if (!value || typeof value !== 'object') return;
  if (typeof value.contentService === 'string' && value.contentService) found.add(value.contentService);
  for (const nested of Object.values(value)) collectContentServices(nested, found);
};

class UsageMap {
  constructor() {
    this.items = new Map();
  }

  add(id, level, where) {
    if (!id) return;
    const entry = this.items.get(id) ?? { levels: new Set(), where: new Set() };
    entry.levels.add(level);
    if (where) entry.where.add(where);
    this.items.set(id, entry);
  }
}

const walkRendering = (rendering, level, where, usage) => {
  usage.layouts.add(rendering.layout, level, where);
  const globalSource = rendering.globalContentConfig?.contentService;
  if (globalSource) usage.sources.add(globalSource, level, `${where} (global content)`);

  const visit = (item) => {
    if (!item) return;
    if (item.featureConfig) usage.features.add(item.featureConfig, level, where);
    if (item.chainConfig) usage.chains.add(item.chainConfig, level, where);
    if (item.featureConfig || item.chainConfig) {
      const services = new Set();
      collectContentServices(item.customFields, services);
      collectContentServices(item.contentConfig, services);
      for (const service of services) usage.sources.add(service, level, where);
    }
    for (const child of item.features ?? []) visit(child);
    for (const child of item.renderableItems ?? []) visit(child);
  };
  for (const section of rendering.layoutItems ?? []) visit(section);
};

/**
 * Reads the local PageBuilder database and returns what pages, templates, resolvers and
 * stashed items reference: layouts, chains, features and content sources.
 */
export const readUsage = async ({ uri, db: requestedDb }) => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const dbName = await pickDatabase(client, requestedDb);
    const db = client.db(dbName);
    const usage = {
      dbName,
      layouts: new UsageMap(),
      chains: new UsageMap(),
      features: new UsageMap(),
      sources: new UsageMap(),
      outputTypes: new UsageMap(),
      counts: {},
    };

    // rendering id -> { level, where }, built from the versions of pages and templates.
    const reachable = new Map();
    const mark = (renderingId, level, where) => {
      if (!renderingId) return;
      const current = reachable.get(renderingId);
      if (current?.level === LEVEL.LIVE) return;
      reachable.set(renderingId, { level, where });
    };

    for (const kind of ['page', 'template']) {
      const docs = await db.collection(kind).find().toArray();
      usage.counts[kind] = docs.length;
      for (const doc of docs) {
        const label = `${kind} "${doc.name ?? doc._id}"`;
        usage.outputTypes.add(doc.defaultOutputType, LEVEL.LIVE, label);
        for (const version of Object.values(doc.versions ?? {})) {
          // Pages carry `published`; templates have no published flag, so their head counts as live.
          const isLiveVersion = kind === 'template' || doc.published === version.id;
          mark(version.head, isLiveVersion ? LEVEL.LIVE : LEVEL.DRAFT, label);
          mark(version.stage, LEVEL.DRAFT, label);
          for (const draft of Object.values(version.drafts ?? {})) mark(draft, LEVEL.DRAFT, label);
        }
      }
    }

    const renderings = await db
      .collection('rendering')
      .find({ _id: { $in: [...reachable.keys()] } })
      .toArray();
    usage.counts.rendering = renderings.length;
    for (const rendering of renderings) {
      const { level, where } = reachable.get(rendering._id);
      walkRendering(rendering, level, where, usage);
    }

    const resolvers = await db.collection('resolver_config').find().toArray();
    usage.counts.resolver = resolvers.length;
    for (const resolver of resolvers) {
      usage.sources.add(resolver.contentSourceId, LEVEL.LIVE, `resolver "${resolver.name}"`);
      usage.outputTypes.add(resolver.defaultOutputType, LEVEL.LIVE, `resolver "${resolver.name}"`);
    }

    const stashed = await db.collection('stashed_layout_item').find().toArray();
    usage.counts.stashed = stashed.length;
    for (const item of stashed) {
      walkRendering({ layoutItems: [{ renderableItems: [item.layoutItem] }] }, LEVEL.STASHED, `stashed "${item.name}"`, usage);
    }

    return usage;
  } finally {
    await client.close();
  }
};
