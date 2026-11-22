import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeContextMenuPosition,
  createContextMenuTrigger,
  type ContextMenuItem,
} from "../../../../src/components/context-menu-trigger";
import {
  buildQuestionAnswers,
  canSubmitQuestions,
  findMissingRequiredQuestionIndex,
} from "../../../../src/components/input-area-context";

const sampleItems: ContextMenuItem[] = [
  { id: "rename", label: "Rename", onSelect: vi.fn() },
  { id: "delete", label: "Delete", danger: true, onSelect: vi.fn() },
];

afterEach(() => {
  vi.useRealTimers();
});

describe("createContextMenuTrigger", () => {
  it("opens the menu at cursor coordinates on desktop right-click and prevents native menu", () => {
    const openMenu = vi.fn();
    const trigger = createContextMenuTrigger(() => ({ title: "Session A", items: sampleItems }), openMenu);
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    trigger.onContextMenu({
      clientX: 140,
      clientY: 220,
      target: null,
      currentTarget: null,
      preventDefault,
      stopPropagation,
    } as unknown as MouseEvent);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(openMenu).toHaveBeenCalledExactlyOnceWith({
      x: 140,
      y: 220,
      title: "Session A",
      items: sampleItems,
    });
  });

  it("opens the menu after a 450ms touch hold and suppresses the synthetic release click", () => {
    vi.useFakeTimers();
    const openMenu = vi.fn();
    const trigger = createContextMenuTrigger(() => ({ title: "美签", items: sampleItems }), openMenu);

    trigger.onTouchStart({
      touches: [{ clientX: 88, clientY: 310 }],
      target: null,
      currentTarget: null,
    } as unknown as TouchEvent);

    vi.advanceTimersByTime(449);
    expect(openMenu).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(openMenu).toHaveBeenCalledExactlyOnceWith({
      x: 88,
      y: 310,
      title: "美签",
      items: sampleItems,
    });

    const endPrevent = vi.fn();
    const endStop = vi.fn();
    trigger.onTouchEnd({
      cancelable: true,
      preventDefault: endPrevent,
      stopPropagation: endStop,
    } as unknown as TouchEvent);
    expect(endPrevent).toHaveBeenCalledOnce();
    expect(endStop).toHaveBeenCalledOnce();

    const clickPrevent = vi.fn();
    const clickStop = vi.fn();
    trigger.onClickCapture({
      preventDefault: clickPrevent,
      stopPropagation: clickStop,
    } as unknown as MouseEvent);
    expect(clickPrevent).toHaveBeenCalledOnce();
    expect(clickStop).toHaveBeenCalledOnce();
  });

  it("cancels long-press when the finger moves past the scroll threshold", () => {
    vi.useFakeTimers();
    const openMenu = vi.fn();
    const trigger = createContextMenuTrigger(() => ({ title: "美签", items: sampleItems }), openMenu);

    trigger.onTouchStart({
      touches: [{ clientX: 100, clientY: 200 }],
      target: null,
      currentTarget: null,
    } as unknown as TouchEvent);

    // Scrolling 15px vertically cancels the long-press timer.
    trigger.onTouchMove({
      touches: [{ clientX: 100, clientY: 215 }],
    } as unknown as TouchEvent);

    vi.advanceTimersByTime(500);
    expect(openMenu).not.toHaveBeenCalled();

    const clickPrevent = vi.fn();
    trigger.onClickCapture({
      preventDefault: clickPrevent,
      stopPropagation: vi.fn(),
    } as unknown as MouseEvent);
    expect(clickPrevent).not.toHaveBeenCalled();
  });

  it("clamps context menu inside mobile viewport edges and flips upward near bottom", () => {
    expect(computeContextMenuPosition(
      { x: 370, y: 810 },
      { width: 220, height: 180 },
      { width: 390, height: 844 },
    )).toEqual({ left: 158, top: 622 });
  });
});

describe("question submission helpers", () => {
  it("skips empty optional fields, sends single custom value on single-select, and detects missing required questions", () => {
    const questions = [
      { question: "Q1", header: "H1", options: [{ label: "A", description: "" }], multiple: false, required: true, custom: true },
      { question: "Q2", header: "H2", options: [{ label: "X", description: "" }], multiple: false, required: false, custom: false },
      { question: "Q3", header: "H3", options: [{ label: "M1", description: "" }], multiple: true, required: false, custom: true },
    ];

    expect(findMissingRequiredQuestionIndex(questions, [[], ["X"], []], ["", "", ""])).toBe(0);
    expect(findMissingRequiredQuestionIndex(questions, [["A"], [], ["M1"]], ["custom-override", "", "extra"])).toBe(-1);
    expect(buildQuestionAnswers(questions, [["A"], [], ["M1"]], ["custom-override", "", "extra"])).toEqual([
      ["custom-override"],
      [],
      ["M1", "extra"],
    ]);
    expect(canSubmitQuestions(
      questions.map((q) => ({ ...q, required: false })),
      [[], [], []],
      ["", "", ""],
    )).toBe(true);
  });
});

