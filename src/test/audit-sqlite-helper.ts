import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { D1Database, D1Statement } from "@/server/d1-auth-store";
/** Exact committed SQL, transaction rollback, and D1's bind cap. */
export function auditDb() {
  const sql = new DatabaseSync(":memory:");
  for (const file of ["d1-auth.sql", "d1-schema.sql", "d1-security.sql"])
    sql.exec(readFileSync(`schema/${file}`, "utf8"));
  const db: D1Database = {
    prepare(query) {
      let values: SQLInputValue[] = [];
      const st: D1Statement = {
        bind(...v) {
          if (v.length > 100) throw new Error("D1_BOUND_LIMIT");
          values = v as SQLInputValue[];
          return st;
        },
        async first<T>() {
          return (sql.prepare(query).get(...values) ?? null) as T | null;
        },
        async all<T>() {
          return { results: sql.prepare(query).all(...values) as T[] };
        },
        async run() {
          return { meta: { changes: Number(sql.prepare(query).run(...values).changes) } };
        },
      };
      return st;
    },
    async batch(statements) {
      sql.exec("BEGIN");
      try {
        const out = [];
        for (const st of statements) out.push(await st.run());
        sql.exec("COMMIT");
        return out;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
  };
  sql.exec(`INSERT INTO auth_users(id,email,status) VALUES('t','t@example.invalid','approved'),('s','s@example.invalid','approved');
 INSERT INTO profiles(id) VALUES('t'),('s');
 INSERT INTO assessments(id,teacher_id,title,status) VALUES('e','t','test exam','published');
 INSERT INTO questions(id,assessment_id,prompt,type,marks,position) VALUES('q','e','original','written',10,0);
 INSERT INTO question_keys(question_id,correct_answer,rubric) VALUES('q','','rubric');`);
  return { db, sql };
}
