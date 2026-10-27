export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      answers: {
        Row: {
          ai_suggestion: Json | null
          auto_score: number | null
          feedback: string
          final_score: number | null
          id: string
          max_marks: number
          question_id: string
          response: string
          review_status: Database["public"]["Enums"]["review_status"]
          submission_id: string
        }
        Insert: {
          ai_suggestion?: Json | null
          auto_score?: number | null
          feedback?: string
          final_score?: number | null
          id?: string
          max_marks: number
          question_id: string
          response?: string
          review_status?: Database["public"]["Enums"]["review_status"]
          submission_id: string
        }
        Update: {
          ai_suggestion?: Json | null
          auto_score?: number | null
          feedback?: string
          final_score?: number | null
          id?: string
          max_marks?: number
          question_id?: string
          response?: string
          review_status?: Database["public"]["Enums"]["review_status"]
          submission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "answers_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      assessment_assignments: {
        Row: {
          assessment_id: string
          student_id: string
        }
        Insert: {
          assessment_id: string
          student_id: string
        }
        Update: {
          assessment_id?: string
          student_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assessment_assignments_assessment_id_fkey"
            columns: ["assessment_id"]
            isOneToOne: false
            referencedRelation: "assessments"
            referencedColumns: ["id"]
          },
        ]
      }
      assessments: {
        Row: {
          created_at: string
          due_at: string | null
          duration_minutes: number | null
          starts_at: string | null
          max_attempts: number
          grade_level: string
          id: string
          instructions: string
          status: Database["public"]["Enums"]["assessment_status"]
          subject_id: string | null
          teacher_id: string
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          due_at?: string | null
          duration_minutes?: number | null
          starts_at?: string | null
          max_attempts?: number
          grade_level?: string
          id?: string
          instructions?: string
          status?: Database["public"]["Enums"]["assessment_status"]
          subject_id?: string | null
          teacher_id?: string
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          due_at?: string | null
          duration_minutes?: number | null
          starts_at?: string | null
          max_attempts?: number
          grade_level?: string
          id?: string
          instructions?: string
          status?: Database["public"]["Enums"]["assessment_status"]
          subject_id?: string | null
          teacher_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "assessments_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "subjects"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string
          created_at: string
          details: Json
          entity_id: string | null
          id: number
        }
        Insert: {
          action: string
          actor_id: string
          created_at?: string
          details?: Json
          entity_id?: string | null
          id?: never
        }
        Update: {
          action?: string
          actor_id?: string
          created_at?: string
          details?: Json
          entity_id?: string | null
          id?: never
        }
        Relationships: []
      }
      // Hand-added for the segmentation migration (supabase/migrations/20261026130000_segmentation.sql).
      // Regenerate with `supabase gen types` to confirm.
      class_members: {
        Row: {
          class_id: string
          joined_at: string
          student_id: string
        }
        Insert: {
          class_id: string
          joined_at?: string
          student_id: string
        }
        Update: {
          class_id?: string
          joined_at?: string
          student_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "class_members_class_id_fkey"
            columns: ["class_id"]
            isOneToOne: false
            referencedRelation: "classes"
            referencedColumns: ["id"]
          }
        ]
      }
      classes: {
        Row: {
          created_at: string
          id: string
          name: string
          school_id: string
          teacher_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          school_id: string
          teacher_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          school_id?: string
          teacher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "classes_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          }
        ]
      }
      profiles: {
        Row: {
          created_at: string
          full_name: string
          id: string
          join_code: string | null
        }
        Insert: {
          created_at?: string
          full_name?: string
          id: string
          join_code?: string | null
        }
        Update: {
          created_at?: string
          full_name?: string
          id?: string
          join_code?: string | null
        }
        Relationships: []
      }
      question_keys: {
        Row: {
          accepted_alternatives: Json
          correct_answer: string
          explanation: string
          question_id: string
          rubric: string
        }
        Insert: {
          accepted_alternatives?: Json
          correct_answer?: string
          explanation?: string
          question_id: string
          rubric?: string
        }
        Update: {
          accepted_alternatives?: Json
          correct_answer?: string
          explanation?: string
          question_id?: string
          rubric?: string
        }
        Relationships: [
          {
            foreignKeyName: "question_keys_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: true
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      grade_review_requests: {
        Row: {
          created_at: string
          id: string
          message: string
          question_id: string | null
          resolved_at: string | null
          status: string
          student_id: string
          submission_id: string
          teacher_id: string
          teacher_response: string
        }
        Insert: {
          created_at?: string
          id?: string
          message: string
          question_id?: string | null
          resolved_at?: string | null
          status?: string
          student_id: string
          submission_id: string
          teacher_id: string
          teacher_response?: string
        }
        Update: {
          created_at?: string
          id?: string
          message?: string
          question_id?: string | null
          resolved_at?: string | null
          status?: string
          student_id?: string
          submission_id?: string
          teacher_id?: string
          teacher_response?: string
        }
        Relationships: [
          {
            foreignKeyName: "grade_review_requests_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grade_review_requests_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      questions: {
        Row: {
          assessment_id: string
          created_at: string
          difficulty: string
          id: string
          marks: number
          objective: string
          options: Json
          position: number
          prompt: string
          type: Database["public"]["Enums"]["question_type"]
        }
        Insert: {
          assessment_id: string
          created_at?: string
          difficulty?: string
          id?: string
          marks?: number
          objective?: string
          options?: Json
          position?: number
          prompt?: string
          type: Database["public"]["Enums"]["question_type"]
        }
        Update: {
          assessment_id?: string
          created_at?: string
          difficulty?: string
          id?: string
          marks?: number
          objective?: string
          options?: Json
          position?: number
          prompt?: string
          type?: Database["public"]["Enums"]["question_type"]
        }
        Relationships: [
          {
            foreignKeyName: "questions_assessment_id_fkey"
            columns: ["assessment_id"]
            isOneToOne: false
            referencedRelation: "assessments"
            referencedColumns: ["id"]
          },
        ]
      }
      lesson_enrollments: {
        Row: {
          enrolled_at: string
          lesson_id: string
          student_id: string
        }
        Insert: {
          enrolled_at?: string
          lesson_id: string
          student_id: string
        }
        Update: {
          enrolled_at?: string
          lesson_id?: string
          student_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lesson_enrollments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          }
        ]
      }
      lessons: {
        Row: {
          created_at: string
          description: string
          id: string
          join_code: string
          subject_id: string | null
          title: string
          tutor_id: string
        }
        Insert: {
          created_at?: string
          description?: string
          id?: string
          join_code?: string
          subject_id?: string | null
          title: string
          tutor_id?: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          join_code?: string
          subject_id?: string | null
          title?: string
          tutor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lessons_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "subjects"
            referencedColumns: ["id"]
          }
        ]
      }
      school_teachers: {
        Row: {
          joined_at: string
          school_id: string
          teacher_id: string
        }
        Insert: {
          joined_at?: string
          school_id: string
          teacher_id: string
        }
        Update: {
          joined_at?: string
          school_id?: string
          teacher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "school_teachers_school_id_fkey"
            columns: ["school_id"]
            isOneToOne: false
            referencedRelation: "schools"
            referencedColumns: ["id"]
          }
        ]
      }
      schools: {
        Row: {
          created_at: string
          created_by: string
          id: string
          join_code: string
          name: string
        }
        Insert: {
          created_at?: string
          created_by?: string
          id?: string
          join_code?: string
          name: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          join_code?: string
          name?: string
        }
        Relationships: []
      }
      subjects: {
        Row: {
          created_at: string
          id: string
          name: string
          teacher_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          teacher_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          teacher_id?: string
        }
        Relationships: []
      }
      submissions: {
        Row: {
          assessment_id: string
          final_score: number | null
          id: string
          released_at: string | null
          status: Database["public"]["Enums"]["submission_status"]
          student_id: string
          submitted_at: string
          attempt_number: number
          started_at: string | null
          expires_at: string | null
          question_order: string[] | null
          teacher_feedback: string
          total_possible: number
        }
        Insert: {
          assessment_id: string
          final_score?: number | null
          id?: string
          released_at?: string | null
          status?: Database["public"]["Enums"]["submission_status"]
          student_id: string
          submitted_at?: string
          attempt_number?: number
          started_at?: string | null
          expires_at?: string | null
          question_order?: string[] | null
          teacher_feedback?: string
          total_possible?: number
        }
        Update: {
          assessment_id?: string
          final_score?: number | null
          id?: string
          released_at?: string | null
          status?: Database["public"]["Enums"]["submission_status"]
          student_id?: string
          submitted_at?: string
          attempt_number?: number
          started_at?: string | null
          expires_at?: string | null
          question_order?: string[] | null
          teacher_feedback?: string
          total_possible?: number
        }
        Relationships: [
          {
            foreignKeyName: "submissions_assessment_id_fkey"
            columns: ["assessment_id"]
            isOneToOne: false
            referencedRelation: "assessments"
            referencedColumns: ["id"]
          },
        ]
      }
      teacher_profiles: {
        Row: {
          bio: string
          subjects_text: string
          type: string
          user_id: string
        }
        Insert: {
          bio?: string
          subjects_text?: string
          type: string
          user_id: string
        }
        Update: {
          bio?: string
          subjects_text?: string
          type?: string
          user_id?: string
        }
        Relationships: []
      }
      teacher_students: {
        Row: {
          created_at: string
          student_id: string
          teacher_id: string
        }
        Insert: {
          created_at?: string
          student_id: string
          teacher_id: string
        }
        Update: {
          created_at?: string
          student_id?: string
          teacher_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      assigned_published: { Args: { _a: string }; Returns: boolean }
      enroll_lesson: { Args: { _code: string }; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_teacher_of: {
        Args: { _student: string; _teacher: string }
        Returns: boolean
      }
      join_school: { Args: { _code: string }; Returns: string }
      join_teacher: { Args: { _code: string }; Returns: string }
      my_students: {
        Args: never
        Returns: {
          full_name: string
          joined_at: string
          student_id: string
        }[]
      }
      normalize_answer: { Args: { _t: string }; Returns: string }
      owns_assessment: { Args: { _a: string }; Returns: boolean }
      release_submission: {
        Args: { _feedback: string; _sub: string }
        Returns: undefined
      }
      review_answer: {
        Args: {
          _answer: string
          _decision: string
          _feedback: string
          _score: number
        }
        Returns: undefined
      }
      score_objective: {
        Args: {
          _alts: Json
          _correct: string
          _marks: number
          _response: string
          _type: Database["public"]["Enums"]["question_type"]
        }
        Returns: number
      }
      set_assessment_status: {
        Args: {
          _a: string
          _status: Database["public"]["Enums"]["assessment_status"]
        }
        Returns: undefined
      }
      store_ai_suggestion: {
        Args: { _answer: string; _suggestion: Json }
        Returns: undefined
      }
      submit_assessment: {
        Args: { _a: string; _answers: Json }
        Returns: string
      }
    }
    Enums: {
      app_role: "teacher" | "student" | "school_teacher" | "tutor" | "admin"
      assessment_status: "draft" | "published" | "closed" | "archived"
      question_type: "mcq" | "true_false" | "short_answer" | "written"
      review_status:
        | "not_graded"
        | "auto_graded"
        | "ai_suggested"
        | "approved"
        | "rejected"
      submission_status:
        | "submitted"
        | "in_progress"
        | "awaiting_review"
        | "approved"
        | "released"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["teacher", "student"],
      assessment_status: ["draft", "published", "closed", "archived"],
      question_type: ["mcq", "true_false", "short_answer", "written"],
      review_status: [
        "not_graded",
        "auto_graded",
        "ai_suggested",
        "approved",
        "rejected",
      ],
      submission_status: [
        "submitted",
        "in_progress",
        "awaiting_review",
        "approved",
        "released",
      ],
    },
  },
} as const
