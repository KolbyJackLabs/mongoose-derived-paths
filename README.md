# mongoose-derived-paths

Mongoose plugin for **stored, derived fields**: declare a field's value as a function of other fields, and it is recomputed every time one of those fields is assigned. Derived values are real paths saved to the database, so they can be queried, indexed and read without recomputation.

```javascript
import mongoose from "mongoose";
import derivedPaths from "mongoose-derived-paths";

const sum = (values) => Object.values(values).reduce((total, v) => total + Number(v ?? 0), 0);

const schema = new mongoose.Schema({
  refund: Number,
  reorder: Number,
  total: { type: Number, default: 0, derived: { sources: ["refund", "reorder"], compute: sum } },
});
schema.plugin(derivedPaths);

const Claims = mongoose.model("Claims", schema);
const claims = new Claims({ refund: 10 });
claims.total; // 10
claims.reorder = 5;
claims.total; // 15
```

---

## Why not a virtual or a getter?

| | Virtual / getter | `derived` field |
| --- | --- | --- |
| Stored in the database | ✗ | ✓ |
| Queryable / indexable | ✗ | ✓ |
| Value frozen after creation (`immutable: true`) | ✗ | ✓ |
| Recomputed on every read | ✓ | ✗ (only when a source changes) |

Use a `derived` field when the computed value is a record of fact — an invoice total, a balance — rather than a view.

---

## Installation

```bash
npm install mongoose-derived-paths
```

Supports Mongoose 7, 8 and 9.

---

## Usage

### Field-level: `derived` option + `derivedPaths`

Declare `derived: { sources, compute }` on the field it fills, then apply `derivedPaths` **once on the outermost schema**. It finds `derived` fields in that schema and every nested subschema.

- `sources` — paths relative to the schema the field is declared in. They may reach into single-nested subdocuments (`"summary.claims.total"`).
- `compute(values)` — receives `{ [source]: value }` and returns the new value. Sources that are not set yet arrive as `undefined`.

### Chained values across subdocuments

A derived field can be a source of another derived field, including one on a parent document:

```javascript
const claimsSchema = new Schema(
  { refund: Number, total: { type: Number, default: 0, derived: { sources: ["refund"], compute: sum } } },
  { _id: false }
);

const statementSchema = new Schema({
  collected: Number,
  claims: { type: claimsSchema, default: {} },
  net: {
    type: Number,
    default: 0,
    derived: {
      sources: ["collected", "claims.total"],
      compute: (v) => Number(v.collected ?? 0) - Number(v["claims.total"] ?? 0),
    },
  },
});
statementSchema.plugin(derivedPaths);

const statement = new Statement({ collected: 100 });
statement.claims.refund = 30;
statement.claims.total; // 30
statement.net; // 70
```

### Parent paths: `$root.`

A subschema field can derive from paths on the document `derivedPaths` is applied to by prefixing them with `$root.`. `compute` receives the keys as written, and plain sources stay relative to the subschema:

```javascript
const periodTotalSchema = new Schema(
  {
    rate: Number,
    total: {
      type: Number,
      derived: {
        sources: ["$root.summary.collected", "$root.summary.claims"],
        compute: (v) => Number(v["$root.summary.collected"] ?? 0) - Number(v["$root.summary.claims"] ?? 0),
      },
    },
    totalUSD: { type: Number, derived: { sources: ["rate", "total"], compute: (v) => Number(v.total ?? 0) * Number(v.rate ?? 1) } },
  },
  { _id: false }
);

statementSchema.add({ periodTotal: { type: periodTotalSchema, default: {} } });
statementSchema.plugin(derivedPaths);
```

`$root.` sources aren't supported for fields inside document arrays.

### Document arrays

A source that goes through a document array gives `compute` one value per element:

```javascript
const orderSchema = new Schema({
  items: [new Schema({ price: Number }, { _id: false })],
  total: {
    type: Number,
    default: 0,
    derived: { sources: ["items.price"], compute: (v) => (v["items.price"] ?? []).reduce((sum, p) => sum + Number(p ?? 0), 0) },
  },
});
orderSchema.plugin(derivedPaths);

order.items[0].price = 5; // recomputes total
order.items.push({ price: 3 }); // doesn't (no setter runs) — call refreshDerived(order) or validate
```

Assigning an element's field, or replacing the whole array, recomputes immediately. `push`, `splice`, `pull` and other in-place array changes don't run setters; they're picked up on validate, or right away with `refreshDerived(doc)`.

Embedded discriminators declared with a path's `discriminators` option are wired too, so each discriminated type can declare its own derived fields.

### Explicit: `derivedPath`

`derivedPaths` reads `derived` field options. To wire a single path without a field option, call `derivedPath` with the target and sources relative to the schema you apply it to:

```javascript
import { derivedPath } from "mongoose-derived-paths";

statementSchema.plugin(derivedPath, {
  target: "periodTotal.total",
  sources: ["summary.savedBy.total", "summary.claims.total"],
  compute: (v) => Number(v["summary.savedBy.total"] ?? 0) - Number(v["summary.claims.total"] ?? 0),
});
```

---

## When values are recomputed

| Event | Recomputes? |
| --- | --- |
| `doc.source = value` | ✓ |
| `doc.set("nested.source", value)` | ✓ |
| `new Model({ ... })` | ✓ |
| Element field of a document array source / replacing the array | ✓ |
| `push`, `splice`, `pull` on a document array source | ✗ until validate or `refreshDerived(doc)` |
| `doc.validate()` / `doc.save()` | ✓ (`pre("validate")`, so constructor key order can't leave a value stale) |
| `refreshDerived(doc)` | ✓ (the document and all its subdocuments) |
| Loaded from the database / `Model.hydrate()` | ✗ — the stored value is kept |
| `updateOne`, `findOneAndUpdate`, other query updates | ✗ — and setting the derived path itself fails the query |

`compute` receives the **cast** value of the path being assigned (e.g. `"7"` assigned to a `Number` path arrives as `7`).

Targets marked `immutable: true` only change while the document is new: once saved, the stored value is kept even if a source changes.

### Derived paths can't be set manually

Only the plugin writes a derived path.

- **Documents:** `doc.total = 5`, `doc.set("total", 5)` and constructor input that includes it are ignored. The path keeps its derived value and a `console.warn` names the path and its sources.
- **Query updates** (`updateOne`, `findOneAndUpdate`, …) that `$set` a derived path fail with an error, since a setter can't drop a key from an update. Change the sources on the document and `save()` it instead.

Defaults and the plugin's own writes are not manual sets.

---

## API

### `derivedPaths(schema)` (default export)

Schema plugin. Wires every field with a `derived` option in `schema`, its nested subschemas and their embedded discriminators. `$root.` sources resolve from `schema`. Safe to apply more than once.

### `derivedPath(schema, { target, sources, compute })`

Schema plugin. Recomputes `target` whenever a path in `sources` is assigned, and in `pre("validate")`. Throws at setup if a path doesn't exist or `target` is listed in `sources`.

### `refreshDerived(doc)`

Recomputes every derived path on `doc` and its subdocuments now, deepest first. Use it after in-place array changes when you need fresh values before validate (for example in another `pre("validate")` hook that reads them). Values that aren't Mongoose documents are ignored.

### Types

- `DerivedPathOptions<Source>` — options for `derivedPath`.
- `DerivedFieldOption<Source>` — the `derived` field option (`DerivedPathOptions` without `target`).

---

## License

MIT
