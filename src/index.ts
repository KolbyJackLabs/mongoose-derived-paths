import type { Document, Schema, SchemaType } from "mongoose";

export type DerivedPathOptions<Source extends string = string> = {
  /** Recomputes `target` from the current source values; unset sources arrive as `undefined` */
  compute: (values: Record<Source, unknown>) => unknown;
  /** Paths whose assignment triggers a recompute, relative to the schema the plugin is applied to */
  sources: readonly Source[];
  /** Path that receives `compute`'s result */
  target: string;
};

/** Field option read by `derivedPaths`: `total: { type: …, derived: { sources: [...], compute } }` */
export type DerivedFieldOption<Source extends string = string> = Omit<DerivedPathOptions<Source>, "target">;

/**
 * Schema plugin: whenever a source path is assigned on a document, recompute `target` from all sources.
 * Sources may sit inside single-nested subdocuments (`summary.claims.total`) or document arrays
 * (`items.price`, which `compute` receives as an array with one value per element); assigning them recomputes on the
 * document this schema belongs to. Targets can be sources of other derived paths, so values chain.
 * Array mutations (`push`, `splice`, `pull`, reassigning the array) don't run setters; they recompute on validate or
 * `refreshDerived(doc)`.
 * Also recomputes in `pre("validate")`, so constructor key order or a late subdocument can't leave `target` stale.
 * Hydrating from the database and query updates (`updateOne`, `findOneAndUpdate`) do not recompute; `immutable`
 * targets only change while the document is new.
 * @example
 * schema.plugin(derivedPath, { compute: ({ a, b }) => Number(a ?? 0) + Number(b ?? 0), sources: ["a", "b"], target: "total" });
 */
