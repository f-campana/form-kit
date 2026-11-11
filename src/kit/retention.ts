import type { ContactFormConfig } from "./define";
import type { ContactDeps } from "./submit";

const DAY_MS = 24 * 60 * 60_000;

/**
 * Deletes submissions delivered more than `retentionDays` ago. The store is
 * only a delivery buffer. Submissions whose notification failed are kept for
 * manual follow-up. The host runs this daily.
 */
export async function purgeDelivered(
  config: ContactFormConfig,
  deps: Pick<ContactDeps, "store" | "clock" | "logger">,
): Promise<number> {
  const cutoff = new Date(deps.clock.now().getTime() - config.retentionDays * DAY_MS);
  const count = await deps.store.deleteDeliveredBefore(cutoff);
  deps.logger.info("submissions_purged", { count });
  return count;
}
