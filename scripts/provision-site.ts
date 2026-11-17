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
 * alone; add --rotate-password to set a new one.
 *
 * It refuses, and changes nothing, when the site wouldn't be isolated: for
 * example a role of that name that already has other rights. It lists what
 * it found; fix those by hand, then run it again.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { provisionSite } from "../src/adapters/postgres-site";

const [site, ...flags] = process.argv.slice(2);
const adminUrl = process.env["ADMIN_DATABASE_URL"];
if (site === undefined || adminUrl === undefined) {
  console.error("Usage: pnpm provision-site <site> [--rotate-password], with ADMIN_DATABASE_URL set in .env.local");
  process.exit(1);
}
const rotatePassword = flags.includes("--rotate-password");

const password = randomBytes(24).toString("base64url");
const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
try {
  const result = await provisionSite(admin, { site, password, rotatePassword });
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