export function derivedPath<Source extends string>(schema: Schema, { compute, sources, target }: DerivedPathOptions<Source>) {
  const targetType = resolvePath(schema, target)?.schemaType;
  if (!targetType) throw new Error(`derivedPath: unknown target path "${target}"`);
  if (sources.includes(target as Source)) throw new Error(`derivedPath: target "${target}" cannot also be a source`);
  // Validate every source before wiring anything, so a bad call leaves the schema untouched
  const resolvedSources = sources.map((source) => {
    const resolved = resolvePath(schema, source);
    if (!resolved) throw new Error(`derivedPath: unknown source path "${source}"`);
    return { resolved, source };
  });
  // Schema clones (discriminators) copy setters and hooks; a target that already has its guard is fully wired
  if (hasSetter(targetType, `target:${target}`)) return;

  const readSources = (doc: DocumentLike, override?: Override<Source>) => {
    const values = {} as Record<Source, unknown>;
    for (const s of sources) {
      // Every source under the path being assigned reads the incoming value, not just the one whose setter is running
      const shared = override && pathPrefix(s, override.index) === pathPrefix(override.source, override.index);
      values[s] = collect(doc, s.split("."), shared ? override : undefined);
    }
    return values;
  };

  const recompute = (doc: DocumentLike, override?: Override<Source>) => {
    const values = readSources(doc, override);
    // The setter's document or element isn't reachable from `doc` yet (an array element cast before the array is
    // stored); the container's own setter or pre("validate") derives the value once it is
    if (override && !override.used) return;
    const value = compute(values);
    computing++;
    try {
      doc.$set(target, value);
    } finally {
      computing--;
    }
  };

  const targetDepth = resolvePath(schema, target)?.depth ?? 0;
  // Subdocuments on the way to the target, e.g. "summary" and "summary.incentives" for "summary.incentives.commission"
  const targetContainers = (resolvePath(schema, target)?.steps.slice(0, -1) ?? []).map(({ index }) => pathPrefix(target, index));
  const describe = `"${target}" is derived from ${sources.map((s) => `"${s}"`).join(", ")}`;

  // Only derivedPath writes a derived path: manual document assignments are replaced with the derived value, and
  // query updates that set it fail, since a setter can't drop a key from an update
  addSetter(targetType, `target:${target}`, function (this: unknown, value: unknown, priorVal: unknown, _schemaType: unknown, options?: { _skipMarkModified?: boolean }) {
    // Written into an incoming container by a source setter below; already derived
    if (value instanceof Derived) return value.value;
    // Mongoose applies defaults through setters with `_skipMarkModified`; those aren't manual sets
    if (computing || options?._skipMarkModified) return value;

    if (!isDocument(this)) {
      throw new Error(`[mongoose-derived-paths] ${describe} and can't be set by a query update. Change its sources on the document and save() it instead.`);
    }
    console.warn(`[mongoose-derived-paths] ${describe}; the manual set was ignored. Set its sources instead.${callerFrames()}`);
    const doc = climb(this, targetDepth);
    // Subdocument not attached yet; keep the prior value and let pre("validate") derive it
    if (!doc) return priorVal;
    return compute(readSources(doc as DocumentLike));
  });

  for (const { resolved, source } of resolvedSources) {
    // The leaf and every subdocument/array on the way to it: replacing any of them changes the source's value
    for (const { depth, index, schemaType } of resolved.steps) {
      // Assigning a subdocument the target lives in replaces the target along with it
      const replacesTarget = targetContainers.includes(pathPrefix(source, index));
      // Target containers that also hold this source; creating one of them re-runs this setter
      const sharedContainers = targetContainers.filter((path) => source.startsWith(`${path}.`));
      addSetter(schemaType, `source:${target}:${source}:${index}`, function (this: unknown, value: unknown) {
        // Setters also run on query updates, where `this` is the Query; only documents can recompute
        if (!isDocument(this)) return value;
        // A nested path's setter runs on its own subdocument or array element; climb back to this schema's document
        const doc = climb(this, depth);
        // Subdocument not attached yet (defaults while building); pre("validate") catches up
        if (!doc) return value;
        // Another derived target written into this incoming container; read it as its plain value
        const incoming = value instanceof Derived ? value.value : value;
        // Setters run before the value is stored, so read the incoming (cast) value in place of the stored one
        const override: Override<Source> = { index, owner: this, source, value: castOrRaw(schemaType, incoming, this) };

        if (replacesTarget) {
          // Setting the target on the document now would write into the container being replaced (or create it, and
          // re-run this setter until the stack overflows), so write it into the incoming value instead
          const values = readSources(doc as DocumentLike, override);
          if (!override.used) return value;
          return withTarget(value, target.split(".").slice(index + 1), new Derived(compute(values)));
        }
        // A container holding this source and the target is still being cast; its own setter derives the target
        if (sharedContainers.some((path) => (doc as DocumentLike).get(path) == null)) return value;

        recompute(doc as DocumentLike, override);
        return value;
      });
    }
  }

  // A target container that holds none of the sources: assigning it brings the target's default (or a manual value), so
  // write the derived value into the incoming container
  for (const { depth, index, schemaType } of resolvePath(schema, target)?.steps.slice(0, -1) ?? []) {
    const container = pathPrefix(target, index);
    if (sources.some((source) => source.startsWith(`${container}.`))) continue;
    addSetter(schemaType, `container:${target}:${index}`, function (this: unknown, value: unknown) {
      if (!isDocument(this)) return value;
      const doc = climb(this, depth);
      if (!doc) return value;
      return withTarget(value, target.split(".").slice(index + 1), new Derived(compute(readSources(doc as DocumentLike))));
    });
  }

  schema.pre("validate", function () {
    recompute(this);
  });
  // Lets refreshDerived() rerun this recompute on demand; hooks survive schema clones made by discriminators
  // Mongoose's types only list built-in hook names; Kareem runs any name
  (schema as unknown as { pre(name: string, fn: (this: DocumentLike) => void): void }).pre(REFRESH_HOOK, function () {
    recompute(this);
  });
}

const REFRESH_HOOK = "mongoose-derived-paths:refresh";

/**
 * Recompute every derived path on `doc` and its subdocuments now, deepest first. Use it after array mutations
 * (`push`, `splice`, `pull`) when you need fresh values before validate, e.g. in another `pre("validate")` hook
 * that reads them. Anything that isn't a Mongoose document is ignored.
 */
