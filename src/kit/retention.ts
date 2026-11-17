import type { ContactFormConfig } from "./define";
import type { ContactDeps } from "./submit";

const DAY_MS = 24 * 60 * 60_000;

/**
 * Deletes submissions delivered more than `retentionDays` ago (decision D8).
 * The store is only a delivery buffer. Submissions whose notification failed
 * are kept for manual follow-up. If an alert about a submission still hasn't
 * gone out, only the visitor's data is deleted, and the rest goes once the
 * alert has. Returns how many submissions lost their data. The host runs this
 * daily.
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
