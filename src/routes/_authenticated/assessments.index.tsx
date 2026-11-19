import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The standalone exams page was removed (user request 2026-11-19):
 * exams now live inside the groups page — created within a group and
 * visible only to that group's approved students. Old deep links
 * (dashboard cards, builder back buttons) land here and forward to
 * the groups page.
 */
export const Route = createFileRoute("/_authenticated/assessments/")({
  beforeLoad: () => {
    throw redirect({ to: "/groups" });
  },
});
