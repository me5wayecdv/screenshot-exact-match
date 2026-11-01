import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

export function DataPager({
  page,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { t } = useI18n();
  return (
    <nav aria-label={t("pagination")} className="mt-4 flex items-center justify-between gap-3">
      <Button type="button" variant="outline" disabled={!hasPrevious} onClick={onPrevious}>
        {t("prev")}
      </Button>
      <span className="text-sm text-muted-foreground">
        {t("page")} {page + 1}
      </span>
      <Button type="button" variant="outline" disabled={!hasNext} onClick={onNext}>
        {t("next")}
      </Button>
    </nav>
  );
}
