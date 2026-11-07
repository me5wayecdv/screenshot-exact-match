import { useQuery } from "@tanstack/react-query";
import { getMeD1 } from "@/server/d1-auth-fns";

export type Me = {
  id: string;
  email: string;
  role: "school_teacher" | "tutor" | "student" | "admin";
  fullName: string;
  joinCode: string | null;
};

/**
 * D1 session lookup (Phase 2): the session is resolved server-side
 * from the HttpOnly cookie by getMeD1. A failed lookup means "no
 * valid session" and the caller redirects to /auth; it must never
 * fall back to any client-side session store.
 */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async (): Promise<Me | null> => {
      try {
        return await getMeD1({});
      } catch {
        return null;
      }
    },
    staleTime: 60_000,
  });
}
