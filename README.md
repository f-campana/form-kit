# form-kit

The routed contact form from the cabinetmaker pilot (`pilot-spec.md` §3, a shared doc in the agent bridge's channel "p"), built as a small TypeScript core that a site copies in. It covers:

- validation;
- spam checks;
- the routing table;
- store-then-send delivery;
- retries and alerts;
- retention.

No web framework, database or email service is built in. Each site plugs those in through the interfaces in `src/kit/ports.ts`.

**Status, 11 November 2026:** the core is built and tested with in-memory adapters. The adapter for Scaleway Transactional Email, the email service Fabien chose, is built too. It's tested against a stand-in for Scaleway's API, not the live service yet. Still to do:

- the live Scaleway test (see below);
- the form page;
- the HTTP wrapper for the chosen framework;
- connecting the Postgres adapter to a hosted database;
- scheduling on the host.

## Commands

```bash
pnpm install
pnpm check   # type check, then the tests
```

## Layout

- `src/kit/`: the kit itself, copied into each site.
  - `define.ts`: the configuration and its checks. A bad routing table throws, so the site's build fails.
  - `fields.ts`: field builders with plain-French errors.
  - `parse.ts`: server validation.
  - `spam.ts`: the signed form token for the minimum fill time, and the hashed visitor key for the rate limit.
  - `submit.ts`: handles one submission.
  - `delivery.ts`: sending, retries and alerts.
  - `retention.ts`: the 30-day purge.
  - `messages.ts`: the notification and confirmation emails, in plain text.
  - `ports.ts`: the interfaces a site implements.
  - `memory.ts`: in-memory adapters for tests and local runs.
- `src/adapters/scaleway.ts`: sends the emails through Scaleway Transactional Email's HTTP API, and reads its settings from the environment.
- `src/adapters/postgres.ts`: keeps submissions and rate-limit hits in Postgres, through any client with a `query(text, params)` method: a `pg` Pool, Neon's serverless Pool, or PGlite. `migrateContactSchema` creates the tables and is safe to run on every deploy. Each operation is a single statement, so overlapping runs can't both take a delivery lease. The rate limit can let through one extra hit when a visitor's requests arrive at exactly the same moment.
- `src/example/atelier-contact.ts`: the cabinetmaker's form. In the pilot it belongs in the site's own repository.
- `scripts/live-test.ts`: sends one sample quote request through a real Scaleway account.
- `test/`: the spec's acceptance tests, and unit tests.

## What a site provides

- **Storage:** a database for submissions and rate-limit hits, implementing `SubmissionStore` and `RateLimiter`. The in-memory versions don't work on serverless hosts, because instances don't share memory.
- **Email:** a `Mailer` for the site's email service. It sets a timeout and throws `MailerError` with a code that contains no addresses or message contents.
- **Alerts:** an `Alerter` that doesn't go through that email service, for example a webhook.
- **Secret:** `FORM_SECRET` in the environment, at least 32 characters.
- **Three entry points:**
  - the form's POST calls `submitContact`, with the host's `waitUntil` as `defer`;
  - a schedule calls `processDue`, more often than the shortest retry delay;
  - a daily job calls `purgeDelivered`.
- **A contact page rendered per request.** The form token carries the time the page was served, and a page built in advance would carry its build time instead.

## Live test with Scaleway

These steps happen in your own Scaleway account. Neither agent creates accounts or handles the key.

1. **Account:** create a Scaleway account and a Project. Scaleway may ask for a payment method and an identity check. The first 300 emails a month are free.
2. **Domain:** in Transactional Email, add a domain or subdomain you control, in the Paris region (fr-par, the only one). A subdomain kept for tests works.
3. **DNS:** add the DNS records Scaleway lists for that domain, then wait until it shows as checked. Scaleway doesn't support a nested SPF `include`.
4. **API key:** in IAM, create an application whose policy grants only `TransactionalEmailEmailApiCreate` on that Project. Create an API key for it.
5. **Settings:** copy `.env.example` to `.env.local`, and fill in the key, the Project ID, a sender on the checked domain, and your inbox.
6. **Run:** `pnpm live-test`. Two emails arrive in your inbox:
   - the notification, which you can answer straight to the visitor;
   - the visitor's copy.

   The script prints each message's state. Scaleway accepts an email and sends it a few seconds later, so check the inbox too, and the spam folder.

## Choices made while building it

- **Field names:** they're unique across reasons. Without JavaScript, the browser submits every reason's fields, and duplicate names would collide.
- **Suspected spam:** it gets the same answer as a real submission. Nothing is stored or sent.
- **Separate tracking:** the notification and the confirmation are tracked separately, so a retry never resends a message that already went out.
- **At least once:** if a run crashes after sending but before saving, the next run sends that message again.
- **Rejections aren't retried:** when the email service rejects a message as invalid (HTTP 400 or 404 from Scaleway), the developer is alerted at once instead of after the retries. A wrong or revoked key (401, 403) is retried, since it can be fixed within the hour.
- **No bounce detection yet:** Scaleway accepting an email doesn't mean it arrived. A later bounce isn't reported back to the kit. Checking each email's status a few minutes later would catch it.
- **Logs:** they carry event names, IDs and error codes, never visitor data.
- **Required choices:** "Type de projet" and "Calendrier souhaité" are required, since each has an "Autre" or "Je ne sais pas encore" option. The spec doesn't say either way.
- **No reply time:** the confirmation promises none, as the French copy asks ("Ne pas inventer de délai").

## Tests

`pnpm test` runs 72 tests, including every acceptance test in `pilot-spec.md` §3 that doesn't need a browser. The Scaleway adapter's tests check its requests against Scaleway's documented format, using a stand-in for the API. On 11 November a live test sent both emails through Scaleway, and both reached Fabien's Gmail inbox. The store tests run the same checks against the in-memory store and against Postgres, using PGlite, an in-process Postgres; no hosted database has been tried yet. To check that the tests catch real faults, I made seventeen deliberate breakages, one at a time, and the matching test failed each time:

- routing to every recipient;
- no honeypot check;
- sending without storing;
- no alert;
- resending a sent message;
- an email address in the logs;
- keeping smuggled fields;
- ignoring the delivery lease;
- no minimum fill time;
- no recipient check;
- retrying a rejected email;
- dropping the Reply-To header;
- unescaped HTML;
- retrying Scaleway's rejections;
- ignoring the Postgres delivery lease;
- ignoring the Postgres rate limit;
- purging undelivered submissions.

These still need a browser:

- the form without JavaScript;
- the errors, checked with a keyboard and a screen reader.
