import { t } from "../i18n/index.svelte";

/** " (n commits)" suffix of the branch menu's Push entry, with the singular for one commit. */
export const aheadLabel = (n: number) => (n === 1 ? t("app.aheadOne") : t("app.ahead", { n }));
