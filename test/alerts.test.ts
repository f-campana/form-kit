import { describe, expect, it } from "vitest";
import { atelierContact as config } from "../src/example/atelier-contact";
import {
  alertEmail,
  emailAlerter,
  MailerError,
  processDue,
  purgeDelivered,
  sendTestAlert,
  submitContact,
} from "../src/kit";
import { ALERTS, DAY, fakeMailer, MINUTE, REASON_VALUES, REASONS, setup, START, submission, VISITOR } from "./support";

const rejected = () => new MailerError("rejected_400", { retryable: false });
const alertFailures = (logs: string[]) => logs.filter((line) => line.includes('"event":"alert_failed"'));

describe("alerts", () => {
  describe("when an alert can't be sent", () => {
    it("keeps it, logs an error each time, and tries again later, waiting longer after each failure", async () => {
      const { deps, clock, store, alerts, failAlerts, logs } = setup({
        failWhen: (email) => !email.to.includes(VISITOR.email),
        failWith: rejected,
      });
      failAlerts(true);

      await submitContact(config, deps, await submission("devis", clock.now()));
      expect(alerts).toEqual([]);
      expect(store.records.get("sub-1")?.messages.notification).toMatchObject({ status: "failed" });
      expect(store.records.get("sub-1")?.messages.notification.alertedAt).toBeUndefined();
      expect(alertFailures(logs)).toHaveLength(1);
      expect(JSON.parse(alertFailures(logs)[0]!)).toEqual({
        level: "error",
        event: "alert_failed",
        id: "sub-1",
        message: "notification",
        error: "alert_channel_down",
      });

      expect(store.records.get("sub-1")?.messages.notification).toMatchObject({
        alertAttempts: 1,
        nextAlertAt: new Date(clock.now().getTime() + MINUTE).toISOString(),
      });

      // Not due yet: the worker leaves it alone.
      clock.advance(MINUTE - 1);
      expect(await processDue(config, deps)).toBe(0);
      clock.advance(1);
      await processDue(config, deps);
      expect(alerts).toEqual([]);
      expect(alertFailures(logs)).toHaveLength(2);
      expect(store.records.get("sub-1")?.messages.notification).toMatchObject({
        alertAttempts: 2,
        nextAlertAt: new Date(clock.now().getTime() + 5 * MINUTE).toISOString(),
      });

      failAlerts(false);
      clock.advance(5 * MINUTE);
      await processDue(config, deps);
      expect(alerts).toEqual([expect.objectContaining({ kind: "delivery_failed", message: "notification" })]);
      expect(store.records.get("sub-1")?.messages.notification.alertedAt).toBe(clock.now().toISOString());

      clock.advance(DAY);
      await processDue(config, deps);
      expect(alerts).toHaveLength(1);
      expect(alertFailures(logs)).toHaveLength(2);
    });

    it("still deletes the visitor's data after 7 days, and keeps trying the alert until it goes out", async () => {
      const { deps, clock, store, alerts, failAlerts } = setup({
        failWhen: (email) => email.to.includes(VISITOR.email),
        failWith: rejected,
      });
      failAlerts(true);

      await submitContact(config, deps, await submission("autre", clock.now()));
      expect(store.records.get("sub-1")?.messages.notification.status).toBe("sent");
      expect(store.records.get("sub-1")?.deliveredAt).toBe(START.toISOString());

      clock.advance(7 * DAY);
      await processDue(config, deps);
      expect(await purgeDelivered(config, deps)).toBe(1);
      const kept = store.records.get("sub-1");
      expect(kept).toMatchObject({ reason: "", data: {}, fingerprint: "" });
      expect(JSON.stringify(kept)).not.toContain(VISITOR.email);
      expect(await purgeDelivered(config, deps)).toBe(0);

      failAlerts(false);
      clock.advance(DAY);
      await processDue(config, deps);
      expect(alerts).toEqual([expect.objectContaining({ message: "confirmation", reference: kept?.reference })]);
      expect(await purgeDelivered(config, deps)).toBe(1);
      expect(store.records.has("sub-1")).toBe(false);
    });
  });

  describe("the alert email", () => {
    it("names the site, the reference, the message and the error", () => {
      const email = alertEmail(
        {
          kind: "delivery_failed",
          site: "Atelier",
          submissionId: "sub-9",
          reference: "7K3F9QXM",
          message: "confirmation",
          attempts: 3,
          lastError: "provider_503",
        },
        ALERTS,
      );

      expect(email).toEqual({
        from: ALERTS.from,
        to: ALERTS.to,
        subject: "Form alert: Atelier, confirmation not sent (7K3F9QXM)",
        text: expect.any(String),
      });
      expect(email.text.split("\n")).toEqual(
        expect.arrayContaining([
          "Site: Atelier",
          "Reference: 7K3F9QXM",
          "Submission: sub-9",
          "Message: the confirmation to the visitor",
          "Attempts: 3",
          "Error: provider_503",
        ]),
      );
    });

    it("carries no value the visitor submitted", async () => {
      const alertChannel = fakeMailer();
      const { deps, clock } = setup({ failWhen: () => true, failWith: rejected });
      const withEmailAlerts = { ...deps, alerter: emailAlerter(alertChannel.mailer, ALERTS) };

      for (const reason of REASONS) {
        await submitContact(config, withEmailAlerts, await submission(reason, clock.now()));
      }

      expect(alertChannel.sent).toHaveLength(2 * REASONS.length);
      const submitted = [...Object.values(VISITOR), ...REASONS, ...REASONS.flatMap((reason) => Object.values(REASON_VALUES[reason]))];
      for (const email of alertChannel.sent) {
        const everything = JSON.stringify(email);
        for (const value of submitted) expect(everything).not.toContain(value);
      }
    });
  });

  describe("the monthly test alert", () => {
    it("sends a test alert naming the site", async () => {
      const { deps, alerts, logs } = setup();

      await sendTestAlert(config, deps);

      expect(alerts).toEqual([{ kind: "test", site: config.siteName, sentAt: START.toISOString() }]);
      expect(logs.map((line) => JSON.parse(line))).toContainEqual({ level: "info", event: "test_alert_sent" });
    });

    it("logs an error and throws when it can't go out, so the scheduled job shows it failed", async () => {
      const { deps, failAlerts, logs } = setup();
      failAlerts(true);

      await expect(sendTestAlert(config, deps)).rejects.toThrow(MailerError);

      expect(logs.map((line) => JSON.parse(line))).toContainEqual({
        level: "error",
        event: "test_alert_failed",
        error: "alert_channel_down",
      });
    });

    it("is an email that says it's a test", () => {
      const email = alertEmail({ kind: "test", site: "Atelier", sentAt: START.toISOString() }, ALERTS);

      expect(email.subject).toBe("Form alert test: Atelier");
      expect(email.text).toContain("monthly test");
      expect(email.text).toContain("Atelier");
    });
  });
});
