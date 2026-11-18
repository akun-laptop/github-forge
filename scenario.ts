// The scenario identity: the one fixed viewer every surface answers for.
//
// The trial's scenario derives its viewer from a single fixed seed, so the
// forge has exactly one authenticated user — login `adaiversen`, id 1000 —
// and no request can change who that is. session A's store owns the value
// (VIEWER) and the fixed trial clock; this module is the single place the
// other surfaces import them from, so the identity can never drift between
// the REST, GraphQL and MCP views of the same forge.

import { VIEWER, trialNow, trialNowIso } from './store.ts';

export { VIEWER, trialNow, trialNowIso };

/** The fixed viewer, as the scenario names them. */
export function viewer(): typeof VIEWER {
  return VIEWER;
}

/** The viewer's login: the owner every created repository belongs to. */
export function viewerLogin(): string {
  return VIEWER.login;
}

/** The viewer's numeric id, the REST `id` and GraphQL `databaseId` alike. */
export function viewerDatabaseId(): number {
  return VIEWER.databaseId;
}
