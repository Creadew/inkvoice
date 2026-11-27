#!/usr/bin/env bun
/**
 * Removes a user's authenticator app so they set up a new one on their next
 * sign-in. For when the only admin has lost their phone; otherwise use
 * "Reset authenticator" on the Users page.
 *
 *   bun packages/backend/src/cli/reset-mfa.ts <username>
 *   docker exec -it <container> bun packages/backend/src/cli/reset-mfa.ts <username>
 */
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { logActivity } from "../services/activity.service";
import { resetMfa } from "../services/mfa.service";

const username = process.argv[2];
if (!username) {
  console.error("Usage: bun packages/backend/src/cli/reset-mfa.ts <username>");
  process.exit(1);
}

initDatabase();
const user = getDb().query("SELECT id FROM users WHERE username = ?").get(username) as {
  id: string;
} | null;
if (!user) {
  console.error(`No user named "${username}"`);
  closeDatabase();
  process.exit(1);
}

resetMfa(user.id);
logActivity({
  user_id: null,
  user_name: "cli",
  action: "mfa_reset",
  resource_type: "user",
  resource_id: user.id,
});
closeDatabase();
console.log(`Authenticator removed for "${username}". They will set up a new one at next sign-in.`);
