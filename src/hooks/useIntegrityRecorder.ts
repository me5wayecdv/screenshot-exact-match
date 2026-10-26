import { useCallback, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Exam-integrity recorder — PRIVACY-SAFE BY DESIGN.
 *
 * Records ONLY:
 *  - visibilitychange / window blur+focus events (tab or window switched
 *    away and back), each tagged with the currently-visible question id;
 *  - time spent per question, counted ONLY while the document is visible
 *    and attributed to the question currently in view (IntersectionObserver)
 *    or last interacted with (focus fallback).
 *
 * NEVER records: keystrokes or answer text, webcam, screen capture, device
 * fingerprint, user agent, or any URL. Events are a signal for the teacher,
 * never an automatic penalty or accusation.
 *
 * WHY BUFFERING: the take page creates the submissions row only at submit
 * time, so there is no submission_id while the student is answering.
 * Events + accumulated times are therefore buffered in memory and mirrored
 * to localStorage (so a reload/resume keeps them), then flushed to
 * public.integrity_events once, right after the submission row is created.
 * A student who never submits leaves nothing in the database.
 */

export type IntegrityEventType = "tab_hidden" | "tab_visible" | "window_blur" | "window_focus";

export interface BufferedIntegrityEvent {
  event_type: IntegrityEventType;
  question_id: string | null;
  created_at: string;
}

export interface IntegrityRecorder {
  /** Ref callback for each question's wrapper div. Also drives the "current question". */
  registerPanel: (questionId: string) => (el: HTMLElement | null) => void;
  /** Mark a question as current (call from onFocusCapture on the wrapper). */
  setCurrentQuestionId: (questionId: string | null) => void;
  /** Whole seconds per question id, accrued up to the moment of the call. */
  getTimesSeconds: () => Record<string, number>;
  /**
   * Insert buffered events for a freshly created submission, then clear the
   * buffer. Throws on insert error so the caller can warn (non-fatally) —
   * the submission itself is already saved at that point.
   */
  flushEvents: (submissionId: string) => Promise<void>;
}

function bufferKey(assessmentId: string, studentId: string): string {
  return `qemmini:integrity-buffer:${assessmentId}:${studentId}`;
}

function readBuffer(key: string): { events: BufferedIntegrityEvent[]; times: Record<string, number> } {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { events: [], times: {} };
    const parsed = JSON.parse(raw) as { events?: unknown; times?: unknown };
    const events = Array.isArray(parsed.events) ? (parsed.events as BufferedIntegrityEvent[]) : [];
    const times =
      parsed.times && typeof parsed.times === "object" ? (parsed.times as Record<string, number>) : {};
    return { events, times };
  } catch {
    return { events: [], times: {} };
  }
}

