import { type CheerioCrawlingContext, createCheerioRouter } from '@crawlee/cheerio';
import { Actor } from 'apify';

import { DEFAULT_SHIP_TO_COUNTRY, detectShipToCountry, storefrontHost } from './country.js';

// Use the exact Cheerio type Crawlee passes in its context, to avoid the
// dual-package (CJS vs ESM) `cheerio` type mismatch.
type CheerioAPI = CheerioCrawlingContext['$'];

export type Mode = 'product' | 'seller';

export interface CheckResult {
    /** What was checked. */
    mode: Mode;
    /** The original URL provided in the input. */
    url: string;
    /** The URL actually fetched after normalization + redirects. */
    finalUrl: string | null;
    /** Numeric product ID (product mode only). */
    productId: string | null;
    /** Numeric store/seller ID (seller mode only). */
    storeId: string | null;
    /** ISO-3166 alpha-2 market the check ran under (storefront + proxy exit + region cookie). */
    country: string;
    /** true = page is live, false = removed/disabled, null = could not determine */
    available: boolean | null;
    status: 'available' | 'unavailable' | 'error';
    title: string | null;
    httpStatus: number | null;
    /** Size of the HTML Cheerio received — useful to tell a real page (~70 KB+) from a block stub. */
    htmlLength: number | null;
    error?: string;
    checkedAt: string;
}

/** Back-compat alias. */
export type ProductStatus = CheckResult;

/**
 * Extract the numeric product ID from an AliExpress item URL,
 * e.g. https://vi.aliexpress.com/item/1005004771213104.html -> "1005004771213104".
 */
export function extractProductId(url: string): string | null {
    const match = url.match(/item\/(\d+)\.html/i);
    return match ? match[1] : null;
}

/**
 * Extract the numeric store/seller ID from an AliExpress store URL,
 * e.g. https://www.aliexpress.com/store/1101692994?spm=... -> "1101692994".
 */
export function extractStoreId(url: string): string | null {
    const match = url.match(/store\/(\d+)/i);
    return match ? match[1] : null;
}

/**
 * Rebuild a clean, canonical URL, dropping the tracking query string (`spm`, `gatewayAdapt` and
 * friends — the region they encode has already been read out by `detectShipToCountry`).
 *
 * PRODUCT mode puts the URL on the storefront host of `country`, e.g. `ES` →
 * `https://es.aliexpress.com/item/<id>.html`. The host comes from `country`, not from whatever the
 * user pasted, so a stale subdomain can't disagree with the market we check under — and it is NOT
 * collapsed to `www`, because availability is per-market: asking `www` (the US storefront) about a
 * listing the seller only ships to Spain reports it as removed when it is live. Omitting `country`
 * keeps the historical `www` behavior.
 *
 * SELLER mode always uses `www`: a store either exists or it doesn't, the same answer in every
 * market, so there is nothing to localize.
 *
 * Every host produced here is on `aliexpress.com`, which keeps the original reason this function
 * exists: hosts on the `.us` TLD redirect cross-domain to `.com` and set cookies for that domain,
 * which Crawlee's strict cookie jar rejects — breaking the redirect chain and landing on a page
 * without `og:title`.
 */
export function normalizeUrl(url: string, mode: Mode, country?: string): string {
    if (mode === 'seller') {
        const storeId = extractStoreId(url);
        return storeId ? `https://www.aliexpress.com/store/${storeId}` : url;
    }
    const productId = extractProductId(url);
    return productId ? `https://${storefrontHost(country)}/item/${productId}.html` : url;
}

/** Back-compat: product-only normalizer on the global host. */
export function normalizeAliexpressUrl(url: string): string {
    return normalizeUrl(url, 'product');
}

/**
 * Detect AliExpress anti-bot interstitials (captcha / "slide to verify" / punish page)
 * so we retry instead of falsely recording "unavailable".
 *
 * We rely on strong signals only — the *final* URL after redirects and the page size —
 * NOT on scanning the body for strings like `nc_token`/`_____tmd_____`, which appear in
 * the anti-fraud JS SDK embedded on EVERY page (including live ones) and cause false
 * positives. A real page is large (~70 KB+); punish/login pages are tiny or live under
 * dedicated paths.
 */
export function looksBlocked(finalUrl: string | null, html: string): boolean {
    const loaded = (finalUrl ?? '').toLowerCase();
    if (/\/(punish|_____tmd_____|sec\/|login|captcha)/.test(loaded) || loaded.includes('punish.aliexpress')) {
        return true;
    }
    // Live pages are large. A short body without og:title is almost always a
    // block/redirect stub rather than a genuine "removed" page.
    return html.length < 5000;
}

/**
 * The market a response actually landed in, read off the final URL after redirects.
 *
 * AliExpress routes on the EXIT IP, not on the host you asked for: requesting
 * `es.aliexpress.com` from a Vietnamese IP is answered with a 302 to
 * `vi.aliexpress.com?gatewayAdapt=esp2vnm`. The page that comes back is a real page — it just
 * answers a different question than the one we asked.
 */
