// Local, data-free Postgres compatibility rehearsal for the migration chain.
// PGlite is not a Supabase emulator: this validates SQL application and a
// small set of RPC invariants, not hosted RLS/Auth/Storage behavior. Keep
// staging tests in docs/launch-readiness.md as a separate release gate.
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const db = new PGlite();

function splitSqlStatements(sql) {
  const statements = [];
  let start = 0;
  let i = 0;
  let state = "normal";
  let dollarTag = "";
  let blockDepth = 0;

  while (i < sql.length) {
    const current = sql[i];
    const next = sql[i + 1];

    if (state === "normal") {
      if (current === "-" && next === "-") {
        state = "line-comment";
        i += 2;
        continue;
      }
      if (current === "/" && next === "*") {
        state = "block-comment";
        blockDepth = 1;
        i += 2;
        continue;
      }
      if (current === "'") {
        state = "single-quote";
        i += 1;
        continue;
      }
      if (current === '"') {
        state = "double-quote";
        i += 1;
        continue;
      }
      if (current === "$") {
        const match = sql.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
        if (match) {
          dollarTag = match[0];
          state = "dollar-quote";
          i += dollarTag.length;
          continue;
        }
      }
      if (current === ";") {
        const statement = sql.slice(start, i + 1).trim();
        if (statement) statements.push(statement);
        start = i + 1;
      }
      i += 1;
      continue;
    }

    if (state === "line-comment") {
      if (current === "\n") state = "normal";
      i += 1;
      continue;
    }
    if (state === "block-comment") {
      if (current === "/" && next === "*") {
        blockDepth += 1;
        i += 2;
        continue;
      }
      if (current === "*" && next === "/") {
        blockDepth -= 1;
        i += 2;
        if (blockDepth === 0) state = "normal";
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "single-quote") {
      if (current === "'" && next === "'") {
        i += 2;
        continue;
      }
      if (current === "'") {
        state = "normal";
        i += 1;
        continue;
      }
      if (current === "\\") {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "double-quote") {
      if (current === '"' && next === '"') {
        i += 2;
        continue;
      }
      if (current === '"') state = "normal";
      i += 1;
      continue;
    }
    if (state === "dollar-quote") {
      if (sql.startsWith(dollarTag, i)) {
        i += dollarTag.length;
        state = "normal";
        continue;
      }
      i += 1;
    }
  }

  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

async function executeSql(label, sql) {
  const statements = splitSqlStatements(sql);
  try {
    for (const statement of statements) await db.exec(statement);
  } catch (error) {
    throw new Error(`Migration rehearsal failed at ${label}: ${error.message}`, { cause: error });
  }
}

async function expectRow(label, query, predicate) {
  const result = await db.query(query);
  const row = result.rows[0];
  if (!row || !predicate(row)) {
    throw new Error(`${label} failed: ${JSON.stringify(row ?? null)}`);
  }
}

try {
  await executeSql(
    "Supabase compatibility bootstrap",
    `
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (
        id uuid PRIMARY KEY,
        raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
        email text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT NULL::uuid
      $$;
      CREATE SCHEMA storage;
      CREATE TABLE storage.buckets (
        id text PRIMARY KEY,
        name text NOT NULL,
        public boolean NOT NULL DEFAULT false,
        file_size_limit bigint,
        allowed_mime_types text[]
      );
      CREATE TABLE storage.objects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        bucket_id text NOT NULL REFERENCES storage.buckets(id),
        name text NOT NULL
      );
      CREATE FUNCTION storage.foldername(object_name text) RETURNS text[]
      LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(object_name, '/') $$;
    `,
  );

  const baseline = await readFile(join(root, "drizzle/migrations/0000_migration.sql"), "utf8");
  await executeSql("Drizzle baseline", baseline);

  const migrationDirectory = join(root, "supabase/migrations");
  const migrations = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const filename of migrations) {
    const sql = await readFile(join(migrationDirectory, filename), "utf8");
    await executeSql(filename, sql);
  }
  console.log(
    `PASS: applied baseline and ${migrations.length} Supabase migrations in disposable PGlite.`,
  );

  await db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;`);

  const teacher = "00000000-0000-0000-0000-000000000001";
  const student = "00000000-0000-0000-0000-000000000002";
  const tutor = "00000000-0000-0000-0000-000000000003";
  const attemptedAdmin = "00000000-0000-0000-0000-000000000004";
  await db.exec(`
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('${teacher}', 'teacher@example.invalid', '{"role":"school_teacher","full_name":"Test Teacher"}'),
      ('${student}', 'student@example.invalid', '{"role":"student","full_name":"Test Student","parent_phone":"+201012345678"}'),
      ('${tutor}', 'tutor@example.invalid', '{"role":"tutor","full_name":"Test Tutor"}'),
      ('${attemptedAdmin}', 'attempted-admin@example.invalid', '{"role":"admin","full_name":"Test Admin"}');
  `);
  const signup = await db.query(`
    SELECT ur.user_id, ur.role::text AS role, p.join_code, p.parent_phone
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.user_id IN ('${teacher}', '${student}', '${tutor}', '${attemptedAdmin}')
    ORDER BY ur.user_id
  `);
  const signupRows = new Map(signup.rows.map((row) => [row.user_id, row]));
  for (const userId of [teacher, tutor]) {
    const code = signupRows.get(userId)?.join_code;
    if (typeof code !== "string" || !/^[A-F0-9]{12}$/.test(code)) {
      throw new Error(`Signup failed to create a valid 12-character code for ${userId}.`);
    }
  }
  if (signupRows.get(student)?.parent_phone !== "+201012345678") {
    throw new Error("Signup failed to preserve a valid Egyptian parent phone.");
  }
  if (signupRows.get(attemptedAdmin)?.role !== "student") {
    throw new Error("Signup metadata incorrectly granted the admin role.");
  }
  console.log(
    "PASS: synthetic signup checks for teacher/tutor codes, phone validation, and admin-role rejection.",
  );

  const assessmentA = "10000000-0000-0000-0000-000000000001";
  const assessmentB = "10000000-0000-0000-0000-000000000002";
  const questionOne = "20000000-0000-0000-0000-000000000001";
  const questionTwo = "20000000-0000-0000-0000-000000000002";
  const foreignQuestion = "20000000-0000-0000-0000-000000000003";
  const releasedSubmission = "30000000-0000-0000-0000-000000000001";
  const reviewSubmission = "30000000-0000-0000-0000-000000000002";
  const reviewAnswer = "40000000-0000-0000-0000-000000000001";
  await db.exec(`
    INSERT INTO public.assessments (id, teacher_id, title, status) VALUES
      ('${assessmentA}', '${teacher}', 'Canonical marks test A', 'published'),
      ('${assessmentB}', '${teacher}', 'Canonical marks test B', 'published');
    INSERT INTO public.questions (id, assessment_id, position, type, prompt, marks) VALUES
      ('${questionOne}', '${assessmentA}', 1, 'written', 'Question 1', 4),
      ('${questionTwo}', '${assessmentA}', 2, 'written', 'Question 2', 6),
      ('${foreignQuestion}', '${assessmentB}', 1, 'written', 'Foreign question', 100);
    INSERT INTO public.submissions (id, assessment_id, student_id, status, attempt_number) VALUES
      ('${releasedSubmission}', '${assessmentA}', '${student}', 'approved', 1),
      ('${reviewSubmission}', '${assessmentA}', '${student}', 'awaiting_review', 2);
    INSERT INTO public.answers (id, submission_id, question_id, response, max_marks, final_score, review_status) VALUES
      ('40000000-0000-0000-0000-000000000002', '${releasedSubmission}', '${questionOne}', 'answer 1', 4, 3, 'approved'),
      ('40000000-0000-0000-0000-000000000003', '${releasedSubmission}', '${questionTwo}', 'answer 2', 6, 5, 'approved'),
      ('40000000-0000-0000-0000-000000000004', '${releasedSubmission}', '${foreignQuestion}', 'legacy cross-assessment row', 100, 100, 'approved'),
      ('${reviewAnswer}', '${reviewSubmission}', '${questionOne}', 'needs review', 999, null, 'not_graded');
    SELECT set_config('request.jwt.claim.sub', '${teacher}', false);
  `);

  await db.query(`SELECT public.release_submission('${releasedSubmission}', 'synthetic test')`);
  await expectRow(
    "canonical release totals",
    `SELECT final_score, total_possible, status FROM public.submissions WHERE id = '${releasedSubmission}'`,
    (row) =>
      Number(row.final_score) === 8 &&
      Number(row.total_possible) === 10 &&
      row.status === "released",
  );

  let outOfRangeRejected = false;
  try {
    await db.query(
      `SELECT public.review_answer('${reviewAnswer}', 5, 'synthetic test', 'approve')`,
    );
  } catch (error) {
    outOfRangeRejected = String(error.message).includes("score_out_of_range");
  }
  if (!outOfRangeRejected)
    throw new Error("Review RPC did not enforce question-owned maximum marks.");

  await db.query(
    `SELECT public.review_answer('${reviewAnswer}', 3.5, 'synthetic test', 'approve')`,
  );
  await expectRow(
    "canonical review marks",
    `SELECT max_marks, final_score FROM public.answers WHERE id = '${reviewAnswer}'`,
    (row) => Number(row.max_marks) === 4 && Number(row.final_score) === 3.5,
  );
  console.log(
    "PASS: synthetic grading checks ignore foreign-question rows and enforce question-owned marks.",
  );
} finally {
  await db.close();
}
