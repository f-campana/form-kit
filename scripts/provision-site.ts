/**
 * Sets up one site in its database: its schema, its tables and a role that
 * reads and writes them. Run it yourself, with the administrator's
 * connection in ADMIN_DATABASE_URL (in .env.local, never committed):
 *
 *   pnpm provision-site atelier
 *
 * The first run creates the role and prints the site's connection URL once.
 * It contains the role's password: put it in the site's DATABASE_URL setting
 * and nowhere else. Later runs upgrade the tables and leave the password
 * alone; add --rotate-password to set a new one. The password is sent to the
 * database only as a SCRAM hash, so it never appears in the server's logs.
 *
 * The role may hold 10 connections at once; --connection-limit=N changes it.
 *
 * On a Scaleway instance that holds this one site, add --dedicated-instance:
 * it accepts what the console adds when you let the role connect, and refuses a
 * second site. --check changes nothing and lists what is wrong; run it after
 * any restore or console permission change.
 *
 * It's all or nothing: when the site wouldn't be isolated (for example a role
 * of that name that already has other rights) or a step fails, it changes
 * nothing. It lists what it found; fix those by hand, then run it again.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { checkSite, consoleConnectStep, provisionSite } from "../src/adapters/postgres-site";

const [site, ...flags] = process.argv.slice(2);
const adminUrl = process.env["ADMIN_DATABASE_URL"];
if (site === undefined || adminUrl === undefined) {
  console.error(
    "Usage: pnpm provision-site <site> [--dedicated-instance] [--check] [--rotate-password] [--connection-limit=N], with ADMIN_DATABASE_URL set in .env.local",
  );
  process.exit(1);
}
const KNOWN = ["--rotate-password", "--dedicated-instance", "--check"];
const unknown = flags.filter((flag) => !KNOWN.includes(flag) && !flag.startsWith("--connection-limit="));
if (unknown.length > 0) {
  console.error(`Unknown option: ${unknown.join(", ")}`);
  process.exit(1);
}
const rotatePassword = flags.includes("--rotate-password");
const dedicatedInstance = flags.includes("--dedicated-instance");
const check = flags.includes("--check");
const limitFlag = flags.find((flag) => flag.startsWith("--connection-limit="));
const connectionLimit = limitFlag === undefined ? undefined : Number(limitFlag.split("=")[1]);

const password = randomBytes(24).toString("base64url");
// One connection: setup runs as a single transaction.
const admin = new pg.Client({ connectionString: adminUrl });
async function runCheck(): Promise<void> {
  const problems = await checkSite(admin, site!, { dedicatedInstance });
  if (problems.length === 0) {
    console.log(`Site ${site} passes the check. Nothing was changed.`);
    console.log(
      "This reads the catalog only: it doesn't log in as the site or run its queries, and it can't show that an extension can't be installed later.",
    );
    return;
  }
  console.error(`Site ${site} fails the check. Nothing was changed:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  process.exitCode = 1;
}

async function runSetup(): Promise<void> {
  const result = await provisionSite(admin, {
    site: site!,
    password,
    rotatePassword,
    dedicatedInstance,
    ...(connectionLimit === undefined ? {} : { connectionLimit }),
  });
  console.log(`Schema ${result.schema} and its tables are ready.`);
  if (result.roleCreated || rotatePassword) {
    const siteUrl = new URL(adminUrl!);
    siteUrl.username = result.role;
    siteUrl.password = password;
    console.log(result.roleCreated ? `Role ${result.role} created.` : `Role ${result.role} has a new password.`);
    console.log("The site's DATABASE_URL, shown this once:");
    console.log(siteUrl.toString());
  } else {
    console.log(`Role ${result.role} already existed. Its password is unchanged.`);
  }
  if (result.connectPending) {
    const database = new URL(adminUrl!).pathname.slice(1);
    console.log(
      dedicatedInstance
        ? `Next step: ${consoleConnectStep(result.role, database)}`
        : `The role ${result.role} can't connect to this database. On a Scaleway managed database, use --dedicated-instance.`,
    );
    process.exitCode = 2;
  }
}

try {
  await admin.connect();
  await (check ? runCheck() : runSetup());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await admin.end();
}
