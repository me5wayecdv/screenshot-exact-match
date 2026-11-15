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
 * from the HttpOnly cookie by getMeD1. Failed lookups remain errors
 * so the shell can offer recovery. It must never
 * fall back to any client-side session store.
 */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async (): Promise<Me> => getMeD1({}),
    retry: 1,
    staleTime: 60_000,
  });
}
