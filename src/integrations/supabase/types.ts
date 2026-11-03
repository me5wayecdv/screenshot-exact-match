export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18";
  };
  public: {
    Tables: {
      answers: {
        Row: {
          ai_suggestion: Json | null;
          auto_score: number | null;
          feedback: string;
          final_score: number | null;
          id: string;
          max_marks: number;
          question_id: string;
          response: string;
          review_status: Database["public"]["Enums"]["review_status"];
          submission_id: string;
          time_spent_seconds: number;
        };
        Insert: {
          ai_suggestion?: Json | null;
          auto_score?: number | null;
          feedback?: string;
          final_score?: number | null;
          id?: string;
          max_marks: number;
          question_id: string;
          response?: string;
          review_status?: Database["public"]["Enums"]["review_status"];
          submission_id: string;
          time_spent_seconds?: number;
        };
        Update: {
          ai_suggestion?: Json | null;
          auto_score?: number | null;
          feedback?: string;
          final_score?: number | null;
          id?: string;
          max_marks?: number;
          question_id?: string;
          response?: string;
          review_status?: Database["public"]["Enums"]["review_status"];
          submission_id?: string;
          time_spent_seconds?: number;
        };
        Relationships: [
          {
            foreignKeyName: "answers_question_id_fkey";
            columns: ["question_id"];
            isOneToOne: false;
            referencedRelation: "questions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "answers_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions";
            referencedColumns: ["id"];
          },
        ];
      };
      assessment_assignments: {
        Row: {
          assessment_id: string;
          student_id: string;
        };
        Insert: {
          assessment_id: string;
          student_id: string;
        };
        Update: {
          assessment_id?: string;
          student_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "assessment_assignments_assessment_id_fkey";
            columns: ["assessment_id"];
            isOneToOne: false;
            referencedRelation: "assessments";
            referencedColumns: ["id"];
          },
        ];
      };
      assessments: {
        Row: {
          created_at: string;
          auto_whatsapp_send: boolean;
          audience_mode: "auto_all" | "explicit";
          due_at: string | null;
          duration_minutes: number | null;
          starts_at: string | null;
          max_attempts: number;
          grade_level: string;
          id: string;
          instructions: string;
          status: Database["public"]["Enums"]["assessment_status"];
          subject_id: string | null;
          teacher_id: string;
          title: string;
          updated_at: string;
        };
        Insert: {
          auto_whatsapp_send?: boolean;
          audience_mode?: "auto_all" | "explicit";
          created_at?: string;
          due_at?: string | null;
          duration_minutes?: number | null;
          starts_at?: string | null;
          max_attempts?: number;
          grade_level?: string;
          id?: string;
          instructions?: string;
          status?: Database["public"]["Enums"]["assessment_status"];
          subject_id?: string | null;
          teacher_id?: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          auto_whatsapp_send?: boolean;
          audience_mode?: "auto_all" | "explicit";
          created_at?: string;
          due_at?: string | null;
          duration_minutes?: number | null;
          starts_at?: string | null;
          max_attempts?: number;
          grade_level?: string;
          id?: string;
          instructions?: string;
          status?: Database["public"]["Enums"]["assessment_status"];
          subject_id?: string | null;
          teacher_id?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "assessments_subject_id_fkey";
            columns: ["subject_id"];
            isOneToOne: false;
            referencedRelation: "subjects";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_log: {
        Row: {
          action: string;
          actor_id: string;
          created_at: string;
          details: Json;
          entity_id: string | null;
          id: number;
        };
        Insert: {
          action: string;
          actor_id: string;
          created_at?: string;
          details?: Json;
          entity_id?: string | null;
          id?: never;
        };
        Update: {
          action?: string;
          actor_id?: string;
          created_at?: string;
          details?: Json;
          entity_id?: string | null;
          id?: never;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          created_at: string;
          full_name: string;
          id: string;
          join_code: string | null;
          parent_phone: string | null;
          whatsapp_consent: boolean;
        };
        Insert: {
          created_at?: string;
          full_name?: string;
          id: string;
          join_code?: string | null;
          parent_phone?: string | null;
          whatsapp_consent?: boolean;
        };
        Update: {
          created_at?: string;
          full_name?: string;
          id?: string;
          join_code?: string | null;
          parent_phone?: string | null;
          whatsapp_consent?: boolean;
        };
        Relationships: [];
      };
      question_keys: {
        Row: {
          accepted_alternatives: Json;
          correct_answer: string;
          explanation: string;
          question_id: string;
          rubric: string;
        };
        Insert: {
          accepted_alternatives?: Json;
          correct_answer?: string;
          explanation?: string;
          question_id: string;
          rubric?: string;
        };
        Update: {
          accepted_alternatives?: Json;
          correct_answer?: string;
          explanation?: string;
          question_id?: string;
          rubric?: string;
        };
        Relationships: [
          {
            foreignKeyName: "question_keys_question_id_fkey";
            columns: ["question_id"];
            isOneToOne: true;
            referencedRelation: "questions";
            referencedColumns: ["id"];
          },
        ];
      };
      grade_review_requests: {
        Row: {
          created_at: string;
          id: string;
          message: string;
          question_id: string | null;
          resolved_at: string | null;
          status: string;
          student_id: string;
          submission_id: string;
          teacher_id: string;
          teacher_response: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          message: string;
          question_id?: string | null;
          resolved_at?: string | null;
          status?: string;
          student_id: string;
          submission_id: string;
          teacher_id: string;
          teacher_response?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          message?: string;
          question_id?: string | null;
          resolved_at?: string | null;
          status?: string;
          student_id?: string;
          submission_id?: string;
          teacher_id?: string;
          teacher_response?: string;
        };
        Relationships: [
          {
            foreignKeyName: "grade_review_requests_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "grade_review_requests_question_id_fkey";
            columns: ["question_id"];
            isOneToOne: false;
            referencedRelation: "questions";
            referencedColumns: ["id"];
          },
        ];
      };
      questions: {
        Row: {
          assessment_id: string;
          created_at: string;
          difficulty: string;
          id: string;
          marks: number;
          objective: string;
          options: Json;
          position: number;
          prompt: string;
          type: Database["public"]["Enums"]["question_type"];
        };
        Insert: {
          assessment_id: string;
          created_at?: string;
          difficulty?: string;
          id?: string;
          marks?: number;
          objective?: string;
          options?: Json;
          position?: number;
          prompt?: string;
          type: Database["public"]["Enums"]["question_type"];
        };
        Update: {
          assessment_id?: string;
          created_at?: string;
          difficulty?: string;
          id?: string;
          marks?: number;
          objective?: string;
          options?: Json;
          position?: number;
          prompt?: string;
          type?: Database["public"]["Enums"]["question_type"];
        };
        Relationships: [
          {
            foreignKeyName: "questions_assessment_id_fkey";
            columns: ["assessment_id"];
            isOneToOne: false;
            referencedRelation: "assessments";
            referencedColumns: ["id"];
          },
        ];
      };
      lesson_enrollments: {
        Row: {
          enrolled_at: string;
          lesson_id: string;
          student_id: string;
        };
        Insert: {
          enrolled_at?: string;
          lesson_id: string;
          student_id: string;
        };
        Update: {
          enrolled_at?: string;
          lesson_id?: string;
          student_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lesson_enrollments_lesson_id_fkey";
            columns: ["lesson_id"];
            isOneToOne: false;
            referencedRelation: "lessons";
            referencedColumns: ["id"];
          },
        ];
      };
      lessons: {
        Row: {
          created_at: string;
          description: string;
          id: string;
          join_code: string;
          subject_id: string | null;
          title: string;
          tutor_id: string;
        };
        Insert: {
          created_at?: string;
          description?: string;
          id?: string;
          join_code?: string;
          subject_id?: string | null;
          title: string;
          tutor_id?: string;
        };
        Update: {
          created_at?: string;
          description?: string;
          id?: string;
          join_code?: string;
          subject_id?: string | null;
          title?: string;
          tutor_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lessons_subject_id_fkey";
            columns: ["subject_id"];
            isOneToOne: false;
            referencedRelation: "subjects";
            referencedColumns: ["id"];
          },
        ];
      };
      subjects: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          teacher_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          teacher_id?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          teacher_id?: string;
        };
        Relationships: [];
      };
      submissions: {
        Row: {
          assessment_id: string;
          final_score: number | null;
          id: string;
          released_at: string | null;
          status: Database["public"]["Enums"]["submission_status"];
          student_id: string;
          submitted_at: string;
          attempt_number: number;
          started_at: string | null;
          expires_at: string | null;
          question_order: Json | null;
          teacher_feedback: string;
          total_possible: number;
        };
        Insert: {
          assessment_id: string;
          final_score?: number | null;
          id?: string;
          released_at?: string | null;
          status?: Database["public"]["Enums"]["submission_status"];
          student_id: string;
          submitted_at?: string;
          attempt_number?: number;
          started_at?: string | null;
          expires_at?: string | null;
          question_order?: Json | null;
          teacher_feedback?: string;
          total_possible?: number;
        };
        Update: {
          assessment_id?: string;
          final_score?: number | null;
          id?: string;
          released_at?: string | null;
          status?: Database["public"]["Enums"]["submission_status"];
          student_id?: string;
          submitted_at?: string;
          attempt_number?: number;
          started_at?: string | null;
          expires_at?: string | null;
          question_order?: Json | null;
          teacher_feedback?: string;
          total_possible?: number;
        };
        Relationships: [
          {
            foreignKeyName: "submissions_assessment_id_fkey";
            columns: ["assessment_id"];
            isOneToOne: false;
            referencedRelation: "assessments";
            referencedColumns: ["id"];
          },
        ];
      };
      teacher_profiles: {
        Row: {
          bio: string;
          subjects_text: string;
          type: string;
          user_id: string;
        };
        Insert: {
          bio?: string;
          subjects_text?: string;
          type: string;
          user_id: string;
        };
        Update: {
          bio?: string;
          subjects_text?: string;
          type?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      teacher_students: {
        Row: {
          created_at: string;
          decided_at: string | null;
          requested_at: string;
          status: string;
          student_id: string;
          teacher_id: string;
        };
        Insert: {
          created_at?: string;
          decided_at?: string | null;
          requested_at?: string;
          status?: string;
          student_id: string;
          teacher_id: string;
        };
        Update: {
          created_at?: string;
          decided_at?: string | null;
          requested_at?: string;
          status?: string;
          student_id?: string;
          teacher_id?: string;
        };
        Relationships: [];
      };
      teacher_groups: {
        Row: {
          created_at: string;
          days: string[];
          id: string;
          join_code: string;
          name: string;
          notes: string;
          school_year: string;
          teacher_id: string;
          time_text: string;
        };
        Insert: {
          created_at?: string;
          days?: string[];
          id?: string;
          join_code: string;
          name: string;
          notes?: string;
          school_year?: string;
          teacher_id: string;
          time_text?: string;
        };
        Update: {
          created_at?: string;
          days?: string[];
          id?: string;
          join_code?: string;
          name?: string;
          notes?: string;
          school_year?: string;
          teacher_id?: string;
          time_text?: string;
        };
        Relationships: [];
      };
      group_members: {
        Row: {
          decided_at: string | null;
          group_id: string;
          requested_at: string;
          status: string;
          student_id: string;
        };
        Insert: {
          decided_at?: string | null;
          group_id: string;
          requested_at?: string;
          status?: string;
          student_id: string;
        };
        Update: {
          decided_at?: string | null;
          group_id?: string;
          requested_at?: string;
          status?: string;
          student_id?: string;
        };
        Relationships: [];
      };
      group_exams: {
        Row: {
          assessment_id: string;
          created_at: string;
          group_id: string;
        };
        Insert: {
          assessment_id: string;
          created_at?: string;
          group_id: string;
        };
        Update: {
          assessment_id?: string;
          created_at?: string;
          group_id?: string;
        };
        Relationships: [];
      };
      ai_training_examples: {
        Row: {
          ai_feedback: string | null;
          ai_suggested_score: number;
          created_at: string;
          id: string;
          model_name: string | null;
          question_text: string;
          rubric_text: string | null;
          student_answer_text: string;
          teacher_feedback: string | null;
          teacher_final_score: number;
        };
        Insert: {
          ai_feedback?: string | null;
          ai_suggested_score: number;
          created_at?: string;
          id?: string;
          model_name?: string | null;
          question_text: string;
          rubric_text?: string | null;
          student_answer_text: string;
          teacher_feedback?: string | null;
          teacher_final_score: number;
        };
        Update: {
          ai_feedback?: string | null;
          ai_suggested_score?: number;
          created_at?: string;
          id?: string;
          model_name?: string | null;
          question_text?: string;
          rubric_text?: string | null;
          student_answer_text?: string;
          teacher_feedback?: string | null;
          teacher_final_score?: number;
        };
        Relationships: [];
      };
      ai_usage_events: {
        Row: {
          created_at: string;
          id: string;
          input_tokens: number | null;
          kind: string;
          model: string;
          output_tokens: number | null;
          provider: string;
          teacher_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          input_tokens?: number | null;
          kind: string;
          model: string;
          output_tokens?: number | null;
          provider: string;
          teacher_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          input_tokens?: number | null;
          kind?: string;
          model?: string;
          output_tokens?: number | null;
          provider?: string;
          teacher_id?: string;
        };
        Relationships: [];
      };
      handwritten_grades: {
        Row: {
          ai_feedback: string | null;
          ai_model: string | null;
          ai_suggested_score: number | null;
          assessment_id: string | null;
          corrected_text: string;
          created_at: string;
          extracted_text: string;
          final_score: number;
          id: string;
          image_path: string | null;
          max_marks: number;
          question_id: string | null;
          student_name: string;
          teacher_feedback: string;
          teacher_id: string;
        };
        Insert: {
          ai_feedback?: string | null;
          ai_model?: string | null;
          ai_suggested_score?: number | null;
          assessment_id?: string | null;
          corrected_text: string;
          created_at?: string;
          extracted_text?: string;
          final_score: number;
          id?: string;
          image_path?: string | null;
          max_marks: number;
          question_id?: string | null;
          student_name?: string;
          teacher_feedback?: string;
          teacher_id: string;
        };
        Update: {
          ai_feedback?: string | null;
          ai_model?: string | null;
          ai_suggested_score?: number | null;
          assessment_id?: string | null;
          corrected_text?: string;
          created_at?: string;
          extracted_text?: string;
          final_score?: number;
          id?: string;
          image_path?: string | null;
          max_marks?: number;
          question_id?: string | null;
          student_name?: string;
          teacher_feedback?: string;
          teacher_id?: string;
        };
        Relationships: [];
      };
      integrity_events: {
        Row: {
          created_at: string;
          event_type: string;
          id: string;
          question_id: string | null;
          submission_id: string;
        };
        Insert: {
          created_at?: string;
          event_type: string;
          id?: string;
          question_id?: string | null;
          submission_id: string;
        };
        Update: {
          created_at?: string;
          event_type?: string;
          id?: string;
          question_id?: string | null;
          submission_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "integrity_events_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "integrity_events_question_id_fkey";
            columns: ["question_id"];
            isOneToOne: false;
            referencedRelation: "questions";
            referencedColumns: ["id"];
          },
        ];
      };
      whatsapp_sends: {
        Row: {
          error: string | null;
          id: string;
          message_id: string | null;
          sent_at: string;
          status: string;
          submission_id: string;
          trigger: string;
        };
        Insert: {
          error?: string | null;
          id?: string;
          message_id?: string | null;
          sent_at?: string;
          status: string;
          submission_id: string;
          trigger: string;
        };
        Update: {
          error?: string | null;
          id?: string;
          message_id?: string | null;
          sent_at?: string;
          status?: string;
          submission_id?: string;
          trigger?: string;
        };
        Relationships: [
          {
            foreignKeyName: "whatsapp_sends_submission_id_fkey";
            columns: ["submission_id"];
            isOneToOne: false;
            referencedRelation: "submissions";
            referencedColumns: ["id"];
          },
        ];
      };
      user_roles: {
        Row: {
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      assigned_published: { Args: { _a: string }; Returns: boolean };
      enroll_lesson: { Args: { _code: string }; Returns: string };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      is_teacher_of: {
        Args: { _student: string; _teacher: string };
        Returns: boolean;
      };
      is_approved_student: {
        Args: { _student: string; _teacher: string };
        Returns: boolean;
      };
      join_teacher: { Args: { _code: string }; Returns: string };
      my_pending_enrollments: {
        Args: never;
        Returns: { teacher_id: string; teacher_name: string; requested_at: string }[];
      };
      my_student_roster: {
        Args: never;
        Returns: {
          full_name: string;
          joined_at: string;
          requested_at: string;
          status: string;
          student_id: string;
        }[];
      };
      my_students: {
        Args: never;
        Returns: {
          full_name: string;
          joined_at: string;
          student_id: string;
        }[];
      };
      approve_all_enrollments: { Args: never; Returns: number };
      decide_enrollment: {
        Args: { _approve: boolean; _student: string };
        Returns: string;
      };
      create_teacher_group: {
        Args: {
          _days: string[];
          _name: string;
          _notes: string;
          _time: string;
          _year: string;
        };
        Returns: string;
      };
      update_teacher_group: {
        Args: {
          _days: string[];
          _group: string;
          _name: string;
          _notes: string;
          _time: string;
          _year: string;
        };
        Returns: boolean;
      };
      delete_teacher_group: { Args: { _group: string }; Returns: boolean };
      join_group: { Args: { _code: string }; Returns: string };
      decide_group_membership: {
        Args: { _approve: boolean; _group: string; _student: string };
        Returns: string;
      };
      approve_all_group_members: { Args: { _group: string }; Returns: number };
      assign_group_exam: {
        Args: { _assessment: string; _group: string };
        Returns: number;
      };
      my_group_exams: {
        Args: { _group: string };
        Returns: {
          assessment_id: string;
          published: boolean;
          title: string;
        }[];
      };
      is_group_owner: { Args: { _group: string }; Returns: boolean };
      my_teacher_groups: {
        Args: never;
        Returns: {
          approved_count: number;
          created_at: string;
          days: string[];
          group_id: string;
          join_code: string;
          name: string;
          notes: string;
          pending_count: number;
          school_year: string;
          time_text: string;
        }[];
      };
      my_group_roster: {
        Args: { _group: string };
        Returns: {
          full_name: string;
          requested_at: string;
          status: string;
          student_id: string;
        }[];
      };
      my_groups: {
        Args: never;
        Returns: {
          days: string[];
          group_id: string;
          group_name: string;
          school_year: string;
          teacher_id: string;
          teacher_name: string;
          time_text: string;
        }[];
      };
      my_pending_group_requests: {
        Args: never;
        Returns: {
          group_id: string;
          group_name: string;
          requested_at: string;
          teacher_id: string;
          teacher_name: string;
        }[];
      };
      normalize_answer: { Args: { _t: string }; Returns: string };
      owns_assessment: { Args: { _a: string }; Returns: boolean };
      own_submission_responses: {
        Args: { _submission: string };
        Returns: { question_id: string; response: string | null }[];
      };
      release_submission: {
        Args: { _feedback: string; _sub: string };
        Returns: undefined;
      };
      review_answer: {
        Args: {
          _answer: string;
          _decision: string;
          _feedback: string;
          _score: number | null;
        };
        Returns: undefined;
      };
      score_objective: {
        Args: {
          _alts: Json;
          _correct: string;
          _marks: number;
          _response: string;
          _type: Database["public"]["Enums"]["question_type"];
        };
        Returns: number;
      };
      set_assessment_status: {
        Args: {
          _a: string;
          _status: Database["public"]["Enums"]["assessment_status"];
        };
        Returns: undefined;
      };
      store_ai_suggestion: {
        Args: { _answer: string; _suggestion: Json };
        Returns: undefined;
      };
      submit_assessment: {
        Args: { _a: string; _answers: Json };
        Returns: string;
      };
      start_attempt: { Args: { _assessment: string; _question_order: Json }; Returns: string };
      save_draft: { Args: { _answers: Json; _submission: string }; Returns: boolean };
      submit_attempt: { Args: { _submission: string }; Returns: boolean };
      resolve_review_request: { Args: { _id: string; _response: string }; Returns: boolean };
      consume_ai_rate_quota: { Args: { _units?: number }; Returns: boolean };
      my_join_code: { Args: never; Returns: string | null };
      teacher_dashboard_summary: {
        Args: never;
        Returns: {
          active_assessment_count: number;
          pending_submission_count: number;
          student_count: number;
          released_submission_count: number;
        }[];
      };
      tutor_dashboard_summary: {
        Args: never;
        Returns: {
          lesson_count: number;
          student_count: number;
          published_assessment_count: number;
        }[];
      };
      tutor_lesson_enrollment_counts: {
        Args: { _lesson_ids: string[] };
        Returns: { lesson_id: string; student_count: number }[];
      };
      teacher_grading_page: {
        Args: { _limit?: number; _offset?: number; _status: string };
        Returns: Database["public"]["Tables"]["submissions"]["Row"][];
      };
      teacher_analytics_question_stats: {
        Args: { _assessment: string };
        Returns: {
          question_id: string;
          answered: number;
          graded: number;
          avg_pct: number | null;
          full_credit_pct: number | null;
        }[];
      };
      teacher_analytics_student_page: {
        Args: { _assessment: string; _limit?: number; _offset?: number };
        Returns: {
          student_id: string;
          full_name: string;
          released: number;
          avg_pct: number | null;
        }[];
      };
      teacher_analytics_group_stats: {
        Args: { _assessment: string; _limit?: number; _offset?: number };
        Returns: { group_id: string; name: string; students: number; avg_pct: number | null }[];
      };
      teacher_analytics_overview: {
        Args: { _assessment_ids: string[] };
        Returns: { assessment_id: string; released: number; avg_pct: number | null }[];
      };
      claim_whatsapp_send: { Args: { _submission: string }; Returns: boolean };
      finish_whatsapp_send: {
        Args: {
          _error?: string | null;
          _message_id?: string | null;
          _retryable?: boolean;
          _status: string;
          _submission: string;
          _trigger: string;
        };
        Returns: boolean;
      };
    };
    Enums: {
      app_role: "teacher" | "student" | "school_teacher" | "tutor" | "admin";
      assessment_status: "draft" | "published" | "closed" | "archived";
      question_type: "mcq" | "true_false" | "short_answer" | "written";
      review_status: "not_graded" | "auto_graded" | "ai_suggested" | "approved" | "rejected";
      submission_status: "submitted" | "in_progress" | "awaiting_review" | "approved" | "released";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: ["teacher", "student", "school_teacher", "tutor", "admin"],
      assessment_status: ["draft", "published", "closed", "archived"],
      question_type: ["mcq", "true_false", "short_answer", "written"],
      review_status: ["not_graded", "auto_graded", "ai_suggested", "approved", "rejected"],
      submission_status: ["submitted", "in_progress", "awaiting_review", "approved", "released"],
    },
  },
} as const;