export function refreshDerived(doc: Document) {
  // Not a Mongoose document (a plain object or a test double): nothing is wired, so there's nothing to derive
  if (typeof (doc as Partial<Document & { $getAllSubdocs: unknown }>)?.$getAllSubdocs !== "function") return;
  const subdocs = (doc as Document & { $getAllSubdocs(): Document[] }).$getAllSubdocs();
  const byDepth = subdocs.map((sub) => ({ depth: depthOf(sub), sub })).sort((a, b) => b.depth - a.depth);
  for (const { sub } of byDepth) runRefresh(sub);
  runRefresh(doc);
}

function runRefresh(doc: Document) {
  const schema = (doc as Document & { $__schema?: Schema }).$__schema ?? doc.schema;
  (schema as Schema & { s: { hooks: { execPreSync(name: string, context: unknown, args: unknown[]): unknown } } }).s.hooks.execPreSync(REFRESH_HOOK, doc, []);
}

function depthOf(doc: Document) {
  let depth = 0;
  let current = doc;
  for (;;) {
    // A top-level document is its own $parent()
    const parent = (current as Document & { $parent(): Document | undefined }).$parent();
    if (!parent || parent === current) return depth;
    current = parent;
    depth++;
  }
}

// Nonzero while derivedPath writes a target, so the target's warning setter can tell its own writes from a developer's
let computing = 0;

const ROOT = "$root.";

/**
 * Schema plugin: wires every field declared with a `derived` option through `derivedPath`, in this schema and
 * every nested subschema (including embedded discriminators declared with a path's `discriminators` option), so the
 * formula lives on the field it fills. Apply once on the outermost schema.
 * Sources are relative to the schema the field is declared in. A source starting with `$root.` is relative to the
 * schema this plugin is applied to instead, so a subschema field can derive from its parent's paths
 * (`"$root.summary.claims.total"`); `compute` receives the keys as written. `$root.` sources can't be used inside
 * document arrays.
 * @example
 * const schema = new Schema({ a: Number, b: Number,
 *   total: { type: Number, derived: { sources: ["a", "b"], compute: ({ a, b }) => Number(a ?? 0) + Number(b ?? 0) } } });
 * schema.plugin(derivedPaths);
 */
export function derivedPaths(schema: Schema) {
  walk(schema, schema, "", false, new Set());

  // Compiling a model rebuilds embedded discriminator schemas without the setters wired above (their `derived`
  // options survive), so wire the compiled ones too. Setters are tagged, so already-wired paths are skipped
  schema.on("init", (model: { schema: Schema }) => wireCompiled(model.schema, new Set()));
}

// Visits `schema` (found at `prefix` under `root`) and its subdocument and array schemas, wiring `derived` fields.
// Re-wiring is a no-op (tagged setters), so subschemas shared by several parents are safe
function walk(schema: Schema, root: Schema, prefix: string, inArray: boolean, seen: Set<Schema>) {
  if (seen.has(schema)) return;
  seen.add(schema);
  schema.eachPath((path, schemaType) => {
    const { derived, discriminators } = schemaType.options as { derived?: DerivedFieldOption; discriminators?: Record<string, Schema> };
    if (derived) wireField(schema, root, prefix, inArray, path, derived);

    const container = schemaType as ContainerSchemaType;
    if (!container.schema || !(container.$isSingleNested || container.$isMongooseDocumentArray)) return;
    const childInArray = inArray || Boolean(container.$isMongooseDocumentArray);
    walk(container.schema, root, `${prefix}${path}.`, childInArray, seen);
    // Embedded discriminators declared on the path aren't child schemas until the model compiles
    for (const discriminator of Object.values(discriminators ?? {})) walk(discriminator, root, `${prefix}${path}.`, childInArray, seen);
  });
}

