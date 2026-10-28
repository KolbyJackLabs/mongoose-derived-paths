import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose, { Schema } from "mongoose";
import derivedPaths, { derivedPath, refreshDerived } from "../src/index";

const add = (values: Record<string, unknown>) => Object.values(values).reduce<number>((sum, v) => sum + Number(v ?? 0), 0);
const sumArray = (values: Record<string, unknown>) =>
  (Object.values(values)[0] as unknown[] | undefined)?.reduce<number>((sum, v) => sum + Number(v ?? 0), 0) ?? 0;
let modelCount = 0;
const uniqueModel = (schema: Schema) => mongoose.model(`DerivedPathsTest${modelCount++}`, schema);

function claimsModel() {
  const claimsSchema = new Schema(
    { refund: Number, reorder: Number, total: { default: 0, type: Number } },
    { _id: false }
  );
  claimsSchema.plugin(derivedPath, { compute: add, sources: ["refund", "reorder"], target: "total" });
  return uniqueModel(new Schema({ summary: { claims: { default: {}, type: claimsSchema } } }));
}

describe("derivedPath", () => {
  it("recomputes the target when a source is assigned", () => {
    const doc: any = new (claimsModel())();
    doc.summary.claims.refund = 10;
    expect(doc.summary.claims.total).toBe(10);
    doc.summary.claims.reorder = 5;
    expect(doc.summary.claims.total).toBe(15);
  });

  it("recomputes from constructor input", () => {
    const doc: any = new (claimsModel())({ summary: { claims: { refund: 1, reorder: 2 } } });
    expect(doc.summary.claims.total).toBe(3);
  });

  it("recomputes via doc.set with a full path", () => {
    const doc: any = new (claimsModel())({ summary: { claims: { refund: 1, reorder: 1 } } });
    doc.set("summary.claims.reorder", 4);
    expect(doc.summary.claims.total).toBe(5);
  });

  it("passes the cast value of the path being set", () => {
    const doc: any = new (claimsModel())();
    doc.summary.claims.refund = "7";
    expect(doc.summary.claims.total).toBe(7);
  });

  it("keeps the stored target when hydrating from the database", () => {
    const doc: any = claimsModel().hydrate({ summary: { claims: { refund: 1, reorder: 1, total: 99 } } });
    expect(doc.summary.claims.total).toBe(99);
  });

  it("recomputes in pre-validate when the constructor sets the target after its sources", async () => {
    const doc: any = new (claimsModel())({ summary: { claims: { refund: 2, reorder: 3, total: 0 } } });
    await doc.validate();
    expect(doc.summary.claims.total).toBe(5);
  });

  it("chains a parent-level value off a nested subdocument's derived value", () => {
    const claimsSchema = new Schema({ refund: Number, total: { default: 0, type: Number } }, { _id: false });
    claimsSchema.plugin(derivedPath, { compute: add, sources: ["refund"], target: "total" });
    const summarySchema = new Schema({ claims: { default: {}, type: claimsSchema } }, { _id: false });
    const schema = new Schema({ collected: Number, net: { default: 0, type: Number }, summary: { default: {}, type: summarySchema } });
    schema.plugin(derivedPath, {
      compute: (v: Record<"collected" | "summary.claims.total", unknown>) => Number(v.collected ?? 0) - Number(v["summary.claims.total"] ?? 0),
      sources: ["collected", "summary.claims.total"],
      target: "net",
    });

    const doc: any = new (uniqueModel(schema))({ collected: 100 });
    doc.summary.claims.refund = 30;
    expect(doc.summary.claims.total).toBe(30);
    expect(doc.net).toBe(70);
  });

  it("leaves immutable targets alone once the document is saved", () => {
    const schema = new Schema({ a: Number, total: { default: 0, immutable: true, type: Number } });
    schema.plugin(derivedPath, { compute: add, sources: ["a"], target: "total" });
    const doc: any = uniqueModel(schema).hydrate({ a: 1, total: 1 });
    doc.a = 5;
    expect(doc.total).toBe(1);
  });

  it("rejects unknown paths and a target listed as a source", () => {
    const schema = new Schema({ a: Number, total: Number });
    expect(() => schema.plugin(derivedPath, { compute: add, sources: ["missing"], target: "total" })).toThrow(/unknown source/);
    expect(() => schema.plugin(derivedPath, { compute: add, sources: ["a"], target: "missing" })).toThrow(/unknown target/);
    expect(() => schema.plugin(derivedPath, { compute: add, sources: ["a", "total"], target: "total" })).toThrow(/cannot also be a source/);
  });
});

