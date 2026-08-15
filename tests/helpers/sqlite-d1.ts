import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export function createMigratedD1(): { database: D1Database; close(): void } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(resolve("drizzle")).filter((value) => value.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(resolve("drizzle", file), "utf8"));
  }
  const database = new SqliteD1Database(sqlite);
  return { database: database as unknown as D1Database, close: () => sqlite.close() };
}

class SqliteD1Database {
  readonly #sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync) {
    this.#sqlite = sqlite;
  }

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.#sqlite.prepare(query));
  }

  async batch(statements: SqliteD1Statement[]) {
    this.#sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.#sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.#sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

class SqliteD1Statement {
  readonly #statement: StatementSync;
  #bindings: unknown[] = [];

  constructor(statement: StatementSync) {
    this.#statement = statement;
  }

  bind(...values: unknown[]): SqliteD1Statement {
    this.#bindings = values;
    return this;
  }

  async run() {
    return this.runSync();
  }

  runSync() {
    const result = this.#statement.run(...this.#bindings as Parameters<StatementSync["run"]>);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  async first<T>(): Promise<T | null> {
    return (this.#statement.get(...this.#bindings as Parameters<StatementSync["get"]>) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.#statement.all(...this.#bindings as Parameters<StatementSync["all"]>) as T[] };
  }
}
