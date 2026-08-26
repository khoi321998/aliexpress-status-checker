// The verdict for one checked URL, in the same envelope the sibling `aliexpress-data-scraper` Actor
// carries internally (`src/response.ts`), minus every field that is about product DATA rather than
// product EXISTENCE.
//
// Success and failure share ONE shape. A separate `{ error: true, … }` shape would force every code
// path to branch before it could read anything; here `exists` answers the question the Actor was
// asked, and `success` says whether we were able to answer it at all.
//
// This is the INTERNAL record. Only {@link OutputItem} — the six fields below — reaches the dataset;
// everything else here exists to make the run log diagnosable (which storefront answered, what
// AliExpress's own refusal code was, which attempt gave up).
import { currentActorRunId } from './actorRun.js';
import { extractAliExpressItemId } from './url.js';

/** Why a check ended without a positive answer. `null` on a listing that resolved. */
export type StatusErrorCode = 'not_found' | 'unavailable_in_region' | 'blocked';

/** The internal verdict for one URL. */
export interface StatusResponse {
    platform: 'aliexpress';
    /** The canonical product URL that was checked (storefront host of `shipToCountry`). */
    url: string;
    /** The URL exactly as the user supplied it — what the dataset row reports back. */
    originalUrl: string;
    capturedAt: string;
    /** ID of the platform run that produced this row; `null` when running locally. */
    actorRunId: string | null;
    /** ISO-3166 alpha-2 market the check ran under (storefront + proxy exit + region cookie). */
    shipToCountry: string;
    /** AliExpress's own storefront code the answer came from — `usa`, `esp`, `glo`, … */
    storefront: string;
    /** The numeric AliExpress item id read out of the URL. */
    productId: string;
    /**
     * THE answer: `true` = the listing resolves for this market, `false` = it does not (deleted or
     * withdrawn from this storefront), `null` = we never got an answer (see `errorCode: 'blocked'`).
     * Never guessed — an anti-bot wall is reported as `null`, never as "gone".
     */
    exists: boolean | null;
    /** The listing's title when it resolved — the proof behind `exists: true`. */
    title: string | null;
    /** `false` ⇒ we could not get a clean answer, or the answer was a refusal. `errorCode` says which. */
    success: boolean;
    errorCode: StatusErrorCode | null;
    errorMessage: string | null;
}

/**
 * Build the record skeleton for one product URL.
 *
 * Every field is initialized to its "unanswered" default, so each code path only writes what it
 * actually established. `platform`, `url`, `capturedAt`, `actorRunId` and the product id are
 * populated up front; `shipToCountry`/`storefront` are overwritten by {@link checkProduct} once the
 * market for this request resolves.
 *
 * `originalUrl` defaults to the checked URL for callers that have no user-supplied one to carry.
 */
export function createStatusResponse(url: string, originalUrl: string = url): StatusResponse {
    return {
        platform: 'aliexpress',
        url,
        originalUrl,
        capturedAt: new Date().toISOString(),
        actorRunId: currentActorRunId(),
        shipToCountry: '',
        storefront: '',
        productId: extractAliExpressItemId(url) ?? '',
        // Deliberately `null`, not `false`: "we have not answered yet" and "the listing is gone" are
        // different facts, and only the paths below know which one applies.
        exists: null,
        title: null,
        success: true,
        errorCode: null,
        errorMessage: null,
    };
}

/**
 * One dataset row — the shape the user actually receives. Deliberately narrower than
 * {@link StatusResponse}, which carries diagnostics that only matter inside the crawl.
 *
 * `country` is part of the answer, not metadata: "unavailable" is only ever true *for that market*.
 * `actorRunId` is required rather than optional — every row states which run produced it, and `null`
 * is the honest value for a local run. Leaving the field off entirely would make "ran locally"
 * indistinguishable from "we forgot to stamp it".
 */
export interface OutputItem {
    /** The original URL provided in the input. */
    url: string;
    /** ISO-3166 alpha-2 market the check ran under. */
    country: string;
    active: boolean;
    reason: 'available' | 'unavailable' | 'error';
    checkedAt: string;
    /** ID of the platform run that produced this row; `null` when running locally. */
    actorRunId: string | null;
}

/**
 * Project the internal verdict onto the row the dataset receives.
 *
 * The three internal error codes collapse into two reasons, and the split is deliberate:
 *   - `not_found` / `unavailable_in_region` are both ANSWERS about the listing → `unavailable`.
 *     Whether AliExpress deleted the item or withdrew it from this market, a buyer there cannot get
 *     it, which is the question this Actor was asked.
 *   - `blocked` (`exists: null`) is a statement about OUR session, not about the product → `error`.
 *     It must never be reported as `unavailable`; that would be a confident lie about a listing that
 *     may well be alive.
 *
 * `active` is `exists === true`, so the unanswered case reads `false` — a row flagged `error` is not
 * a claim that the item is live either.
 */
export function toOutputItem(response: StatusResponse): OutputItem {
    return {
        url: response.originalUrl,
        country: response.shipToCountry,
        active: response.exists === true,
        reason: reasonOf(response.exists),
        checkedAt: response.capturedAt,
        actorRunId: response.actorRunId,
    };
}

/** The three-way `exists` collapsed onto the row's `reason`. See {@link toOutputItem}. */
function reasonOf(exists: boolean | null): OutputItem['reason'] {
    if (exists === null) {
        return 'error';
    }
    return exists ? 'available' : 'unavailable';
}
