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
 * Sources may sit inside single-nested subdocuments (`summary.claims.total`); assigning them recomputes on the
 * document this schema belongs to. Targets can be sources of other derived paths, so values chain.
 * Also recomputes in `pre("validate")`, so constructor key order or a late subdocument can't leave `target` stale.
 * Hydrating from the database and query updates (`updateOne`, `findOneAndUpdate`) do not recompute; `immutable`
 * targets only change while the document is new.
 * @example
 * schema.plugin(derivedPath, { compute: ({ a, b }) => Number(a ?? 0) + Number(b ?? 0), sources: ["a", "b"], target: "total" });
 */
export function derivedPath<Source extends string>(schema: Schema, { compute, sources, target }: DerivedPathOptions<Source>) {
  if (!schema.path(target)) throw new Error(`derivedPath: unknown target path "${target}"`);
  if (sources.includes(target as Source)) throw new Error(`derivedPath: target "${target}" cannot also be a source`);

  const recompute = (doc: DocumentLike, override?: { source: Source; value: unknown }) => {
    const values = {} as Record<Source, unknown>;
    for (const s of sources) {
      values[s] = s === override?.source ? override.value : doc.get(s);
    }
    const value = compute(values);
    computing++;
    try {
      doc.$set(target, value);
    } finally {
      computing--;
    }
  };

  const targetDepth = singleNestedDepth(schema, target);
  const describe = `"${target}" is derived from ${sources.map((s) => `"${s}"`).join(", ")}`;

  // Only derivedPath writes a derived path: manual document assignments are replaced with the derived value, and
  // query updates that set it fail, since a setter can't drop a key from an update
  schema.path(target).set(function (this: unknown, value: unknown, priorVal: unknown, _schemaType: unknown, options?: { _skipMarkModified?: boolean }) {
    // Mongoose applies defaults through setters with `_skipMarkModified`; those aren't manual sets
    if (computing || options?._skipMarkModified) return value;

    if (!isDocument(this)) {
      throw new Error(`[mongoose-derived-paths] ${describe} and can't be set by a query update. Change its sources on the document and save() it instead.`);
    }
    console.warn(`[mongoose-derived-paths] ${describe}; the manual set was ignored. Set its sources instead.${callerFrames()}`);
    const doc = climb(this, targetDepth);
    // Subdocument not attached yet; keep the prior value and let pre("validate") derive it
    if (!doc) return priorVal;
    const values = {} as Record<Source, unknown>;
    for (const s of sources) values[s] = doc.get(s);
    return compute(values);
  });

  for (const source of sources) {
    const schemaType = schema.path(source);
    if (!schemaType) throw new Error(`derivedPath: unknown source path "${source}"`);
    const depth = singleNestedDepth(schema, source);

    schemaType.set(function (this: unknown, value: unknown) {
      // Setters also run on query updates, where `this` is the Query; only documents can recompute
      if (!isDocument(this)) return value;
      // A nested source's setter runs on its own subdocument; climb back to this schema's document
      const doc = climb(this, depth);
      // Subdocument not attached yet (defaults while building); pre("validate") catches up
      if (!doc) return value;

      // Setters run before the value is stored, so pass the incoming value for the path being set
      recompute(doc, { source, value: castOrRaw(schemaType, value, this) });
      return value;
    });
  }

  schema.pre("validate", function () {
    recompute(this);
  });
}

// Nonzero while derivedPath writes a target, so the target's warning setter can tell its own writes from a developer's
let computing = 0;

const derivedPathsApplied = new WeakSet<Schema>();

/**
 * Schema plugin: wires every field declared with a `derived` option through `derivedPath`, in this schema and
 * every nested subschema, so the formula lives on the field it fills. Apply once on the outermost schema.
 * Sources are relative to the schema the field is declared in.
 * @example
 * const schema = new Schema({ a: Number, b: Number,
 *   total: { type: Number, derived: { sources: ["a", "b"], compute: ({ a, b }) => Number(a ?? 0) + Number(b ?? 0) } } });
 * schema.plugin(derivedPaths);
 */
export function derivedPaths(schema: Schema) {
  // Subschemas shared by several parents must not get their setters registered twice
  if (derivedPathsApplied.has(schema)) return;
  derivedPathsApplied.add(schema);

  schema.eachPath((target, schemaType) => {
    const derived = (schemaType.options as { derived?: DerivedFieldOption }).derived;
    if (derived) derivedPath(schema, { ...derived, target });
  });
  for (const { schema: child } of schema.childSchemas) derivedPaths(child);
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
function callerFrames() {
  const limit = Error.stackTraceLimit;
  // Mongoose's setter chain alone can exceed the default 10 frames
  Error.stackTraceLimit = 50;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  const frames = stack.split("\n").filter((line) => line.trim().startsWith("at "));
  // The first frame is this function, so its file is this module, whether built, linked or installed
  const ownFile = frames[0]?.match(FRAME_FILE)?.[1];
  const callers = frames.filter((line) => !INTERNAL_FRAME.test(line) && (!ownFile || !line.includes(ownFile))).slice(0, CALLER_FRAMES);
  return callers.map((line) => `\n    ${line.trim()}`).join("");
}

function isDocument(value: unknown): value is Document {
  return typeof (value as Document | undefined)?.$set === "function";
}

// Each single-nested hop in `path` is one `$parent()` between the source's subdocument and this schema's document
function singleNestedDepth(schema: Schema, path: string) {
  const parts = path.split(".");
  let depth = 0;
  for (let i = 1; i < parts.length; i++) {
    if ((schema.path(parts.slice(0, i).join(".")) as (SchemaType & { $isSingleNested?: boolean }) | undefined)?.$isSingleNested) depth++;
  }
  return depth;
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
