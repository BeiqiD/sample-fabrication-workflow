import { describe, expect, it } from "vitest";
import { resolveRunInitialState } from "./run-start";

describe("process-run initial substrate confirmation", () => {
  it("uses the process-template start automatically for the first run", () => {
    expect(resolveRunInitialState({
      hasPreviousRun: false,
      requestedHashProvided: false,
      requestedHash: null,
      templateHash: "template-state",
      sampleCurrentHash: null,
    })).toEqual({ ok: true, hash: "template-state" });
  });

  it("requires an explicit choice for an additional run", () => {
    expect(resolveRunInitialState({
      hasPreviousRun: true,
      requestedHashProvided: false,
      requestedHash: null,
      templateHash: "template-state",
      sampleCurrentHash: "sample-state",
    })).toEqual({ ok: false, reason: "confirmation_required" });
  });

  it("also requires confirmation for a split child with an inherited substrate", () => {
    expect(resolveRunInitialState({
      hasPreviousRun: false,
      requestedHashProvided: false,
      requestedHash: null,
      templateHash: "template-state",
      sampleCurrentHash: "inherited-parent-state",
    })).toEqual({ ok: false, reason: "confirmation_required" });
  });

  it("accepts either displayed structure and rejects an unrelated hash or an empty choice", () => {
    const base = {
      hasPreviousRun: true,
      requestedHashProvided: true,
      templateHash: "template-state",
      sampleCurrentHash: "sample-state",
    };
    expect(resolveRunInitialState({ ...base, requestedHash: "template-state" })).toEqual({ ok: true, hash: "template-state" });
    expect(resolveRunInitialState({ ...base, requestedHash: "sample-state" })).toEqual({ ok: true, hash: "sample-state" });
    expect(resolveRunInitialState({ ...base, requestedHash: "other" })).toEqual({ ok: false, reason: "invalid_choice" });
    expect(resolveRunInitialState({ ...base, requestedHash: null })).toEqual({ ok: false, reason: "invalid_choice" });
  });

  it("allows a confirmed empty structure only when neither source has a diagram", () => {
    expect(resolveRunInitialState({
      hasPreviousRun: true,
      requestedHashProvided: true,
      requestedHash: null,
      templateHash: null,
      sampleCurrentHash: null,
    })).toEqual({ ok: true, hash: null });
  });
});