export function useIntegrityRecorder(opts: {
  enabled: boolean;
  assessmentId: string;
  studentId: string;
}): IntegrityRecorder {
  const { enabled, assessmentId, studentId } = opts;
  const key = bufferKey(assessmentId, studentId);

  const eventsRef = useRef<BufferedIntegrityEvent[]>([]);
  const timesRef = useRef<Record<string, number>>({});
  const currentRef = useRef<string | null>(null);
  const lastTickRef = useRef<number | null>(null);
  const awayRef = useRef(false);
  const restoredKeyRef = useRef("");
  const flushedRef = useRef(false);
  const panelsRef = useRef(new Map<string, HTMLElement>());
  const observerRef = useRef<IntersectionObserver | null>(null);

  const persist = useCallback(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify({ events: eventsRef.current, times: timesRef.current }));
    } catch {
      // Private mode / quota: memory buffer still works for this session.
    }
  }, [key]);

  /** Move elapsed visible time onto the current question. */
  const accrue = useCallback(() => {
    const now = Date.now();
    const started = lastTickRef.current;
    const current = currentRef.current;
    if (started !== null && current) {
      const elapsed = (now - started) / 1000;
      if (elapsed > 0) timesRef.current[current] = (timesRef.current[current] ?? 0) + elapsed;
    }
    lastTickRef.current = now;
  }, []);

  const pauseClock = useCallback(() => {
    accrue();
    lastTickRef.current = null;
  }, [accrue]);

  const resumeClock = useCallback(() => {
    if (lastTickRef.current === null) lastTickRef.current = Date.now();
  }, []);

  const record = useCallback(
    (event_type: IntegrityEventType) => {
      eventsRef.current = [
        ...eventsRef.current,
        { event_type, question_id: currentRef.current, created_at: new Date().toISOString() },
      ];
      persist();
    },
    [persist],
  );

  const setCurrentQuestionId = useCallback(
    (questionId: string | null) => {
      if (questionId === currentRef.current) return;
      accrue();
      currentRef.current = questionId;
    },
    [accrue],
  );

  const registerPanel = useCallback((questionId: string) => {
    return (el: HTMLElement | null) => {
      if (el) {
        el.dataset.integrityQuestion = questionId;
        panelsRef.current.set(questionId, el);
        observerRef.current?.observe(el);
      } else {
        const prev = panelsRef.current.get(questionId);
        if (prev) observerRef.current?.unobserve(prev);
        panelsRef.current.delete(questionId);
      }
    };
  }, []);

  const getTimesSeconds = useCallback(() => {
    accrue();
    const out: Record<string, number> = {};
    for (const [qid, secs] of Object.entries(timesRef.current)) out[qid] = Math.max(0, Math.round(secs));
    return out;
  }, [accrue]);

  const flushEvents = useCallback(
    async (submissionId: string) => {
      if (flushedRef.current) return;
      flushedRef.current = true;
      accrue();
      persist();
      const events = eventsRef.current;
      if (events.length === 0) {
        try {
          window.localStorage.removeItem(key);
        } catch {
          // ignore
        }
        return;
      }
      const { error } = await supabase.from("integrity_events").insert(
        events.map((e) => ({
          submission_id: submissionId,
          event_type: e.event_type,
          question_id: e.question_id,
          created_at: e.created_at,
        })),
      );
      if (error) {
        // Keep the buffer (and allow a retry) but surface the failure.
        flushedRef.current = false;
        throw error;
      }
      eventsRef.current = [];
      try {
        window.localStorage.removeItem(key);
      } catch {
        // ignore
      }
    },
    [accrue, key, persist],
  );

  useEffect(() => {
    if (!enabled || !studentId) return;
    // Restore the pre-submit buffer for this student+assessment exactly once
    // per key, so a reload/resume keeps events and times.
    if (restoredKeyRef.current !== key) {
      restoredKeyRef.current = key;
      const restored = readBuffer(key);
      eventsRef.current = restored.events;
      timesRef.current = restored.times;
    }

    const onVisibility = () => {
      if (document.hidden) {
        pauseClock();
        record("tab_hidden");
        awayRef.current = true;
      } else {
        if (awayRef.current) record("tab_visible");
        awayRef.current = false;
        resumeClock();
      }
    };
    const onBlur = () => {
      // visibilitychange already covers tab/app switches; blur alone means
      // focus left the window while the page stayed visible.
      if (document.hidden) return;
      pauseClock();
      record("window_blur");
      awayRef.current = true;
    };
    const onFocus = () => {
      if (!awayRef.current) return;
      record("window_focus");
      awayRef.current = false;
      resumeClock();
    };
    const onBeforeUnload = () => {
      accrue();
      persist();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("beforeunload", onBeforeUnload);
    resumeClock();
    const tick = window.setInterval(() => {
      accrue();
      persist();
    }, 1000);

    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver(
        (entries) => {
          let best: { id: string; ratio: number } | null = null;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const id = (entry.target as HTMLElement).dataset.integrityQuestion;
            if (!id) continue;
            if (!best || entry.intersectionRatio > best.ratio) best = { id, ratio: entry.intersectionRatio };
          }
          if (best) setCurrentQuestionId(best.id);
        },
        { rootMargin: "-40% 0px -40% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] },
      );
      observerRef.current = observer;
      for (const el of panelsRef.current.values()) observer.observe(el);
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.clearInterval(tick);
      observerRef.current?.disconnect();
      observerRef.current = null;
      accrue();
      persist();
    };
    // Intentionally keyed on enabled/key only: re-subscribing on every
    // render would drop the away/accrual state mid-attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  return { registerPanel, setCurrentQuestionId, getTimesSeconds, flushEvents };
}
