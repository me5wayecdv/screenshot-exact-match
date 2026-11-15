import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SchoolGradeSelect } from "@/components/school-grade-select";
import { I18nProvider } from "@/lib/i18n";
import { EGYPTIAN_SCHOOL_GRADES } from "@/lib/school-grades";
import { afterEach } from "vitest";
afterEach(cleanup);
describe("Egyptian grade labels without legacy data reinterpretation", () => {
  it("offers six primary, three preparatory and three secondary years", () => {
    expect(EGYPTIAN_SCHOOL_GRADES).toHaveLength(12);
    expect(EGYPTIAN_SCHOOL_GRADES[0]?.value).toBe("الصف الأول الابتدائي");
    expect(EGYPTIAN_SCHOOL_GRADES[11]?.value).toBe("الصف الثالث الثانوي");
    expect(EGYPTIAN_SCHOOL_GRADES.filter((g) => g.value.includes("الابتدائي"))).toHaveLength(6);
    expect(EGYPTIAN_SCHOOL_GRADES.filter((g) => g.value.includes("الإعدادي"))).toHaveLength(3);
    expect(EGYPTIAN_SCHOOL_GRADES.filter((g) => g.value.includes("الثانوي"))).toHaveLength(3);
  });
  it.each(["8", "الصف الثامن", "9", "الأول الثانوي", ""])(
    "keeps existing value %s exactly, without writing a replacement",
    (value) => {
      const onChange = vi.fn();
      render(
        <I18nProvider>
          <SchoolGradeSelect id="grade" value={value} onChange={onChange} />
        </I18nProvider>,
      );
      expect(screen.getByRole("combobox")).toHaveValue(value);
      expect(onChange).not.toHaveBeenCalled();
    },
  );
  it("writes only the explicit grade chosen by the teacher", () => {
    const onChange = vi.fn();
    render(
      <I18nProvider>
        <SchoolGradeSelect id="grade" value="8" onChange={onChange} />
      </I18nProvider>,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "الصف الثالث الثانوي" } });
    expect(onChange).toHaveBeenCalledWith("الصف الثالث الثانوي");
  });
});
