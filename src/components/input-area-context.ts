import type { QuestionInfo, UnifiedQuestion } from "../types/unified";

export interface QuestionContextInfo {
  isMultiQuestion: boolean;
  current: number;
  total: number;
}

export function getQuestionContext(
  question: Pick<UnifiedQuestion, "questions">,
  pageIndex: number,
): QuestionContextInfo {
  return {
    isMultiQuestion: question.questions.length > 1,
    current: Math.min(pageIndex + 1, Math.max(question.questions.length, 1)),
    total: Math.max(question.questions.length, 1),
  };
}

export function isQuestionAnswered(
  question: QuestionInfo,
  selected: readonly string[] = [],
  rawCustom = "",
): boolean {
  const custom = question.preserveWhitespace ? rawCustom : rawCustom.trim();
  return selected.length > 0 || (question.custom !== false
    && (custom.length > 0 || question.allowEmptyAnswer === true));
}

export function canSubmitQuestions(
  questions: readonly QuestionInfo[],
  selections: readonly string[][],
  customInputs: readonly string[],
): boolean {
  if (questions.length > 0 && questions.every((q) => q.required === false)) {
    return true;
  }
  return questions.some((question, i) => isQuestionAnswered(question, selections[i], customInputs[i]));
}

export function findMissingRequiredQuestionIndex(
  questions: readonly QuestionInfo[],
  selections: readonly string[][],
  customInputs: readonly string[],
): number {
  return questions.findIndex((q, i) => q.required === true && !isQuestionAnswered(q, selections[i], customInputs[i]));
}

export function buildQuestionAnswers(
  questions: readonly QuestionInfo[],
  selections: readonly string[][],
  customInputs: readonly string[],
): string[][] {
  return questions.map((question, i) => {
    const selected = selections[i] || [];
    const raw = customInputs[i] ?? "";
    const custom = question.preserveWhitespace ? raw : raw.trim();
    if (custom) return question.multiple ? [...selected, custom] : [custom];
    if (question.custom !== false && question.allowEmptyAnswer && selected.length === 0) return [""];
    return [...selected];
  });
}
