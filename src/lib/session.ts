import { useQuery } from "@tanstack/react-query";
import { getMeD1, getMyAvatarD1 } from "@/server/d1-auth-fns";

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

/**
 * The signed-in user's avatar (a data URL, or null when none was set
 * at sign-up). Session-checked server-side; callers render the
 * initials fallback when dataUrl is null.
 */
export function useMyAvatar(enabled = true) {
  return useQuery({
    queryKey: ["my-avatar"],
    queryFn: async (): Promise<{ dataUrl: string | null }> => getMyAvatarD1({ data: {} }),
    enabled,
    retry: 1,
    staleTime: 300_000,
  });
}
