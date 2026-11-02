// "Start here" checklist shown on the teacher dashboard until every step is
// done. Pure computation only: the dashboard maps step ids to titles, bodies
// and action links. Counts come from the dashboard's existing summary queries.

export type StartStepId = "assessment" | "lesson" | "students" | "release" | "published";

export type StartChecklistStep = {
  id: StartStepId;
  done: boolean;
};

export type StartChecklist = {
  steps: StartChecklistStep[];
  completed: number;
  allDone: boolean;
};

function build(steps: StartChecklistStep[]): StartChecklist {
  const completed = steps.filter((s) => s.done).length;
  return { steps, completed, allDone: completed === steps.length };
}

// School teacher: create an assessment, add students, release results.
export function buildStartChecklist(input: {
  assessmentsCount: number;
  studentsCount: number;
  hasReleased: boolean;
}): StartChecklist {
  return build([
    { id: "assessment", done: input.assessmentsCount > 0 },
    { id: "students", done: input.studentsCount > 0 },
    { id: "release", done: input.hasReleased },
  ]);
}

// Tutor: create a lesson, enroll students, publish an assessment.
export function buildTutorStartChecklist(input: {
  lessonsCount: number;
  studentsCount: number;
  hasPublished: boolean;
}): StartChecklist {
  return build([
    { id: "lesson", done: input.lessonsCount > 0 },
    { id: "students", done: input.studentsCount > 0 },
    { id: "published", done: input.hasPublished },
  ]);
}
