// Compiled (not run) by `npm run test:types` against the built package, the
// way a consumer sees it. A `derived` field option and both plugins must not
// change how Mongoose infers models.
import { model, Schema } from "mongoose";
import derivedPaths, { derivedPath, type DerivedFieldOption, type DerivedPathOptions } from "mongoose-derived-paths";

const total: DerivedFieldOption<"a" | "b"> = {
  compute: ({ a, b }) => Number(a ?? 0) + Number(b ?? 0),
  sources: ["a", "b"],
};
const schema = new Schema({ a: Number, b: Number, total: { derived: total, type: Number }, doubled: Number });
schema.plugin(derivedPaths);

const doubled: DerivedPathOptions<"total"> = { compute: ({ total }) => Number(total ?? 0) * 2, sources: ["total"], target: "doubled" };
schema.plugin(derivedPath, doubled);

const Thing = model("Thing", schema);
const thing = new Thing({ a: 1 });
const value: number | null | undefined = thing.total;
void value;

// @ts-expect-error -- model() must stay typed: unknown fields are rejected
thing.notAField;
