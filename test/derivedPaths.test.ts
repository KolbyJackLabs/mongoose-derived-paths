import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose, { Schema } from "mongoose";
import derivedPaths, { derivedPath } from "../src/index";

const add = (values: Record<string, unknown>) => Object.values(values).reduce<number>((sum, v) => sum + Number(v ?? 0), 0);
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
