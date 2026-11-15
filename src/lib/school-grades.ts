/** New choices use explicit stage names. Existing free-text values stay untouched. */
export const EGYPTIAN_SCHOOL_GRADES = [
  { value: "الصف الأول الابتدائي", en: "Primary 1" },
  { value: "الصف الثاني الابتدائي", en: "Primary 2" },
  { value: "الصف الثالث الابتدائي", en: "Primary 3" },
  { value: "الصف الرابع الابتدائي", en: "Primary 4" },
  { value: "الصف الخامس الابتدائي", en: "Primary 5" },
  { value: "الصف السادس الابتدائي", en: "Primary 6" },
  { value: "الصف الأول الإعدادي", en: "Preparatory 1" },
  { value: "الصف الثاني الإعدادي", en: "Preparatory 2" },
  { value: "الصف الثالث الإعدادي", en: "Preparatory 3" },
  { value: "الصف الأول الثانوي", en: "Secondary 1" },
  { value: "الصف الثاني الثانوي", en: "Secondary 2" },
  { value: "الصف الثالث الثانوي", en: "Secondary 3" },
] as const;
export function hasStandardSchoolGrade(value: string): boolean {
  return EGYPTIAN_SCHOOL_GRADES.some((grade) => grade.value === value);
}
