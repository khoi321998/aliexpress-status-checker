import { Actor } from 'apify';

/**
 * The ID of the platform run this code is executing in, or `null` when there is none — which is the
 * normal case for a local `apify run`, where no run exists to have an ID.
 *
 * Read fresh on every call rather than captured once at module load: `Actor.getEnv()` reads the
 * environment the SDK populates during `Actor.init()`, so a module-level constant evaluated at
 * import time can be `null` purely because it was read too early. This is the ONLY place the run ID
 * is read — call it instead of reaching for `Actor.getEnv()` again elsewhere.
 */
export function currentActorRunId(): string | null {
    return Actor.getEnv().actorRunId ?? null;
}
