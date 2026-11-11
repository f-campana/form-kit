/**
 * Sends one sample quote request through the real Scaleway account, using the
 * cabinetmaker's form with every recipient replaced by FORM_TEST_INBOX: the
 * notification and the visitor's copy both arrive there. Needs a domain checked
 * in Scaleway Transactional Email and the variables in .env.example, written to
 * .env.local.
 *
 *   pnpm live-test
 */
import { z } from "zod";
import { scalewayMailer, scalewayOptionsFromEnv } from "../src/adapters/scaleway";
import { atelierContact } from "../src/example/atelier-contact";
import {
  consoleLogger,
  defineContactForm,
  issueFormToken,
  memoryRateLimiter,
  memoryStore,
  submitContact,
  systemClock,
  type Alerter,
  type ContactDeps,
} from "../src/kit";

const TestEnv = z.object({ FORM_SENDER: z.email(), FORM_TEST_INBOX: z.email() });
const env = TestEnv.safeParse(process.env);
if (!env.success) {
  const names = [...new Set(env.error.issues.map((issue) => String(issue.path[0])))];
  console.error(`Missing or invalid in .env.local: ${names.join(", ")}. See .env.example.`);
  process.exit(1);
}
const { FORM_SENDER: sender, FORM_TEST_INBOX: inbox } = env.data;

const config = defineContactForm({
  ...atelierContact,
  from: sender,
  confirmationReplyTo: sender,
  recipients: { fondateur: [inbox], atelier: [inbox] },
});

const alerter: Alerter = {
  async alert(alert) {
    console.error("ALERT", JSON.stringify(alert));
  },
};
const store = memoryStore();
const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
const deps: ContactDeps = {
  store,
  mailer: scalewayMailer({ ...scalewayOptionsFromEnv(process.env), fromName: "Formulaire de test" }),
  alerter,
  rateLimiter: memoryRateLimiter(),
  clock: systemClock,
  logger: consoleLogger,
  secret,
  newId: () => crypto.randomUUID(),
};

const shownAt = new Date(Date.now() - 60_000);
const result = await submitContact(config, deps, {
  reason: "devis",
  name: "Camille Durand (test)",
  email: inbox,
  phone: "06 12 34 56 78",
  projectType: "Cuisines et rangements",
  commune: "Créon",
  description: "Message de test du formulaire de contact.\nAucune action n’est attendue.",
  timeline: "Je ne sais pas encore",
  website: "",
  formToken: await issueFormToken(secret, shownAt),
});

console.log("Result:", JSON.stringify(result));
for (const record of store.records.values()) {
  console.log("Notification:", JSON.stringify(record.messages.notification));
  console.log("Confirmation:", JSON.stringify(record.messages.confirmation));
}
