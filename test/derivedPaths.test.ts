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

describe("$root sources inside the target's own container", () => {
  // Like a statement summary: `summary.incentives.commission` derives from `$root.` paths that also live under `summary`
  function summaryModel(summaryOptions: { default?: unknown } = { default: {} }) {
    const incentivesSchema = new Schema(
      {
        commission: {
          default: 0,
          derived: {
            compute: (v: Record<"$root.rate" | "$root.summary.claims.total" | "$root.summary.collected", unknown>) =>
              (Number(v["$root.summary.collected"] ?? 0) - Number(v["$root.summary.claims.total"] ?? 0)) * Number(v["$root.rate"] ?? 0),
            sources: ["$root.rate", "$root.summary.claims.total", "$root.summary.collected"],
          },
          type: Number,
        },
      },
      { _id: false }
    );
    const claimsSchema = new Schema({ refund: Number, total: { default: 0, derived: { compute: add, sources: ["refund"] }, immutable: true, type: Number } }, { _id: false });
    const summarySchema = new Schema(
      { claims: { default: {}, type: claimsSchema }, collected: Number, incentives: { default: {}, type: incentivesSchema } },
      { _id: false }
    );
    const schema = new Schema({ rate: Number, summary: { ...summaryOptions, type: summarySchema } });
    schema.plugin(derivedPaths);
    return uniqueModel(schema);
  }

  const input = { rate: 0.5, summary: { claims: { refund: 20 }, collected: 100 } };

  for (const [label, options] of [
    ["with default: {}", { default: {} }],
    ["without a default", {}],
  ] as const) {
    it(`derives the value at construction and validates (${label})`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const doc: any = new (summaryModel(options))(input);
      expect(doc.summary.claims.total).toBe(20);
      expect(doc.summary.incentives.commission).toBe(40);
      await expect(doc.validate()).resolves.toBeUndefined();
      expect(doc.summary.incentives.commission).toBe(40);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  }

  it("constructs with the container from its default alone", async () => {
    const doc: any = new (summaryModel())({ rate: 0.5 });
    expect(doc.summary.incentives.commission).toBe(0);
    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.summary.incentives.commission).toBe(0);
  });

  it("updates the value when a source changes on a new document", () => {
    const doc: any = new (summaryModel())(input);
    doc.summary.collected = 200;
    expect(doc.summary.incentives.commission).toBe(90);
    doc.rate = 1;
    expect(doc.summary.incentives.commission).toBe(180);
  });

  it("derives the value when the container or the target's own subdocument is replaced", async () => {
    const doc: any = new (summaryModel())(input);
    doc.summary = { claims: { refund: 10 }, collected: 50 };
    expect(doc.summary.incentives.commission).toBe(20);
    doc.set("summary", { collected: 30 });
    expect(doc.summary.incentives.commission).toBe(15);
    doc.summary.incentives = {};
    expect(doc.summary.incentives.commission).toBe(15);
    await doc.validate();
    expect(doc.summary.incentives.commission).toBe(15);
  });

  it("keeps a sibling target that chains off the container consistent when the container is assigned", async () => {
    const periodSchema = new Schema(
      {
        total: {
          default: 0,
          derived: {
            compute: (v: Record<string, unknown>) => Number(v["$root.summary.collected"] ?? 0) - Number(v["$root.summary.incentives.commission"] ?? 0),
            sources: ["$root.summary.collected", "$root.summary.incentives.commission"],
          },
          type: Number,
        },
      },
      { _id: false }
    );
    const incentivesSchema = new Schema(
      { commission: { default: 0, derived: { compute: (v: Record<string, unknown>) => Number(v["$root.summary.collected"] ?? 0) * 0.4, sources: ["$root.summary.collected"] }, type: Number } },
      { _id: false }
    );
    const summarySchema = new Schema({ collected: Number, incentives: { default: {}, type: incentivesSchema } }, { _id: false });
    const schema = new Schema({ periodTotal: { default: {}, type: periodSchema }, summary: { default: {}, type: summarySchema } });
    schema.plugin(derivedPaths);

    const doc: any = new (uniqueModel(schema))({ summary: { collected: 100 } });
    expect(doc.summary.incentives.commission).toBe(40);
    expect(doc.periodTotal.total).toBe(60);
    await doc.validate();
    expect(doc.summary.incentives.commission).toBe(40);
    expect(doc.periodTotal.total).toBe(60);
  });

  it("reads every source under an assigned container from the incoming value", () => {
    const bucket = () => new Schema({ amount: Number, total: { default: 0, derived: { compute: add, sources: ["amount"] }, type: Number } }, { _id: false });
    const periodSchema = new Schema(
      {
        total: {
          default: 0,
          derived: {
            compute: (v: Record<string, unknown>) => Number(v["$root.summary.collected.total"] ?? 0) - Number(v["$root.summary.claims.total"] ?? 0),
            sources: ["$root.summary.claims.total", "$root.summary.collected.total"],
          },
          type: Number,
        },
      },
      { _id: false }
    );
    const summarySchema = new Schema({ claims: { default: {}, type: bucket() }, collected: { default: {}, type: bucket() } }, { _id: false });
    const schema = new Schema({ periodTotal: { default: {}, type: periodSchema }, summary: { default: {}, type: summarySchema } });
    schema.plugin(derivedPaths);

    const doc: any = new (uniqueModel(schema))({ summary: { claims: { amount: 20 }, collected: { amount: 100 } } });
    expect(doc.periodTotal.total).toBe(80);
    doc.summary = { claims: { amount: 5 }, collected: { amount: 50 } };
    expect(doc.periodTotal.total).toBe(45);
  });

  it("keeps a stored immutable target when hydrating", async () => {
    const doc: any = summaryModel().hydrate({ rate: 0.5, summary: { claims: { refund: 20, total: 99 }, collected: 100, incentives: { commission: 7 } } });
    expect(doc.summary.claims.total).toBe(99);
    expect(doc.summary.incentives.commission).toBe(7);
    doc.summary.claims.refund = 30;
    expect(doc.summary.claims.total).toBe(99);
  });

  it("recomputes non-immutable targets on a loaded document", async () => {
    const doc: any = summaryModel().hydrate({ rate: 0.5, summary: { claims: { refund: 20, total: 20 }, collected: 100, incentives: { commission: 7 } } });
    doc.summary.collected = 200;
    expect(doc.summary.incentives.commission).toBe(90);
    doc.rate = 1;
    await doc.validate();
    expect(doc.summary.incentives.commission).toBe(180);
  });

  it("still creates a sibling target container that has no default when a source is assigned, as before", () => {
    const periodSchema = new Schema(
      { total: { derived: { compute: (v: Record<string, unknown>) => Number(v["$root.summary.collected"] ?? 0), sources: ["$root.summary.collected"] }, type: Number } },
      { _id: false }
    );
    const schema = new Schema({ periodTotal: periodSchema, summary: { default: {}, type: new Schema({ collected: Number }, { _id: false }) } });
    schema.plugin(derivedPaths);
    const Model = uniqueModel(schema);

    expect((new Model({ summary: { collected: 100 } }) as any).periodTotal?.total).toBe(100);
    const doc: any = new Model();
    doc.summary.collected = 50;
    expect(doc.periodTotal?.total).toBe(50);
  });

  it("still creates a public derivedPath target's container that has no default", () => {
    const schema = new Schema({ a: Number, nested: new Schema({ total: Number }, { _id: false }) });
    schema.plugin(derivedPath, { compute: (v: Record<"a", unknown>) => Number(v.a ?? 0) * 2, sources: ["a"], target: "nested.total" });
    const doc: any = new (uniqueModel(schema))({ a: 5 });
    expect(doc.nested?.total).toBe(10);
    doc.a = 7;
    expect(doc.nested?.total).toBe(14);
  });
});
