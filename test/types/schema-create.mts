// Mongoose 9 only (Schema.create): a `derived` option must not break its inference.
import { model, Schema } from "mongoose";
import derivedPaths from "mongoose-derived-paths";

const schema = Schema.create({
  a: { required: true, type: Number },
  total: { derived: { compute: ({ a }: Record<"a", unknown>) => Number(a ?? 0), sources: ["a"] }, type: Number },
});
schema.plugin(derivedPaths);

const Created = model("Created", schema);
const a: number = new Created({ a: 1 }).a;
void a;
