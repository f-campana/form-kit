/**
 * Sends one test alert through Amazon SES: the same one the monthly job
 * sends. Use it once the AWS account is set up, to check the key, the
 * region and the addresses. Put these in .env.local (never committed):
 *
 *   SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY   a key allowed only ses:SendEmail
 *   SES_REGION                                 optional, eu-north-1 (Stockholm) by default
 *   ALERT_FROM                                 a verified sender address
 *   ALERT_TO                                   verified recipient addresses, comma-separated
 *
 *   pnpm alert-test
 */
import { sesMailer, sesOptionsFromEnv } from "../src/adapters/ses";
import { atelierContact as config } from "../src/example/atelier-contact";
import { consoleLogger, emailAlerter, sendTestAlert, systemClock } from "../src/kit";

try {
  const { ses, alerts } = sesOptionsFromEnv(process.env);
  await sendTestAlert(config, { alerter: emailAlerter(sesMailer(ses), alerts), clock: systemClock, logger: consoleLogger });
  console.log(`SES accepted the test alert for ${alerts.to.length} address(es). Check the inbox.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
