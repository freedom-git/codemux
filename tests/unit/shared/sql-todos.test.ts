import { describe, expect, it } from "vitest";
import {
  applySqlTodosMutation,
  extractStructuredTodos,
  isSqlTodosMutation,
  serializeTodoEntries,
  type StoredTodoEntry,
} from "../../../shared/sql-todos";

describe("sql-todos", () => {
  describe("isSqlTodosMutation", () => {
    it("matches INSERT, UPDATE, and DELETE on todos table while ignoring SELECT", () => {
      expect(isSqlTodosMutation("INSERT INTO todos (id, title, description) VALUES ('a', 'Build', 'desc')")).toBe(true);
      expect(isSqlTodosMutation("INSERT OR REPLACE INTO todos (id, title, description, status) VALUES ('a', 'Build', 'desc', 'in_progress')")).toBe(true);
      expect(isSqlTodosMutation("UPDATE todos SET status = 'done' WHERE id = 'a'")).toBe(true);
      expect(isSqlTodosMutation("DELETE FROM todos;")).toBe(true);
      expect(isSqlTodosMutation("SELECT * FROM todos WHERE status = 'pending'")).toBe(false);
    });
  });

  describe("applySqlTodosMutation", () => {
    it("executes multi-statement DELETE, 4-column INSERT, and UPDATE in order", () => {
      const store = new Map<string, StoredTodoEntry>();
      applySqlTodosMutation(
        store,
        "INSERT INTO todos (id, title, description) VALUES ('old', 'Old item', 'desc');",
      );
      expect(serializeTodoEntries(store)).toEqual([
        { content: "Old item", status: "pending" },
      ]);

      applySqlTodosMutation(
        store,
        `DELETE FROM todos;
INSERT INTO todos (id, title, description, status) VALUES
  ('backend-types', 'Define workspace types', 'Add UnifiedSessionWorkspaceState', 'done'),
  ('ui-bar', 'Build SessionWorkspaceBar''s pills', 'Render tasks and files pills; keep layout crisp', 'in_progress'),
  ('tests', 'Add unit tests', 'Verify SQL parser and preview', 'pending');
UPDATE todos SET status = 'done' WHERE id = 'ui-bar';
UPDATE todos SET status = 'in_progress' WHERE id IN ('tests');`,
      );

      expect(serializeTodoEntries(store)).toEqual([
        { content: "Define workspace types", status: "completed" },
        { content: "Build SessionWorkspaceBar's pills", status: "completed" },
        { content: "Add unit tests", status: "in_progress" },
      ]);
    });
  });

  describe("extractStructuredTodos", () => {
    it("normalizes todos and todoList arrays across engine formats", () => {
      expect(
        extractStructuredTodos({
          todoList: [
            { id: 1, title: "Inspect protocol", status: "completed" },
            { id: 2, title: "Wire preview modal", status: "in-progress" },
            { id: 3, description: "Capture screenshots", status: "not-started" },
          ],
        }),
      ).toEqual([
        { content: "Inspect protocol", status: "completed" },
        { content: "Wire preview modal", status: "in_progress" },
        { content: "Capture screenshots", status: "pending" },
      ]);
    });
  });
});
