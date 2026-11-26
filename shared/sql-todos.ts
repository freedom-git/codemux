export type TodoItemStatus = "pending" | "in_progress" | "completed";

export interface StoredTodoEntry {
  id: string;
  title: string;
  status: string;
}

export interface NormalizedTodoItem {
  content: string;
  status: TodoItemStatus;
}

export function normalizeTodoStatus(raw: unknown): TodoItemStatus {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "completed" || s === "done") return "completed";
  if (s === "in_progress" || s === "in-progress" || s === "active" || s === "running") {
    return "in_progress";
  }
  return "pending";
}

export function isSqlTodosMutation(sql: string): boolean {
  return /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+todos\b/i.test(sql);
}

/** Split SQL text on semicolons outside single-quoted string literals. */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (inString && sql[i + 1] === "'") {
        i++;
      } else {
        inString = !inString;
      }
    } else if (ch === ";" && !inString) {
      const stmt = sql.slice(start, i).trim();
      if (stmt) statements.push(stmt);
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

/** Parse parenthesized value tuples like ('a', 'b', 'c'), ('d', 'e', 'f'). */
function parseSqlValueTuples(valuesPart: string): Array<Array<string | null>> {
  const tuples: Array<Array<string | null>> = [];
  let i = 0;
  const n = valuesPart.length;

  while (i < n) {
    while (i < n && valuesPart[i] !== "(") i++;
    if (i >= n) break;
    i++; // skip '('
    const row: Array<string | null> = [];
    while (i < n) {
      while (i < n && /\s/.test(valuesPart[i])) i++;
      if (i >= n) break;
      if (valuesPart[i] === ")") {
        i++;
        break;
      }
      if (valuesPart[i] === "'") {
        i++;
        let val = "";
        while (i < n) {
          if (valuesPart[i] === "'") {
            if (valuesPart[i + 1] === "'") {
              val += "'";
              i += 2;
              continue;
            }
            i++;
            break;
          }
          val += valuesPart[i++];
        }
        row.push(val);
      } else {
        let raw = "";
        while (i < n && valuesPart[i] !== "," && valuesPart[i] !== ")") {
          raw += valuesPart[i++];
        }
        const trimmed = raw.trim();
        row.push(/^null$/i.test(trimmed) ? null : trimmed);
      }
      while (i < n && /\s/.test(valuesPart[i])) i++;
      if (valuesPart[i] === ",") i++;
    }
    if (row.length > 0) tuples.push(row);
  }
  return tuples;
}

/**
 * Apply SQLite `todos` table mutations (DELETE / INSERT / UPDATE) in statement order.
 * Supports both 3-column `(id, title, status)` and 4-column `(id, title, description, status)`
 * or `(id, title, description)` schemas used by Copilot CLI.
 */
export function applySqlTodosMutation(
  todos: Map<string, StoredTodoEntry>,
  sql: string,
): boolean {
  if (!sql || !isSqlTodosMutation(sql)) return false;
  let mutated = false;

  for (const stmt of splitSqlStatements(sql)) {
    const deleteMatch = /^DELETE\s+FROM\s+todos(?:\s+WHERE\s+id\s+(?:IN\s*\(([^)]+)\)|=\s*'((?:''|[^'])*)'))?\s*$/i.exec(stmt);
    if (deleteMatch) {
      const inList = deleteMatch[1];
      const singleId = deleteMatch[2]?.replace(/''/g, "'");
      if (inList) {
        for (const m of inList.matchAll(/'((?:''|[^'])*)'/g)) {
          todos.delete(m[1].replace(/''/g, "'"));
        }
      } else if (singleId !== undefined) {
        todos.delete(singleId);
      } else {
        todos.clear();
      }
      mutated = true;
      continue;
    }

    const insertMatch = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+todos\s*(?:\(([^)]+)\))?\s*VALUES\s*([\s\S]+)$/i.exec(stmt);
    if (insertMatch) {
      const cols = insertMatch[1]
        ? insertMatch[1].split(",").map((c) => c.trim().replace(/^["`[]|["`\]]$/g, "").toLowerCase())
        : undefined;
      const rows = parseSqlValueTuples(insertMatch[2]);
      for (const row of rows) {
        let id: string | null = null;
        let title: string | null = null;
        let status: string | null = null;
        if (cols) {
          const idIdx = cols.indexOf("id");
          const titleIdx = cols.indexOf("title");
          const statusIdx = cols.indexOf("status");
          id = idIdx >= 0 ? (row[idIdx] ?? null) : (row[0] ?? null);
          title = titleIdx >= 0 ? (row[titleIdx] ?? null) : (row[1] ?? null);
          status = statusIdx >= 0 ? (row[statusIdx] ?? "pending") : "pending";
        } else if (row.length === 3) {
          [id, title, status] = [row[0], row[1], row[2] ?? "pending"];
        } else {
          [id, title, status] = [row[0], row[1], row[3] ?? "pending"];
        }
        if (id && title) {
          todos.set(id, { id, title, status: status || "pending" });
          mutated = true;
        }
      }
      continue;
    }

    const updateMatch = /^UPDATE\s+todos\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i.exec(stmt);
    if (updateMatch) {
      const setClause = updateMatch[1];
      const whereClause = updateMatch[2];
      const statusMatch = /\bstatus\s*=\s*'((?:''|[^'])*)'/i.exec(setClause);
      const titleMatch = /\btitle\s*=\s*'((?:''|[^'])*)'/i.exec(setClause);
      if (!statusMatch && !titleMatch) continue;
      const newStatus = statusMatch ? statusMatch[1].replace(/''/g, "'") : undefined;
      const newTitle = titleMatch ? titleMatch[1].replace(/''/g, "'") : undefined;

      let targetIds: string[] | null = null;
      if (whereClause) {
        const inMatch = /\bid\s+IN\s*\(([^)]+)\)/i.exec(whereClause);
        const eqMatch = /\bid\s*=\s*'((?:''|[^'])*)'/i.exec(whereClause);
        if (inMatch) {
          targetIds = [...inMatch[1].matchAll(/'((?:''|[^'])*)'/g)].map((m) => m[1].replace(/''/g, "'"));
        } else if (eqMatch) {
          targetIds = [eqMatch[1].replace(/''/g, "'")];
        } else {
          continue;
        }
      }

      const entries = targetIds
        ? targetIds.map((id) => todos.get(id)).filter((e): e is StoredTodoEntry => Boolean(e))
        : [...todos.values()];
      for (const entry of entries) {
        if (newStatus !== undefined) entry.status = newStatus;
        if (newTitle !== undefined) entry.title = newTitle;
        mutated = true;
      }
    }
  }

  return mutated;
}

export function serializeTodoEntries(todos: Map<string, StoredTodoEntry>): NormalizedTodoItem[] {
  return [...todos.values()].map((t) => ({
    content: t.title,
    status: normalizeTodoStatus(t.status),
  }));
}

/** Extract normalized todos from structured tool inputs (`TodoWrite` or VS Code `manage_todo_list`). */
export function extractStructuredTodos(toolInput: unknown): NormalizedTodoItem[] | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const obj = toolInput as Record<string, unknown>;
  const rawList = Array.isArray(obj.todos)
    ? obj.todos
    : Array.isArray(obj.todoList)
      ? obj.todoList
      : undefined;
  if (!rawList) return undefined;
  const result: NormalizedTodoItem[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const text = typeof rec.content === "string"
      ? rec.content
      : typeof rec.title === "string"
        ? rec.title
        : typeof rec.description === "string"
          ? rec.description
          : "";
    if (!text.trim()) continue;
    result.push({
      content: text,
      status: normalizeTodoStatus(rec.status),
    });
  }
  return result;
}
