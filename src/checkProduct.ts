// Single-product existence check — the code path behind the crawler's default handler
// (`routes.ts`).
//
// Everything here works on a plain Playwright `Page` via the page's request context
// (`page.request`) — no Crawlee request-handler state. The caller navigates to the product first
// (to bootstrap the anti-bot cookies + `_m_h5_tk` token), then calls in here; the answer comes from
// AliExpress's signed API, never from the page DOM.
//
// This NEVER throws to rotate the session: it RETURNS `{ blocked: true, blockReason }` at each
// block point and lets the caller decide how to rotate (Crawlee `session.retire()`).
//
// Mirrors `extractProduct.ts` in the sibling `aliexpress-data-scraper` Actor, stopping at the one
// question this Actor asks: did the listing resolve?
import type { Log } from 'apify';
import type { Page } from 'playwright';

import type { CheckerConfig } from './config.js';
import { storefrontForRequest } from './config.js';
import { fetchPdpDirect, parseTitle, pdpUnavailability, waitForPdpResult } from './productApi.js';
import type { StatusResponse } from './response.js';
import { createStatusResponse } from './response.js';
import type { RegionAddress } from './storefront.js';
import { addressFromLocaleCookie } from './storefront.js';

/** Knobs the caller tunes per check pass. */
export interface CheckOptions {
    /**
     * Whether to fall back to the page's intercepted pdp.pc.query response when the direct call
     * yields nothing. Only useful when the page actually navigated to the PDP.
     */
    interceptorFallback: boolean;
    /**
     * Ship-to country (ISO-3166 alpha-2) for the MTOP payload. MUST match the `region` already set
     * in the page's `aep_usuc_f` cookie — a mismatch makes AliExpress answer for neither region.
     * Defaults to `US` when the caller has no per-request region.
     */
    shipToCountry?: string;
    /**
     * The URL as the user supplied it, which is what the dataset row reports back. Defaults to the
     * canonical URL we actually checked.
     */
    originalUrl?: string;
}

/** Outcome of one check pass. */
export interface CheckResult {
    response: StatusResponse;
    /** True ⇒ the page was blocked; caller should rotate and retry on a fresh identity. */
    blocked: boolean;
    blockReason?: string;
    /**
     * True ⇒ the storefront answered, and its answer was "we do not sell this here". A FINAL result,
     * not a block: the caller must push the record and must NOT rotate, because no fresh IP changes a
     * merchandising decision. `response.errorCode`/`errorMessage` carry the detail.
     */
    unavailableInRegion?: boolean;
}

/**
 * Read the buyer's resolved delivery address off the session's own `aep_usuc_f` cookie.
 *
 * AliExpress writes the province/city ids there itself during navigation (from the session's IP geo
 * or a saved address); the preNavigationHook in `main.ts` carries them across cookie rewrites. A real
 * browser sends them in every pdp.pc.query, and they narrow availability further than the country
 * alone. Sessions that were never given them fall back to `''` rather than to an invented id.
 */
async function resolveAddress(page: Page, shipToCountry: string): Promise<RegionAddress> {
    const cookies = await page.context().cookies('https://www.aliexpress.com').catch(() => []);
    const cookie = cookies.find((c) => c.name === 'aep_usuc_f');
    return addressFromLocaleCookie(shipToCountry, cookie?.value ?? null);
}

/**
 * Ask whether ONE product still resolves for the requested market, via the signed pdp.pc.query call
 * on the given page's request context. The page must already be on the target product with its
 * anti-bot cookies warm. Never throws on a block: returns `{ blocked: true }` for the caller to
 * rotate.
 */
export async function checkProduct(
    page: Page,
    url: string,
    config: CheckerConfig,
    log: Log,
    opts: CheckOptions,
): Promise<CheckResult> {
    const response = createStatusResponse(url, opts.originalUrl ?? url);
    const shipToCountry = opts.shipToCountry ?? config.defaultShipToCountry;
    const storefront = storefrontForRequest(shipToCountry, config);
    const address = await resolveAddress(page, shipToCountry);
    response.shipToCountry = shipToCountry;
    response.storefront = storefront.site;
    log.info('storefront identity for this product', {
        site: storefront.site,
        locale: storefront.locale,
        currency: storefront.currency,
        province: address.province || '(none)',
        city: address.city || '(none)',
    });

    // Fire the signed pdp.pc.query ourselves (no bundle wait), then fall back to the page's own
    // intercepted response. A block means neither yields JSON → rotate cheaply.
    let result = await fetchPdpDirect(page, response.productId, log, address, storefront);
    if (!result && opts.interceptorFallback) {
        result = await waitForPdpResult(page, 8_000);
    }
    if (!result) {
        return { response, blocked: true, blockReason: 'pdp-blocked' };
    }

    // Checked BEFORE the title: a refused listing carries GLOBAL_DATA and nothing else, so the title
    // is legitimately absent and the "no title ⇒ blocked" rule below would misread the storefront's
    // clear answer as an anti-bot block and burn the whole retry budget on it.
    const refusal = pdpUnavailability(result);
    if (refusal) {
        response.exists = false;
        response.success = false;
        response.errorCode = 'unavailable_in_region';
        // AliExpress's own code goes in the TEXT, not in `errorCode`: it is one of many such codes and
        // would force a backend to keep up with a vocabulary that is not ours. The three codes stay
        // stable; the specifics stay readable.
        response.errorMessage = [
            refusal.message ?? `The ${storefront.site} storefront does not sell this listing to ${shipToCountry}.`,
            `(${refusal.errorCode})`,
        ].join(' ');
        log.info('storefront does not sell this listing to the requested region — recording as unavailable.', {
            url,
            shipToCountry,
            site: storefront.site,
            reasonCode: refusal.errorCode,
        });
        return { response, blocked: false, unavailableInRegion: true };
    }

    const title = parseTitle(result);
    if (!title) {
        log.warning('pdp.pc.query JSON had no title — treating as blocked.', { url: page.url() });
        return { response, blocked: true, blockReason: 'empty-product' };
    }

    // The listing resolved for this market — that IS the answer this Actor exists to give.
    response.exists = true;
    response.title = title;
    log.info('product exists', { title, productId: response.productId, shipToCountry, site: storefront.site });

    return { response, blocked: false };
}
