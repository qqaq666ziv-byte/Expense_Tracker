import { describe, expect, it } from "vitest";
import type { Transaction } from "../domain/model";
import {
  TUTORIAL_RECORD_NOTE,
  parseTutorialProgress,
  prepareTutorialResume,
  startTutorial,
  transitionTutorial,
  isTutorialTransaction,
} from "./tutorial";

const transaction = (note?: string): Transaction => ({
  id: "transaction",
  ownerId: "guest",
  version: 1,
  updatedAt: "2026-08-24T08:00:00.000Z",
  lastOperationId: "operation",
  amount: 100,
  type: "expense",
  categoryId: "food",
  categoryName: "餐飲",
  accountId: "cash",
  accountName: "現金",
  occurredAt: "2026-08-24 16:00",
  note,
});

describe("tutorial transaction marker", () => {
  it("recognizes only the reserved onboarding record note", () => {
    expect(isTutorialTransaction(transaction(TUTORIAL_RECORD_NOTE))).toBe(true);
    expect(isTutorialTransaction(transaction("早餐"))).toBe(false);
    expect(isTutorialTransaction(transaction())).toBe(false);
  });
});

describe("interactive tutorial progress", () => {
  it("only advances the first-record chapter through real product events", () => {
    let progress = startTutorial("first-record");
    expect(progress.step).toBe("amount");

    progress = transitionTutorial(progress, { type: "amount-ready" });
    expect(progress.step).toBe("category");
    progress = transitionTutorial(progress, { type: "category-selected" });
    expect(progress.step).toBe("account");
    progress = transitionTutorial(progress, { type: "account-selected" });
    expect(progress.step).toBe("create");
    progress = transitionTutorial(progress, {
      type: "transaction-created",
      recordId: "tutorial-record",
    });
    expect(progress).toMatchObject({
      step: "locate",
      recordId: "tutorial-record",
    });
    progress = transitionTutorial(progress, { type: "continue" });
    expect(progress.step).toBe("open-edit");
    progress = transitionTutorial(progress, { type: "edit-opened" });
    expect(progress.step).toBe("edit-amount");
    progress = transitionTutorial(progress, { type: "amount-changed" });
    expect(progress.step).toBe("save-edit");
    progress = transitionTutorial(progress, { type: "transaction-updated" });
    expect(progress.step).toBe("delete");
    progress = transitionTutorial(progress, { type: "transaction-deleted" });
    expect(progress.step).toBe("cleanup-confirmed");
    progress = transitionTutorial(progress, { type: "continue" });
    expect(progress).toMatchObject({ status: "completed", step: "complete" });
  });

  it("pauses and resumes at the same operation instead of marking onboarding done", () => {
    const progress = transitionTutorial(startTutorial("full"), {
      type: "pause",
    });
    expect(progress).toMatchObject({ status: "paused", step: "welcome" });
    expect(transitionTutorial(progress, { type: "resume" })).toMatchObject({
      status: "active",
      step: "welcome",
    });
  });

  it("allows a single contextual chapter to be rerun independently", () => {
    let progress = startTutorial("assets");
    expect(progress).toMatchObject({ status: "active", step: "tour-assets" });
    progress = transitionTutorial(progress, { type: "continue" });
    expect(progress).toMatchObject({ status: "completed", step: "complete" });
  });

  it("restores valid progress but rejects stale or malformed local preferences", () => {
    const progress = startTutorial("snapshot");
    expect(parseTutorialProgress(JSON.stringify(progress))).toEqual(progress);
    expect(parseTutorialProgress('{"version":1,"step":"amount"}')).toBeNull();
    expect(parseTutorialProgress("not-json")).toBeNull();
  });

  it("resumes from a safe real-UI step when form state was lost on reload", () => {
    const pausedDraft = transitionTutorial(startTutorial("first-record"), {
      type: "pause",
    });
    expect(prepareTutorialResume(pausedDraft, "missing")).toMatchObject({
      status: "active",
      step: "amount",
    });

    const pausedEdit = {
      ...startTutorial("first-record"),
      status: "paused" as const,
      step: "save-edit" as const,
      recordId: "tutorial-record",
    };
    expect(prepareTutorialResume(pausedEdit, "active")).toMatchObject({
      status: "active",
      step: "open-edit",
      recordId: "tutorial-record",
    });
    expect(prepareTutorialResume(pausedEdit, "deleted")).toMatchObject({
      status: "active",
      step: "cleanup-confirmed",
    });
  });
});