describe("manual sets", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("stays quiet for defaults, source assignments, chained writes, validate and hydrate", async () => {
    const Model = claimsModel();
    const doc: any = new Model({ summary: { claims: { refund: 1 } } });
    doc.summary.claims.reorder = 2;
    await doc.validate();
    Model.hydrate({ summary: { claims: { refund: 1, total: 1 } } });
    expect(warn).not.toHaveBeenCalled();
  });

  it("ignores an assignment to the target, keeps the derived value, and warns", () => {
    const doc: any = new (claimsModel())({ summary: { claims: { refund: 2 } } });
    doc.summary.claims.total = 99;
    expect(doc.summary.claims.total).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/"total" is derived from "refund", "reorder"; the manual set was ignored\. Set its sources instead\.\n {4}at .*derivedPaths\.test\.ts:\d+:\d+/);
  });

  it("lists each caller location once when a $set wrapper re-enters per nested subdocument", () => {
    // Like a sync/audit plugin: wraps $set (and its `set` alias), which Mongoose re-enters for each nested path segment
    const proto: any = mongoose.Document.prototype;
    const original = proto.$set;
    proto.$set = proto.set = function wrappedSet(this: unknown, ...args: unknown[]) {
      return original.apply(this, args);
    };
    try {
      const doc: any = new (claimsModel())();
      doc.set("summary.claims.total", 5);
    } finally {
      proto.$set = proto.set = original;
    }
    const lines: string[] = warn.mock.calls[0][0].split("\n").slice(1);
    const wrapper = lines.filter((line) => line.includes("wrappedSet"));
    expect(wrapper).toHaveLength(1);
    expect(lines.some((line) => /derivedPaths\.test\.ts:\d+:\d+/.test(line) && !line.includes("wrappedSet"))).toBe(true);
  });

  it("ignores the target in constructor input", () => {
    const doc: any = new (claimsModel())({ summary: { claims: { refund: 1, total: 50 } } });
    expect(doc.summary.claims.total).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("ignores doc.set on a nested derived path", () => {
    const doc: any = new (claimsModel())({ summary: { claims: { refund: 3 } } });
    doc.set("summary.claims.total", 99);
    expect(doc.summary.claims.total).toBe(3);
  });

  it("fails a query update that sets the target instead of writing it", () => {
    const Model = claimsModel();
    // Setters run when the update is cast at exec time; cast it directly so no connection is needed
    const query: any = Model.updateOne({}, { $set: { "summary.claims.total": 5 } });
    expect(() => query._castUpdate(query.getUpdate())).toThrow(/can't be set by a query update/);
  });
});

describe("derivedPaths", () => {
  it("wires field-level `derived` options in nested subschemas, once", () => {
    const claimsSchema = new Schema(
      { refund: Number, total: { default: 0, derived: { compute: add, sources: ["refund"] }, type: Number } },
      { _id: false }
    );
    const schema = new Schema({
      net: { default: 0, derived: { compute: add, sources: ["summary.claims.total"] }, type: Number },
      summary: { default: {}, type: new Schema({ claims: { default: {}, type: claimsSchema } }, { _id: false }) },
    });
    schema.plugin(derivedPaths);
    schema.plugin(derivedPaths);

    const doc: any = new (uniqueModel(schema))();
    doc.summary.claims.refund = 7;
    expect(doc.summary.claims.total).toBe(7);
    expect(doc.net).toBe(7);
    expect((claimsSchema.path("refund") as any).setters).toHaveLength(1);
  });
});

describe("document array sources", () => {
  function orderModel() {
    const itemSchema = new Schema({ price: Number }, { _id: false });
    const schema = new Schema({
      items: [itemSchema],
      total: { default: 0, derived: { compute: sumArray, sources: ["items.price"] }, type: Number },
    });
    schema.plugin(derivedPaths);
    return uniqueModel(schema);
  }

  it("passes one value per element and recomputes when an element's field is assigned", () => {
    let received: unknown;
    const itemSchema = new Schema({ price: Number }, { _id: false });
    const schema = new Schema({ items: [itemSchema], total: Number });
    schema.plugin(derivedPath, {
      compute: (v: Record<"items.price", unknown>) => {
        received = v["items.price"];
        return sumArray(v);
      },
      sources: ["items.price"],
      target: "total",
    });
    const doc: any = new (uniqueModel(schema))({ items: [{ price: 1 }, { price: 2 }] });
    doc.items[1].price = 10;
    expect(received).toEqual([1, 10]);
    expect(doc.total).toBe(11);
  });

  it("derives from constructor input", () => {
    const doc: any = new (orderModel())({ items: [{ price: 2 }, { price: 3 }] });
    expect(doc.total).toBe(5);
  });

  it("recomputes after push and pull on refreshDerived and on validate", async () => {
    const doc: any = new (orderModel())({ items: [{ price: 2 }] });
    doc.items.push({ price: 5 });
    refreshDerived(doc);
    expect(doc.total).toBe(7);
    doc.items.pull(doc.items[0]);
    await doc.validate();
    expect(doc.total).toBe(5);
  });

  it("refreshDerived ignores values that aren't documents", () => {
    expect(() => refreshDerived({ items: [] } as any)).not.toThrow();
  });

  it("supports embedded discriminators: per-type derived fields over discriminated array items", () => {
    const itemSchema = new Schema({ amount: Number, kind: String }, { _id: false, discriminatorKey: "kind" });
    const paypalItem = new Schema({ email: String }, { _id: false });
    const resolutionSchema = new Schema({ amount: { default: 0, type: Number }, type: String }, { _id: false, discriminatorKey: "type" });
    const chargebackSchema = new Schema(
      {
        amount: { default: 0, derived: { compute: sumArray, sources: ["chargebacks.amount"] }, type: Number },
        chargebacks: { discriminators: { PAYPAL: paypalItem }, type: [itemSchema] },
      },
      { _id: false }
    );
    const schema = new Schema({ resolutions: { discriminators: { CHARGEBACK: chargebackSchema }, type: [resolutionSchema] } });
    schema.plugin(derivedPaths);

    const doc: any = new (uniqueModel(schema))({
      resolutions: [
        { chargebacks: [{ amount: 4, kind: "PAYPAL" }], type: "CHARGEBACK" },
        { amount: 9, type: "OTHER" },
      ],
    });
    expect(doc.resolutions[0].amount).toBe(4);
    doc.resolutions[0].chargebacks[0].amount = 6;
    expect(doc.resolutions[0].amount).toBe(6);
    // Types without a derived amount keep it manual
    doc.resolutions[1].amount = 12;
    expect(doc.resolutions[1].amount).toBe(12);
  });
});

describe("$root sources", () => {
  function statementModel() {
    const periodSchema = new Schema(
      {
        rate: { default: 1, type: Number },
        total: {
          default: 0,
          derived: {
            compute: (v: Record<"$root.summary.claims" | "$root.summary.collected", unknown>) => Number(v["$root.summary.collected"] ?? 0) - Number(v["$root.summary.claims"] ?? 0),
            sources: ["$root.summary.collected", "$root.summary.claims"],
          },
          type: Number,
        },
        totalUSD: { default: 0, derived: { compute: (v: Record<string, unknown>) => Number(v.total ?? 0) * Number(v.rate ?? 1), sources: ["rate", "total"] }, type: Number },
      },
      { _id: false }
    );
    const schema = new Schema({
      periodTotal: { default: {}, type: periodSchema },
      summary: { default: {}, type: new Schema({ claims: Number, collected: Number }, { _id: false }) },
    });
    schema.plugin(derivedPaths);
    return uniqueModel(schema);
  }

  it("derives a subdocument field from the root's paths, with keys as declared, and chains on", () => {
    const doc: any = new (statementModel())({ periodTotal: { rate: 2 } });
    doc.summary.collected = 100;
    doc.summary.claims = 30;
    expect(doc.periodTotal.total).toBe(70);
    expect(doc.periodTotal.totalUSD).toBe(140);
  });

  it("ignores a manual set of a $root-derived field", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc: any = new (statementModel())({ summary: { collected: 10 } });
    doc.periodTotal.total = 99;
    expect(doc.periodTotal.total).toBe(10);
    warn.mockRestore();
  });

  it("rejects $root sources inside document arrays", () => {
    const itemSchema = new Schema({ total: { derived: { compute: add, sources: ["$root.a"] }, type: Number } }, { _id: false });
    const schema = new Schema({ a: Number, items: [itemSchema] });
    expect(() => schema.plugin(derivedPaths)).toThrow(/inside a document array/);
  });
});