function wireField(schema: Schema, root: Schema, prefix: string, inArray: boolean, target: string, derived: DerivedFieldOption) {
  if (!derived.sources.some((source) => source.startsWith(ROOT))) {
    derivedPath(schema, { ...derived, target });
    return;
  }
  if (inArray) throw new Error(`derivedPaths: "${prefix}${target}" is inside a document array, where "${ROOT}" sources aren't supported`);

  // Wire on the root, where every source resolves; hand `compute` the keys as the field declared them
  const keys = derived.sources.map((source) => ({ declared: source, fromRoot: source.startsWith(ROOT) ? source.slice(ROOT.length) : `${prefix}${source}` }));
  derivedPath(root, {
    compute: (values) => derived.compute(Object.fromEntries(keys.map(({ declared, fromRoot }) => [declared, values[fromRoot]]))),
    sources: keys.map(({ fromRoot }) => fromRoot),
    target: `${prefix}${target}`,
  });
}

function wireLocalFields(schema: Schema) {
  schema.eachPath((target, schemaType) => {
    const { derived } = schemaType.options as { derived?: DerivedFieldOption };
    // `$root.` fields are wired on their root by derivedPaths, and those setters survive compilation
    if (derived && !derived.sources.some((source) => source.startsWith(ROOT))) derivedPath(schema, { ...derived, target });
  });
}

function wireCompiled(schema: Schema, seen: Set<Schema>) {
  if (seen.has(schema)) return;
  seen.add(schema);
  wireLocalFields(schema);
  schema.eachPath((_path, schemaType) => {
    const nested = (schemaType as ContainerSchemaType).schema as (Schema & { discriminators?: Record<string, Schema> }) | undefined;
    for (const discriminator of Object.values(nested?.discriminators ?? {})) wireCompiled(discriminator, seen);
  });
  for (const { schema: child } of schema.childSchemas) wireCompiled(child, seen);
}

const SETTER_KEY = Symbol.for("mongoose-derived-paths:setter");
type TaggedSetter = ((...args: never[]) => unknown) & { [SETTER_KEY]?: string };

function hasSetter(schemaType: SchemaType, key: string) {
  return ((schemaType as SchemaType & { setters: TaggedSetter[] }).setters ?? []).some((setter) => setter[SETTER_KEY] === key);
}

function addSetter(schemaType: SchemaType, key: string, setter: TaggedSetter) {
  if (hasSetter(schemaType, key)) return;
  setter[SETTER_KEY] = key;
  schemaType.set(setter as (value: unknown) => unknown);
}

export default derivedPaths;

// Structural so validate hooks' loosely typed `this` (any Document generic) fits
type DocumentLike = { $set(path: string, value: unknown): unknown; get(path: string): unknown };

