// The ONE place a checked record enters the dataset.
//
// Both the handler (`routes.ts`) and the give-up handler (`main.ts`) push through here, so every
// row is logged in the same shape and no future push path can slip in unlogged. Mirrors
// `pushRecord.ts` in the sibling `aliexpress-data-scraper` Actor, without the extraction audit —
// there is one field to audit here and `exists` already carries it.
//
// The rich verdict goes to the LOG; only the six fields of {@link OutputItem} go to the dataset.
// That split is why the diagnostics (storefront, AliExpress's own refusal code, attempt count) can
// stay detailed without widening the contract every consumer reads.
import type { Log } from 'apify';
import { Actor } from 'apify';

import type { OutputItem, StatusResponse } from './response.js';
import { toOutputItem } from './response.js';

/** The one-word verdict a row carries. `UNKNOWN` is `exists: null` — we never got a clean answer. */
function verdictOf({ exists }: StatusResponse): 'EXISTS' | 'GONE' | 'UNKNOWN' {
    if (exists === null) {
        return 'UNKNOWN';
    }
    return exists ? 'EXISTS' : 'GONE';
}

/** Log the verdict for one URL in a single greppable line, then push the row. */
export async function pushRecord(response: StatusResponse, log: Log): Promise<void> {
    log.info(`${verdictOf(response)} — ${response.originalUrl}`, {
        productId: response.productId,
        shipToCountry: response.shipToCountry,
        storefront: response.storefront,
        title: response.title,
        errorCode: response.errorCode,
        errorMessage: response.errorMessage,
    });
    await pushOutputItem(toOutputItem(response));
}

/**
 * Push one already-projected row. The seller pipeline enters here directly — it has no
 * {@link StatusResponse} to narrow, because a store check produces no per-market verdict to carry
 * and does its own logging. Every row in the dataset, from either pipeline, passes through this call.
 */
export async function pushOutputItem(item: OutputItem): Promise<void> {
    await Actor.pushData(item);
}
