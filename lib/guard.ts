/** Guards for the Tern data plane. */

export interface DbGuardInput {
	path: string;
	sql?: string;
	action: string;
	allowSecret?: boolean;
}

export interface DbGuardResult {
	allowed: boolean;
	reason?: string;
}

const DENIED_SQL = /auth_credentials|auth_credential_blocks|api[_-]?keys?|\bsecret[s]?\b/i;
const SECRET_STORE = /(agent|models)\.db$/i;

/**
 * Credential-store guard. Listing tables is allowed; reading credential-looking
 * tables/columns or querying agent.db/models.db requires an explicit opt-in.
 */
export function dbQueryGuard({ path, sql, action, allowSecret }: DbGuardInput): DbGuardResult {
	if (allowSecret === true) return { allowed: true };
	if (sql && DENIED_SQL.test(sql)) {
		return {
			allowed: false,
			reason: "the SQL touches credential-looking columns/tables; pass allowSecret:true only if you really need it",
		};
	}
	if (SECRET_STORE.test(path) && action !== "tables") {
		return {
			allowed: false,
			reason: "that store holds credentials; listing tables is allowed, reading it needs allowSecret:true",
		};
	}
	return { allowed: true };
}
