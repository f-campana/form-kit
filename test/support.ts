import {
  issueFormToken,
  MailerError,
  memoryRateLimiter,
  memoryStore,
  type Alert,
  type Alerter,
  type ContactDeps,
  type Logger,
  type Mailer,
  type OutgoingEmail,
} from "../src/kit";

export const SECRET = "test-secret-that-is-at-least-32-characters-long";
export const START = new Date("2026-11-11T09:00:00.000Z");
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

/** Where alerts go: the developer's verified address, from a verified sender. */
export const ALERTS = { from: "alertes@example.test", to: ["fabien@example.test"] };

export function manualClock(start = START) {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}

type FailWhen = (email: OutgoingEmail) => boolean;

/**
 * Records every attempt, and fails the ones `failWhen` picks with `failWith`'s
 * error: by default a retryable outage.
 */
export function fakeMailer(
  failWhen: FailWhen = () => false,
  failWith: () => Error = () => new MailerError("provider_unavailable"),
) {
  const attempts: OutgoingEmail[] = [];
  const sent: OutgoingEmail[] = [];
  let fails = failWhen;
  const mailer: Mailer = {
    async send(email) {
      attempts.push(email);
      if (fails(email)) throw failWith();
      sent.push(email);
    },
  };
  return {
    mailer,
    attempts,
    sent,
    failWhen(next: FailWhen) {
      fails = next;
    },
  };
}

/** Records the alerts that go out. While `failing()` is true, alerts fail and aren't recorded. */
export function recordingAlerter() {
  const alerts: Alert[] = [];
  let failing = false;
  const alerter: Alerter = {
    async alert(alert) {
      if (failing) throw new MailerError("alert_channel_down");
      alerts.push(alert);
    },
  };
  return {
    alerter,
    alerts,
    fail(next: boolean) {
      failing = next;
    },
  };
}

export function recordingLogger() {
  const lines: string[] = [];
  const logger: Logger = {
    info: (event, fields) => lines.push(JSON.stringify({ level: "info", event, ...fields })),
    error: (event, fields) => lines.push(JSON.stringify({ level: "error", event, ...fields })),
  };
  return { logger, lines };
}

/** Fresh in-memory dependencies, a clock that only moves when told, and IDs sub-1, sub-2… */
export function setup(options: { failWhen?: FailWhen; failWith?: () => Error } = {}) {
  const clock = manualClock();
  const store = memoryStore();
  const mail = fakeMailer(options.failWhen, options.failWith);
  const { alerter, alerts, fail: failAlerts } = recordingAlerter();
  const { logger, lines } = recordingLogger();
  const rateLimiter = memoryRateLimiter();
  let next = 0;
  const deps: ContactDeps = {
    store,
    mailer: mail.mailer,
    alerter,
    rateLimiter,
    clock,
    logger,
    secret: SECRET,
    newId: () => `sub-${++next}`,
  };
  return { deps, clock, store, mail, alerts, failAlerts, logs: lines, rateLimiter };
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * The same token written differently: the signature's last character carries
 * two unused bits, so changing them gives a string that still verifies.
 */
export function respelled(token: string): string {
  const last = BASE64URL.indexOf(token.slice(-1));
  return token.slice(0, -1) + BASE64URL[last ^ 1];
}

export const REASONS = ["devis", "visite", "suivi", "autre"] as const;
export type Reason = (typeof REASONS)[number];

export const VISITOR = {
  name: "Camille Durand",
  email: "camille.durand@example.org",
  phone: "06 12 34 56 78",
};

/** What a visitor would type for each reason. */
export const REASON_VALUES: Record<Reason, Record<string, string>> = {
  devis: {
    projectType: "Cuisines et rangements",
    commune: "Créon",
    description: "Une cuisine en chêne pour une pièce de 12 m².\nAvec un îlot central.",
    dimensions: "4 m × 3 m",
    timeline: "Dans les 3 mois",
    budget: "10 000 à 20 000 €",
  },
  visite: { availability: "Le samedi matin, ou en semaine après 17 h." },
  suivi: { project: "Bibliothèque sous pente à Sadirac", followUp: "Pouvez-vous me confirmer la date de pose ?" },
  autre: { message: "Proposez-vous des stages d’initiation ?" },
};

/**
 * A complete submission for `reason`, as the form would send it: honeypot
 * empty, form token issued a minute before `now`. `overrides` replaces fields.
 */
export async function submission(
  reason: Reason,
  now: Date,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    reason,
    ...VISITOR,
    ...REASON_VALUES[reason],
    website: "",
    formToken: await issueFormToken(SECRET, new Date(now.getTime() - MINUTE)),
    ...overrides,
  };
}
