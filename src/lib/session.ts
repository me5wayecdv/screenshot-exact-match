import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type Me = { id: string; email: string; role: "teacher" | "student"; fullName: string; joinCode: string | null };

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async (): Promise<Me | null> => {
      const { data } = await supabase.auth.getUser();
      const user = data.user;
      if (!user) return null;
      const [{ data: role }, { data: profile }] = await Promise.all([
        supabase.from("user_roles").select("role").eq("user_id", user.id).maybeSingle(),
        supabase.from("profiles").select("full_name, join_code").eq("id", user.id).maybeSingle(),
      ]);
      return {
        id: user.id,
        email: user.email ?? "",
        role: (role?.role as Me["role"]) ?? "student",
        fullName: profile?.full_name || user.email || "",
        joinCode: profile?.join_code ?? null,
      };
    },
    staleTime: 60_000,
  });
}
