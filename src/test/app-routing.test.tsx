import { QueryClient } from "@tanstack/react-query";
import { createRouter, rootRouteId } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { routeTree } from "@/routeTree.gen";

// Match routes without running loaders or rendering: loaders may need a server or
// network the test run lacks, and jsdom never loads the stylesheets React waits on.
describe("App routing", () => {
  it("matches a page for / instead of falling back to not found", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    const matches = router.matchRoutes("/");

    expect(matches.at(-1)?.routeId).not.toBe(rootRouteId);
  });

  it("matches a page for /auth so the signup deep link resolves", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    const matches = router.matchRoutes("/auth", { mode: "signup" });

    expect(matches.at(-1)?.routeId).toBe("/auth");
  });

  // matchRoutes previews do not run validateSearch, so assert the /auth
  // search contract directly: only mode=signup survives, anything else
  // falls back to the default sign-in form.
  it.each([
    { label: "signup deep link", input: { mode: "signup" }, expected: { mode: "signup" } },
    { label: "an unknown mode", input: { mode: "bogus" }, expected: {} },
    { label: "no mode param", input: {}, expected: {} },
  ])("validates /auth search for $label", ({ input, expected }) => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    const validate = router.routesById["/auth"]?.options.validateSearch as (
      search: Record<string, unknown>,
    ) => unknown;

    expect(validate(input)).toEqual(expected);
  });

  it.each([
    "/grading",
    "/audit",
    "/analytics",
    "/reviews",
    "/terms",
    "/privacy",
    "/assessments",
    "/assessments/generate",
    "/assessments/take/123",
    "/reset-password",
    "/set-password",
  ])("matches a page for %s instead of falling back to not found", (path) => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    const matches = router.matchRoutes(path);

    expect(matches.at(-1)?.routeId).not.toBe(rootRouteId);
  });
});
