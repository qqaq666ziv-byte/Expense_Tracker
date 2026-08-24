export {
  TUTORIAL_RECORD_NOTE,
  isFinancialTransaction,
  isTutorialTransaction,
} from "../domain/tutorialRecord";

export const TUTORIAL_STORAGE_KEY = "shiba-finance:onboarding:v2";

export type TutorialChapter =
  | "full"
  | "first-record"
  | "snapshot"
  | "assets"
  | "insights"
  | "planning"
  | "sync";

export type TutorialStep =
  | "welcome"
  | "amount"
  | "category"
  | "account"
  | "create"
  | "locate"
  | "open-edit"
  | "edit-amount"
  | "save-edit"
  | "delete"
  | "cleanup-confirmed"
  | "snapshot-summary"
  | "snapshot-category"
  | "snapshot-detail"
  | "tour-assets"
  | "tour-insights"
  | "tour-planning"
  | "tour-sync"
  | "complete";

export interface TutorialProgress {
  version: 2;
  chapter: TutorialChapter;
  status: "active" | "paused" | "completed" | "skipped";
  step: TutorialStep;
  recordId?: string;
}

export type TutorialEvent =
  | { type: "continue" }
  | { type: "amount-ready" }
  | { type: "category-selected" }
  | { type: "account-selected" }
  | { type: "transaction-created"; recordId: string }
  | { type: "edit-opened" }
  | { type: "amount-changed" }
  | { type: "transaction-updated" }
  | { type: "transaction-deleted" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "skip" };

const CHAPTER_START: Record<TutorialChapter, TutorialStep> = {
  full: "welcome",
  "first-record": "amount",
  snapshot: "snapshot-summary",
  assets: "tour-assets",
  insights: "tour-insights",
  planning: "tour-planning",
  sync: "tour-sync",
};

const TUTORIAL_STEPS = new Set<TutorialStep>([
  "welcome",
  "amount",
  "category",
  "account",
  "create",
  "locate",
  "open-edit",
  "edit-amount",
  "save-edit",
  "delete",
  "cleanup-confirmed",
  "snapshot-summary",
  "snapshot-category",
  "snapshot-detail",
  "tour-assets",
  "tour-insights",
  "tour-planning",
  "tour-sync",
  "complete",
]);

export function parseTutorialProgress(
  value: string | null,
): TutorialProgress | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Partial<TutorialProgress>;
    const validStatus =
      candidate.status === "active" ||
      candidate.status === "paused" ||
      candidate.status === "completed" ||
      candidate.status === "skipped";
    if (
      candidate.version !== 2 ||
      !validStatus ||
      !candidate.chapter ||
      !(candidate.chapter in CHAPTER_START) ||
      !candidate.step ||
      !TUTORIAL_STEPS.has(candidate.step) ||
      (candidate.recordId !== undefined &&
        typeof candidate.recordId !== "string")
    ) {
      return null;
    }
    return candidate as TutorialProgress;
  } catch {
    return null;
  }
}

export function startTutorial(chapter: TutorialChapter): TutorialProgress {
  return {
    version: 2,
    chapter,
    status: "active",
    step: CHAPTER_START[chapter],
  };
}

export function prepareTutorialResume(
  progress: TutorialProgress,
  recordState: "active" | "deleted" | "missing",
): TutorialProgress {
  let step = progress.step;
  const recordDependentSteps = new Set<TutorialStep>([
    "locate",
    "open-edit",
    "edit-amount",
    "save-edit",
    "delete",
  ]);

  if (recordDependentSteps.has(step)) {
    if (recordState === "deleted") step = "cleanup-confirmed";
    else if (recordState === "missing") step = "amount";
    else if (step === "edit-amount" || step === "save-edit") step = "open-edit";
  } else if (
    recordState === "missing" &&
    ["category", "account", "create"].includes(step)
  ) {
    // Form draft state is intentionally not persisted as financial data.
    step = "amount";
  }

  return { ...progress, status: "active", step };
}

const move = (
  progress: TutorialProgress,
  step: TutorialStep,
): TutorialProgress => ({ ...progress, step });

const finish = (progress: TutorialProgress): TutorialProgress => ({
  ...progress,
  status: "completed",
  step: "complete",
});

/** Pure state machine: only observable product events can unlock CRUD steps. */
export function transitionTutorial(
  progress: TutorialProgress,
  event: TutorialEvent,
): TutorialProgress {
  if (event.type === "resume" && progress.status === "paused") {
    return { ...progress, status: "active" };
  }
  if (progress.status !== "active") return progress;
  if (event.type === "pause") return { ...progress, status: "paused" };
  if (event.type === "skip") return { ...progress, status: "skipped" };

  switch (progress.step) {
    case "welcome":
      return event.type === "continue" ? move(progress, "amount") : progress;
    case "amount":
      return event.type === "amount-ready"
        ? move(progress, "category")
        : progress;
    case "category":
      return event.type === "category-selected"
        ? move(progress, "account")
        : progress;
    case "account":
      return event.type === "account-selected"
        ? move(progress, "create")
        : progress;
    case "create":
      return event.type === "transaction-created"
        ? { ...progress, step: "locate", recordId: event.recordId }
        : progress;
    case "locate":
      return event.type === "continue" ? move(progress, "open-edit") : progress;
    case "open-edit":
      return event.type === "edit-opened"
        ? move(progress, "edit-amount")
        : progress;
    case "edit-amount":
      return event.type === "amount-changed"
        ? move(progress, "save-edit")
        : progress;
    case "save-edit":
      return event.type === "transaction-updated"
        ? move(progress, "delete")
        : progress;
    case "delete":
      return event.type === "transaction-deleted"
        ? move(progress, "cleanup-confirmed")
        : progress;
    case "cleanup-confirmed":
      if (event.type !== "continue") return progress;
      return progress.chapter === "full"
        ? move(progress, "snapshot-summary")
        : finish(progress);
    case "snapshot-summary":
      return event.type === "continue"
        ? move(progress, "snapshot-category")
        : progress;
    case "snapshot-category":
      return event.type === "continue"
        ? move(progress, "snapshot-detail")
        : progress;
    case "snapshot-detail":
      if (event.type !== "continue") return progress;
      return progress.chapter === "full"
        ? move(progress, "tour-assets")
        : finish(progress);
    case "tour-assets":
      if (event.type !== "continue") return progress;
      return progress.chapter === "full"
        ? move(progress, "tour-insights")
        : finish(progress);
    case "tour-insights":
      if (event.type !== "continue") return progress;
      return progress.chapter === "full"
        ? move(progress, "tour-planning")
        : finish(progress);
    case "tour-planning":
      if (event.type !== "continue") return progress;
      return progress.chapter === "full"
        ? move(progress, "tour-sync")
        : finish(progress);
    case "tour-sync":
      return event.type === "continue" ? finish(progress) : progress;
    case "complete":
      return progress;
  }
}