export function landedMarket(finalUrl: string | null): string {
    return (finalUrl ? detectShipToCountry(finalUrl) : null) ?? DEFAULT_SHIP_TO_COUNTRY;
}

/**
 * Decide availability purely from the parsed page. The presence of the
 * `<meta property="og:title">` tag is the signal: live product/store pages expose it,
 * removed ones do not. Pure (no I/O) so it can be unit-tested.
 *
 * @throws when the page looks like an anti-bot block, or when the response came back from a
 * different market than the one asked for, so the crawler retries on a fresh session/IP.
 */
export function parseStatus(
    mode: Mode,
    $: CheerioAPI,
    originalUrl: string,
    finalUrl: string | null,
    statusCode: number | null,
    html: string,
    country: string = DEFAULT_SHIP_TO_COUNTRY,
): CheckResult {
    const productId = mode === 'product' ? (extractProductId(originalUrl) ?? extractProductId(finalUrl ?? '')) : null;
    const storeId = mode === 'seller' ? (extractStoreId(originalUrl) ?? extractStoreId(finalUrl ?? '')) : null;
    const title = $('meta[property="og:title"]').attr('content')?.trim() || null;
    const checkedAt = new Date().toISOString();
    const base = { mode, url: originalUrl, finalUrl, productId, storeId, country, httpStatus: statusCode, htmlLength: html.length, checkedAt };

    // Availability is per-market, so an answer from the wrong market is not a weaker answer — it is
    // an answer to a different question, and reporting it would be a lie in both directions. This is
    // checked BEFORE the title, because a page redirected to another storefront can carry a perfectly
    // good `og:title` and still say nothing about the market we were asked about. Throwing rotates
    // the session onto a fresh proxy IP in the right country; if it never lands, the URL ends up as
    // `error` rather than a confident wrong verdict. Seller mode is market-agnostic, so it is exempt.
    const landed = landedMarket(finalUrl);
    if (mode === 'product' && landed !== country.toUpperCase()) {
        throw new Error(
            `Landed on the ${landed} storefront while checking the ${country} market (final URL ${finalUrl}) — ` +
                `AliExpress routes on the exit IP, so the proxy is not in ${country}. Retrying with a new session.`,
        );
    }

    if (title) {
        return { ...base, available: true, status: 'available', title };
    }

    if (looksBlocked(finalUrl, html)) {
        throw new Error(
            `Request looks blocked by AliExpress anti-bot (HTTP ${statusCode}, final URL ${finalUrl}). Retrying with a new session.`,
        );
    }

    return { ...base, available: false, status: 'unavailable', title: null };
}

/** Back-compat wrapper for product mode. */
export function parseProductStatus(
    $: CheerioAPI,
    originalUrl: string,
    finalUrl: string | null,
    statusCode: number | null,
    html: string,
    country?: string,
): CheckResult {
    return parseStatus('product', $, originalUrl, finalUrl, statusCode, html, country);
}

export const router = createCheerioRouter();

// We never follow links — each input URL is checked in isolation.
router.addDefaultHandler(async ({ request, response, body, $, log, pushData }) => {
    const originalUrl = (request.userData?.originalUrl as string | undefined) ?? request.url;
    const mode = ((request.userData?.mode as Mode | undefined) ?? 'product') satisfies Mode;
    const country = (request.userData?.country as string | undefined) ?? DEFAULT_SHIP_TO_COUNTRY;
    const finalUrl = request.loadedUrl ?? request.url;
    const html = typeof body === 'string' ? body : body.toString('utf8');

    const result = parseStatus(mode, $, originalUrl, finalUrl, response?.statusCode ?? null, html, country);

    const id = result.productId ?? result.storeId;
    if (result.available) {
        log.info(`[${mode}] AVAILABLE: ${result.title}`, { url: originalUrl, id, country, htmlLength: result.htmlLength });
    } else {
        log.info(`[${mode}] UNAVAILABLE`, {
            url: originalUrl,
            id,
            country,
            httpStatus: result.httpStatus,
            htmlLength: result.htmlLength,
        });
    }

    // Output only the fields the user cares about. `country` is part of the answer, not metadata:
    // "unavailable" is only ever true *for that market*.
    await pushData({
        url: result.url,
        country: result.country,
        active: result.available === true,
        reason: result.status,
        checkedAt: result.checkedAt,
    });
});

/**
 * Records a result row even when a URL fails permanently (after all retries),
 * so the dataset has one row per input URL instead of silently dropping failures.
 */
export async function failedRequestHandler({ request, log }: CheerioCrawlingContext, error: Error): Promise<void> {
    const originalUrl = (request.userData?.originalUrl as string | undefined) ?? request.url;
    const mode = ((request.userData?.mode as Mode | undefined) ?? 'product') satisfies Mode;
    const country = (request.userData?.country as string | undefined) ?? DEFAULT_SHIP_TO_COUNTRY;
    log.warning(`[${mode}] ERROR after retries: ${error.message}`, { url: originalUrl, country });
    await Actor.pushData({
        url: originalUrl,
        country,
        active: false,
        reason: 'error' as const,
        checkedAt: new Date().toISOString(),
    });
}
