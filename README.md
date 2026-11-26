# form-kit

The routed contact form from the cabinetmaker pilot (`pilot-spec.md` §3, a shared doc in the agent bridge's channel "p"), built as a small TypeScript core that a site copies in. It covers:

- validation;
- spam checks;
- the routing table;
- store-then-send delivery;
- retries and alerts;
- retention.

No web framework, database or email service is built in. Each site plugs those in through the interfaces in `src/kit/ports.ts`.

The decisions it follows (D4, D5, D8, D16, D19, D21…) are in `institutional-websites-decisions.md`, another shared doc in channel "p".

**Status, 18 November 2026:** the kit and its adapters are built and tested.

- **Form emails:** a live test sent both emails through Scaleway Transactional Email (11 November).
- **Alerts:** a live test alert went out through Amazon SES in Stockholm (17 November).
- **Database:** the real-server tests passed on a temporary Scaleway Managed PostgreSQL 17 instance, since deleted, with a site set up by `pnpm provision-site` (18 November).

Still to do, in the pilot site (FAB-54):

- the form page and the HTTP wrapper for Next.js;
- scheduling the worker and the purge on Vercel;
- checking that Vercel reaches the database.

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
  - `alerts.ts`: the alert emails and the monthly test alert.
  - `due.ts`: when the worker next has something to do for a submission, including the waits between alert retries.
  - `retention.ts`: the purge, 7 days after delivery (decision D8).
  - `messages.ts`: the notification and confirmation emails, in plain text.
  - `ports.ts`: the interfaces a site implements.
  - `memory.ts`: in-memory adapters for tests and local runs.
- `src/adapters/scaleway.ts`: sends the emails through Scaleway Transactional Email's HTTP API, and reads its settings from the environment.
- `src/adapters/postgres.ts`: keeps submissions and rate-limit hits in Postgres, through any client with a `query(text, params)` method: a `pg` Pool, Neon's serverless Pool, or PGlite. `migrateContactSchema` creates the tables and is safe to run on every deploy. Each operation is a single statement, so overlapping runs can't both take a delivery lease. The rate limit can let through one extra hit when a visitor's requests arrive at exactly the same moment.
- `src/adapters/postgres-site.ts`: `provisionSite`, which sets up one site's schema, tables and role (see below).
- `src/adapters/ses.ts`: sends alert emails through Amazon SES, signing requests itself, so the kit keeps one runtime dependency.
- `src/example/atelier-contact.ts`: the cabinetmaker's form. In the pilot it belongs in the site's own repository.
- `scripts/live-test.ts`: sends one sample quote request through a real Scaleway account.
- `scripts/alert-test.ts`: sends one test alert through Amazon SES (`pnpm alert-test`).
- `scripts/provision-site.ts`: sets up one site's schema and role (`pnpm provision-site <site>`).
- `test/`: the spec's acceptance tests, and unit tests.

## What a visitor can get back

`submitContact` returns one of these, and the page shows the matching message:

- **accepted:** the message is stored, with a reference to quote. With the host's `waitUntil` passed as `defer`, the emails go out after the answer; without it, `submitContact` sends them before answering. A honeypot hit gets this too, with nothing stored (decision D5).
- **retry:** the form was sent too fast, or its token is missing, invalid, expired or already used for other content. The page asks the visitor to check their message and send it again, with the fields still filled in (D5).
- **invalid:** a field is wrong; each error is in plain French.
- **rate_limited:** more than 5 forms from one visitor within an hour.
- **unavailable:** the message couldn't be stored, so nothing is sent.

**Single-use tokens (D21):** each form token is valid for 24 hours and stores one submission. Recording the token and storing the message are one step. If the same token arrives again with the same content (a double click, or a retry after a lost answer), the visitor gets the original reference and the replay sends nothing. This covers repeated requests only: delivery itself is at least once (see below).

## What a site provides

- **Storage:** a database for submissions and rate-limit hits, implementing `SubmissionStore` and `RateLimiter`. The in-memory versions don't work on serverless hosts, because instances don't share memory.
- **Email:** a `Mailer` for the site's email service. It sets a timeout and throws `MailerError` with a code that contains no addresses or message contents.
- **Alerts:** an `Alerter` that doesn't go through that email service. The kit ships `emailAlerter` with the Amazon SES adapter (`src/adapters/ses.ts`, Stockholm by default, decision D19). Its settings are `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `ALERT_FROM` and `ALERT_TO`; `pnpm alert-test` sends the monthly test alert.
- **Secret:** `FORM_SECRET` in the environment, at least 32 characters.
- **Three entry points:**
  - the form's POST calls `submitContact`, with the host's `waitUntil` as `defer`;
  - a schedule calls `processDue`, more often than the shortest retry delay;
  - a daily job calls `purgeDelivered`.
- **A contact page rendered per request.** The form token carries the time the page was served, and a page built in advance would carry its build time instead.

## Setting up a site's database

Each client site has its own Scaleway PostgreSQL instance (decision D16): set it up with `--dedicated-instance`, as described in [One instance per site](#one-instance-per-site-scaleway). The command also has a stricter default for sites sharing one database, kept for a database that allows it; it doesn't work on Scaleway's managed `rdb`. In both modes, each site gets a schema `site_<name>` with its tables, and a login role of the same name that can read and write those tables. In the strict mode the role reaches nothing else; the dedicated mode also accepts what the console's Read permission adds. You run the setup yourself, with the administrator's connection in `ADMIN_DATABASE_URL`:

```bash
pnpm provision-site atelier
```

- **The first run** creates the role and prints the site's `DATABASE_URL` once. Put it in the site's settings and nowhere else. Later runs upgrade the tables and leave the password alone; `--rotate-password` sets a new one.
- **The password** reaches the database only as a SCRAM hash, so it can't show up in the server's statement logs.
- **Connections:** the role may hold 10 at once (`--connection-limit=N` changes it), so one site can't use up the database's connections.
- **All or nothing:** before and after setting the site up, it checks that the site would be isolated. If a check or a step fails, it changes nothing and lists what it found. It never removes rights it didn't grant: you fix those by hand, then run it again. One exception: if the connection drops during the final commit, the script can't know whether the commit happened. Run it again to find out: it's safe to repeat. If it says the role already existed, add `--rotate-password` to get a connection URL.
- **Managed databases:** it needs an administrator that can create roles, not a superuser. That's how Scaleway's admin user works.

### One instance per site (Scaleway)

On a managed Scaleway database, the admin can't grant a role the right to connect; only the console can, and its "Read" permission also gives rights on the whole database, on `public`, and default rights for future objects. So a Scaleway instance holds **one site**, set up with `--dedicated-instance`:

1. `pnpm provision-site atelier --dedicated-instance` creates the schema, tables and role, prints the `DATABASE_URL` once, and, if the role can't connect, tells you the console step (exit code 2).
2. In the console, set the role's permission on the database to **Read**. Read replaces the table rights with read-only ones.
3. Run the same command again: it restores the site's rights and checks the result.

This mode accepts only what Read adds (connect and temporary on this database, usage on `public`, the provider's own read-level default privileges in `public` and the site's schema) and refuses anything else, as well as a second `site_*` schema or role: those rights would reach it. The strict rule above stays the default. Either mode refuses `dblink`, `postgres_fdw` and `file_fdw` **when installed**.

**What a pass doesn't show.** `--check` reads the catalog: it doesn't log in as the site, run its queries or restore anything, so after a restore, also submit a test message (see below). A site role may be able to install one of the refused extensions later (one probe on a throwaway database could create `dblink`); the check can't rule that out. The one-site rule sees only `site_*` schemas and roles, so it can't tell that another client uses the instance under other names.

**Check after any restore or permission change in the console:**

```bash
pnpm provision-site atelier --dedicated-instance --check
```

It changes nothing and exits 1 with the problems it finds, including missing tables, columns or indexes, rights the site has lost, and rights held with grant option. A restore can silently change rights. Read what it reports before changing anything: running setup again can restore the site's table rights, but it refuses a site that holds rights it didn't expect, and it can't help if the administrator can't connect. After a restore that took away the site's right to connect, follow [Restoring a backup over the same database](#restoring-a-backup-over-the-same-database). In the URL the site uses, replace the IP with the instance's hostname and drop `sslmode` and `sslrootcert`: a site on Vercel passes the certificate as text (`DATABASE_CA`).

#### Restoring a backup over the same database

Tested once, on 26 November 2026: a manual backup restored over `rdb` from the console, on an instance holding one site with test data only and every message delivered. This is what was observed, not a promise from Scaleway.

**What happened.** The data went back to the time of the backup: anything stored later was gone, although its emails had already been sent. In the permissions and structure compared (owners, roles, memberships, rights, default rights, indexes, constraints), the one difference was that the site role had **lost the right to connect** and to create temporary tables. Two things looked fine while the site was locked out: the console still showed the role's permission as "Custom", and the contact page still loaded.

**Before restoring.** A restore overwrites the database, and what it overwrites can't be recovered from it. Wait until the backup shows as ready.

**Recover.** These steps are only for what this test showed: the site's existing role can no longer connect. First run the check:

```bash
pnpm provision-site atelier --dedicated-instance --check
```

In this test it reported one problem: `site_atelier can't connect to this database (set it in the console)`. It didn't mention temporary tables; a separate comparison of the database's rights showed that right was gone too. If the administrator can't connect, or the check reports anything else or something you can't explain, stop and find the cause before changing anything.

1. In the console, set the role's permission on the database to **Read**. It can connect again, but its table rights are now read-only.
2. Run setup: `pnpm provision-site atelier --dedicated-instance`. It restores the table rights and keeps the password. Don't skip this after choosing Read. It must end with exit code 0: code 2 means the role still can't connect, and code 1 is an error. Either way the site isn't recovered.
3. Run the check again. It must pass (exit code 0) before the next step.
4. Prove that the site really uses the database: send a test message and see it stored, with both emails sent. A page that loads proves nothing. A retry-and-purge job, if the site has one, also logs in to the database (here it failed with `permission denied for database "rdb"` before step 1), but it can send emails and delete data: look at what is due first.

**Not tested, and needed before restoring a site with real visitors:**

- Stop form posts and jobs, and let requests in progress finish.
- Take a second backup right before overwriting.
- Decide what to do about delivery state, form tokens and rate limits, which all go back in time: a message that was pending in the backup could be sent again.
- Have a plan if the administrator can't connect.
- Restoring into a new database or instance, and point-in-time recovery.

The steps haven't been tried with the `scw` command line. Its `readonly` permission is documented as the console's Read, but whether it changes table rights the same way is untested.

## Live test with Scaleway

These steps happen in your own Scaleway account. Neither agent creates accounts or handles the key.

1. **Account:** create a Scaleway account and a Project. Scaleway may ask for a payment method and an identity check. The first 300 emails a month are free.
2. **Domain:** in Transactional Email, add a domain or subdomain you control, in the Paris region (fr-par, the only one). A subdomain kept for tests works.
3. **DNS:** add the DNS records Scaleway lists for that domain, then wait until it shows as checked. Scaleway doesn't support a nested SPF `include`.
4. **API key:** in IAM, create an application whose policy grants only `TransactionalEmailEmailApiCreate` on that Project. Create an API key for it.
5. **Settings:** copy `.env.example` to `.env.local`, and fill in the key, the Project ID, a sender on the checked domain, and your inbox.
6. **Run:** `pnpm live-test`. Two emails arrive in your inbox:
   - the notification, which you can answer straight to the visitor;
   - the visitor's confirmation: a thank-you, the reference and the chosen reason, never a copy of the message (decision D4).

   The script prints each message's state. Scaleway accepts an email and sends it a few seconds later, so check the inbox too, and the spam folder.

## Choices made while building it

- **Field names:** they're unique across reasons. Without JavaScript, the browser submits every reason's fields, and duplicate names would collide.
- **Suspected spam:** it gets the same answer as a real submission. Nothing is stored or sent.
- **Separate tracking:** the notification and the confirmation are tracked separately, so a retry never resends a message that already went out.
- **At least once:** if a run crashes after sending but before saving, the next run sends that message again.
- **Retries:** a message that fails is tried again after 5 minutes, then 30 minutes. After that it has failed for good, and the developer is alerted.
- **Rejections aren't retried:** when the email service rejects a message as invalid (HTTP 400 or 404 from Scaleway), the developer is alerted at once instead of after the retries. A wrong or revoked key (401, 403) is retried, since it can be fixed within the hour.
- **Alerts are retried until they go out,** waiting 1, 5, 15, then 60 minutes between attempts, so alerts that keep failing never hold up other messages. They carry the site, the reference, which message failed and the error code, never visitor data.
- **Retention (D8):** 7 days after the notification is sent and the confirmation is settled, the purge deletes the submission. If an alert about it still hasn't gone out, only the visitor's data is deleted, and the rest goes once the alert has. A submission whose notification failed is kept until someone handles it.
- **No bounce detection yet:** Scaleway accepting an email doesn't mean it arrived. A later bounce isn't reported back to the kit. Checking each email's status a few minutes later would catch it.
- **Logs:** they carry event names, IDs and error codes, never visitor data.
- **Required choices:** "Type de projet" and "Calendrier souhaité" are required, since each has an "Autre" or "Je ne sais pas encore" option. The spec doesn't say either way.
- **No reply time:** the confirmation promises none, as the French copy asks ("Ne pas inventer de délai").

## Tests

`pnpm test` runs 186 tests, including every acceptance test in `pilot-spec.md` §3 that doesn't need a browser.

- **Adapters:** the Scaleway adapter's tests check its requests against Scaleway's documented format, using a stand-in for the API. The SES adapter's signature is checked against the AWS SDK's own signer.
- **Stores:** the store tests run the same checks against the in-memory store and against Postgres, using PGlite, an in-process Postgres.
- **A real server:** 14 more tests run when `TEST_DATABASE_URL` points at one, with an administrator that can create roles:

  ```bash
  TEST_DATABASE_URL=postgres://user:password@host:5432/database pnpm test
  ```

  They cover concurrent inserts, the delivery lease, the rate limit, isolation between sites, the connection limit and logging in with the hashed password. They passed on PostgreSQL 17 locally and on Scaleway's Managed PostgreSQL 17 (18 November), and they remove what they create.
- **Live sends:** both form emails reached Fabien's Gmail inbox through Scaleway (11 November), and so did a test alert through SES (17 November).

To check that the tests catch real faults, I made seventeen deliberate breakages, one at a time, and the matching test failed each time:

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

Two more since: retrying failed alerts without waiting, and saving a delivery run over a purge that ran meanwhile.

These still need a browser:

- the form without JavaScript;
- the errors, checked with a keyboard and a screen reader.
