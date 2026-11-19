/**
 * Sets up one site in the shared database: its schema, its tables and a role
 * that reaches nothing else. Run it yourself, with the administrator's
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
 * It's all or nothing: when the site wouldn't be isolated (for example a role
 * of that name that already has other rights) or a step fails, it changes
 * nothing. It lists what it found; fix those by hand, then run it again.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { provisionSite } from "../src/adapters/postgres-site";

const [site, ...flags] = process.argv.slice(2);
const adminUrl = process.env["ADMIN_DATABASE_URL"];
if (site === undefined || adminUrl === undefined) {
  console.error(
    "Usage: pnpm provision-site <site> [--rotate-password] [--connection-limit=N], with ADMIN_DATABASE_URL set in .env.local",
  );
  process.exit(1);
}
const rotatePassword = flags.includes("--rotate-password");
const limitFlag = flags.find((flag) => flag.startsWith("--connection-limit="));
const connectionLimit = limitFlag === undefined ? undefined : Number(limitFlag.split("=")[1]);

const password = randomBytes(24).toString("base64url");
// One connection: setup runs as a single transaction.
const admin = new pg.Client({ connectionString: adminUrl });
try {
  await admin.connect();
  const result = await provisionSite(admin, {
    site,
    password,
    rotatePassword,
    ...(connectionLimit === undefined ? {} : { connectionLimit }),
  });
  console.log(`Schema ${result.schema} and its tables are ready.`);
  if (result.roleCreated || rotatePassword) {
    const siteUrl = new URL(adminUrl);
    siteUrl.username = result.role;
    siteUrl.password = password;
    console.log(result.roleCreated ? `Role ${result.role} created.` : `Role ${result.role} has a new password.`);
    console.log("The site's DATABASE_URL, shown this once:");
    console.log(siteUrl.toString());
  } else {
    console.log(`Role ${result.role} already existed. Its password is unchanged.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await admin.end();
}
