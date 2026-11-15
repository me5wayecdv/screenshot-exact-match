import { useI18n } from "@/lib/i18n";
import { EGYPTIAN_SCHOOL_GRADES, hasStandardSchoolGrade } from "@/lib/school-grades";

export function SchoolGradeSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { lang } = useI18n();
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <option value="">{lang === "ar" ? "اختر الصف الدراسي" : "Choose grade level"}</option>
      {value && !hasStandardSchoolGrade(value) && <option value={value}>{value}</option>}
      {EGYPTIAN_SCHOOL_GRADES.map((grade) => (
        <option key={grade.value} value={grade.value}>
          {lang === "ar" ? grade.value : grade.en}
        </option>
      ))}
    </select>
  );
}
