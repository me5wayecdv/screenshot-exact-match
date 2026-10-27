# Paper grading (handwritten exams)

The `/handwritten` page grades photographed exam papers. The AI
determines the final grade, adopted automatically on save — the
teacher's control point is reviewing and correcting the OCR text
before grading. A wrong saved record is deleted from history and
re-graded.

## Single-photo flow

One photo = one question (or an ad-hoc question without an
assessment). The photo is client-compressed (≤1600px JPEG) and
uploaded immediately on select to the private `handwritten-papers`
bucket (`{teacher_id}/{uuid}.jpg`, folder-based RLS); saving is
blocked if the upload failed, so no photo is silently lost. OCR uses
a vision-capable model through the shared AI config (`AI_VISION_MODEL`
override, else `AI_MODEL`), with error codes for unconfigured /
unsupported / upstream / timeout (90s) / parse failures. Uncertain
OCR spans are wrapped in ⟦ ⟧ by the model and highlighted in review
— they are the model's own estimates, not measured confidence.

## Batch flow (Phase 3) + completion (Phase 6)

With an assessment selected, up to 10 page photos can be queued:

- **Matching**: each page is matched to a question — by its visible
  number first (high confidence), then by AI content match, then
  manually. Re-running a match only sends pages without text, so a
  partial failure costs one retry of the failed pages.
- **Queue**: every queued page has an editable student name (prefilled
  into the grade form) and a graded flag. Removing a page deletes its
  stored photo best-effort.
- **Grading loop**: "use this answer" prefills the SAME single-grade
  form — no second grading path. On save, the page is marked graded,
  the form's student name (if corrected) is written back to the queue
  item, and the next ungraded page auto-loads with a progress toast
  ("saved N of M"). When the queue is done, a completion toast shows.
- **History**: saved grades list with corrected-text snippets, paper
  preview via signed URL, and delete (which removes the stored paper
  best-effort). Similar-answer grouping (Arabic-normalized Jaccard
  ≥0.55, per question) is shown neutrally for review only — never as
  proof of copying.

## Notes and limits

- Re-using an already-graded queue page creates a second history row
  (save always inserts). To fix a wrong grade, delete the wrong row
  from history and re-grade.
- The queue itself is browser state: leaving the page loses the
  queue (photos already uploaded stay orphaned in the bucket until
  graded or removed). Persisting the queue would need a new table.
- English pages are transcribed in English (language-preservation
  line in both vision prompts); a live English-page test is still
  owed in the pilot checklist.