// Mongoose and Node internals sit between the assignment and the setter
const INTERNAL_FRAME = /[\\/]node_modules[\\/]mongoose[\\/]|\(node:|^\s*at node:/;
const FRAME_FILE = /\(?((?:file:\/\/)?[^():]+(?::\\[^():]+)?):\d+:\d+\)?$/;

// Where the manual set happened, so the warning points at the caller rather than at this package. Several frames,
// because wrappers that patch Document#$set (sync/audit plugins) sit between the caller and Mongoose
const CALLER_FRAMES = 3;
const FRAME_LOCATION = /[^\s(]+:\d+:\d+(?=\)?$)/;
function callerFrames() {
  const limit = Error.stackTraceLimit;
  // Mongoose's setter chain alone can exceed the default 10 frames
  Error.stackTraceLimit = 50;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  const frames = stack.split("\n").filter((line) => line.trim().startsWith("at "));
  // The first frame is this function, so its file is this module, whether built, linked or installed
  const ownFile = frames[0]?.match(FRAME_FILE)?.[1];
  const callers = frames.filter((line) => !INTERNAL_FRAME.test(line) && (!ownFile || !line.includes(ownFile)));
  // A $set wrapper re-enters once per nested subdocument; list each location once
  const locations = [...new Map(callers.map((line) => [line.match(FRAME_LOCATION)?.[0] ?? line, line.trim()])).values()];
  return locations
    .slice(0, CALLER_FRAMES)
    .map((line) => `\n    ${line}`)
    .join("");
}

function isDocument(value: unknown): value is Document {
  return typeof (value as Document | undefined)?.$set === "function";
}

type ContainerSchemaType = SchemaType & { $isSingleNested?: boolean; $isMongooseDocumentArray?: boolean; schema?: Schema };

type ResolvedStep = { depth: number; index: number; schemaType: SchemaType };

// Resolves `path` through single-nested subdocuments and document arrays. Each step is a path whose setter affects
// the value (every container on the way, then the leaf): `depth` counts the subdocument hops from the document that
// owns it back to this schema's document, and `index` is its last segment in `path`
function resolvePath(schema: Schema, path: string): { depth: number; schemaType: SchemaType; steps: ResolvedStep[] } | undefined {
  const parts = path.split(".");
  const steps: ResolvedStep[] = [];
  let current = schema;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const container = current.path(parts.slice(start, i + 1).join(".")) as ContainerSchemaType | undefined;
    if (container?.schema && (container.$isSingleNested || container.$isMongooseDocumentArray)) {
      steps.push({ depth, index: i, schemaType: container });
      current = container.schema;
      depth++;
      start = i + 1;
    }
  }
  const schemaType = current.path(parts.slice(start).join("."));
  if (!schemaType) return undefined;
  steps.push({ depth, index: parts.length - 1, schemaType });
  return { depth, schemaType, steps };
}

type Override<Source extends string = string> = { index: number; owner: unknown; source: Source; used?: boolean; value: unknown };

// Reads `parts` from `node`, mapping over arrays so `items.price` yields one value per element. `override` swaps in
// the incoming value at the path whose setter is running (on the document or element that owns it), since it isn't
// stored yet
function collect(node: unknown, parts: string[], override?: Override, index = 0): unknown {
  if (node == null) return undefined;
  if (Array.isArray(node)) return node.map((element) => collect(element, parts, override, index));
  const overridden = override && node === override.owner && index === override.index;
  if (overridden) override.used = true;
  const next = overridden
    ? override.value
    : typeof (node as DocumentLike).get === "function"
        ? (node as DocumentLike).get(parts[index])
        : (node as Record<string, unknown>)[parts[index]];
  return index === parts.length - 1 ? next : collect(next, parts, override, index + 1);
}

// A derived value written into an incoming container, so the target's setter takes it without a warning
class Derived {
  constructor(readonly value: unknown) {}
}

// Copies the plain-object `container` with `value` at `parts`, leaving the caller's object untouched. Anything else
// (a document, null) is returned as is; pre("validate") derives the target once it's stored. A value already written
// by an outer container's setter wins: setters on inner containers run while it's cast, before it's stored
function withTarget(container: unknown, parts: string[], value: Derived): unknown {
  if (!isPlainObject(container)) return container;
  const [key, ...rest] = parts;
  if (rest.length === 0 && container[key] instanceof Derived) return container;
  const next = rest.length === 0 ? value : withTarget(container[key] ?? {}, rest, value);
  return next === container[key] ? container : { ...container, [key]: next };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && Object.getPrototypeOf(value) === Object.prototype;
}

// `path` up to and including segment `index`
function pathPrefix(path: string, index: number) {
  return path.split(".").slice(0, index + 1).join(".");
}

function climb(doc: Document, depth: number) {
  let current: Document | undefined = doc;
  for (let i = 0; i < depth && current; i++) {
    current = (current as Document & { $parent(): Document | undefined }).$parent();
  }
  return current;
}

// Setters receive the raw assigned value; cast it so `compute` sees the same types as the stored siblings
function castOrRaw(schemaType: SchemaType, value: unknown, doc: Document) {
  if (value == null) return value;
  try {
    return (schemaType as SchemaType & { cast(value: unknown, doc: Document): unknown }).cast(value, doc);
  } catch {
    // Uncastable input; mongoose reports the CastError on the source path itself
    return value;
  }
}
