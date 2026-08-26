// Seller mode — an INDEPENDENT pipeline, kept exactly as it was before the product path moved to a
// browser + the signed MTOP API.
//
// Why it does not share the product crawler: a store either exists or it doesn't, and the answer is
// the same in every market. There is nothing to localize, no ship-to to agree with, and no
// client-side module to ask — `https://www.aliexpress.com/store/<id>` renders `og:title`
// SERVER-SIDE, so one cheap Cheerio fetch answers the whole question. Running a store URL through
// the product crawler would pay for Chrome, a residential fingerprint and a signed pdp.pc.query to
// learn something already sitting in the HTML head.
//
// This mirrors how the sibling `aliexpress-data-scraper` Actor treats `seller_only`: a separate
// pipeline that the product crawler never touches, handed off from `main.ts` before the browser
// crawler is ever constructed.
import { CheerioCrawler, type CheerioCrawlingContext, createCheerioRouter } from '@crawlee/cheerio';
import { Actor, log } from 'apify';

import { currentActorRunId } from './actorRun.js';
import type { CheckerConfig, CheckerInput } from './config.js';
import { pushOutputItem } from './pushRecord.js';
import type { OutputItem } from './response.js';

// Use the exact Cheerio type Crawlee passes in its context, to avoid the
// dual-package (CJS vs ESM) `cheerio` type mismatch.
type CheerioAPI = CheerioCrawlingContext['$'];

/**
 * The market a store check is recorded under. Seller mode is market-agnostic — the value is here so
 * every dataset row carries the same six fields — so it is pinned rather than resolved per URL.
 */
const SELLER_MARKET = 'US';

/**
 * The AliExpress locale cookie. Seller mode pins everything: a store's existence does not vary by
 * region, so there is no ship-to to replay and nothing to gain from varying the currency or language.
 */
function localeCookie(country: string): string {
    return `aep_usuc_f=site=glo&c_tp=USD&region=${country.toUpperCase()}&b_locale=en_US&ae_u_p_s=2; intl_locale=en_US`;
}

/** The verdict for one store URL, before it is narrowed to a dataset row. */
export interface SellerCheckResult {
    /** The original URL provided in the input. */
    url: string;
    /** The URL actually fetched after normalization + redirects. */
    finalUrl: string | null;
    /** Numeric store/seller ID. */
    storeId: string | null;
    /** true = page is live, false = removed/disabled. */
    available: boolean;
    status: 'available' | 'unavailable';
    title: string | null;
    httpStatus: number | null;
    /** Size of the HTML Cheerio received — useful to tell a real page (~70 KB+) from a block stub. */
    htmlLength: number;
    checkedAt: string;
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
 * Rebuild a clean, canonical store URL, dropping the tracking query string.
 *
 * Always `www`: a store either exists or it doesn't, the same answer in every market, so there is
 * nothing to localize. Staying on `aliexpress.com` also keeps the original reason this function
 * exists: hosts on the `.us` TLD redirect cross-domain to `.com` and set cookies for that domain,
 * which Crawlee's strict cookie jar rejects — breaking the redirect chain and landing on a page
 * without `og:title`.
 */
export function normalizeStoreUrl(url: string): string {
    const storeId = extractStoreId(url);
    return storeId ? `https://www.aliexpress.com/store/${storeId}` : url;
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
 * Decide availability purely from the parsed page. The presence of the
 * `<meta property="og:title">` tag is the signal: live store pages expose it, removed ones do not.
 * Pure (no I/O) so it can be unit-tested.
 *
 * @throws when the page looks like an anti-bot block, so the crawler retries on a fresh session/IP.
 */
export function parseSellerStatus(
    $: CheerioAPI,
    originalUrl: string,
    finalUrl: string | null,
    statusCode: number | null,
    html: string,
): SellerCheckResult {
    const storeId = extractStoreId(originalUrl) ?? extractStoreId(finalUrl ?? '');
    const title = $('meta[property="og:title"]').attr('content')?.trim() || null;
    const base = { url: originalUrl, finalUrl, storeId, httpStatus: statusCode, htmlLength: html.length, checkedAt: new Date().toISOString() };

    if (title) {
        return { ...base, available: true, status: 'available' as const, title };
    }

    if (looksBlocked(finalUrl, html)) {
        throw new Error(
            `Request looks blocked by AliExpress anti-bot (HTTP ${statusCode}, final URL ${finalUrl}). Retrying with a new session.`,
        );
    }

    return { ...base, available: false, status: 'unavailable' as const, title: null };
}

/** Project a store verdict onto the same six-field row product mode pushes. */
function toOutputItem(result: SellerCheckResult): OutputItem {
    return {
        url: result.url,
        country: SELLER_MARKET,
        active: result.available,
        reason: result.status,
        checkedAt: result.checkedAt,
        actorRunId: currentActorRunId(),
    };
}

const router = createCheerioRouter();

// We never follow links — each input URL is checked in isolation.
router.addDefaultHandler(async ({ request, response, body, $, log: reqLog }) => {
    const originalUrl = (request.userData?.originalUrl as string | undefined) ?? request.url;
    const finalUrl = request.loadedUrl ?? request.url;
    const html = typeof body === 'string' ? body : body.toString('utf8');

    const result = parseSellerStatus($, originalUrl, finalUrl, response?.statusCode ?? null, html);

    if (result.available) {
        reqLog.info(`[seller] AVAILABLE: ${result.title}`, { url: originalUrl, id: result.storeId, htmlLength: result.htmlLength });
    } else {
        reqLog.info('[seller] UNAVAILABLE (store removed)', {
            url: originalUrl,
            id: result.storeId,
            httpStatus: result.httpStatus,
            htmlLength: result.htmlLength,
        });
    }

    await pushOutputItem(toOutputItem(result));
});

/**
 * Records a result row even when a URL fails permanently (after all retries),
 * so the dataset has one row per input URL instead of silently dropping failures.
 */
async function failedRequestHandler({ request, log: reqLog }: CheerioCrawlingContext, error: Error): Promise<void> {
    const originalUrl = (request.userData?.originalUrl as string | undefined) ?? request.url;
    reqLog.warning(`[seller] ERROR after retries: ${error.message}`, { url: originalUrl, country: SELLER_MARKET });
    await pushOutputItem({
        url: originalUrl,
        country: SELLER_MARKET,
        active: false,
        reason: 'error',
        checkedAt: new Date().toISOString(),
        actorRunId: currentActorRunId(),
    });
}

/**
 * Run the whole seller pipeline: normalize every store URL, check each one over plain HTTP, and push
 * one row per input URL. Called from `main.ts` INSTEAD of the product crawler — the two never share a
 * crawler, a proxy configuration or a session pool.
 */
export async function runSellerOnly(input: CheckerInput, config: CheckerConfig): Promise<void> {
    // A per-index uniqueKey ensures every input row is checked, even when the same URL is listed
    // multiple times (Crawlee would otherwise dedupe identical URLs).
    const requests = (input.startUrls ?? []).map(({ url }, index) => {
        const normalized = normalizeStoreUrl(url);
        return {
            url: normalized,
            uniqueKey: `${index}-${normalized}`,
            userData: { originalUrl: url },
        };
    });

    // Residential everywhere: AliExpress blocks datacenter IPs aggressively on store pages. The exit
    // country is fixed because the answer does not vary by market.
    const proxyConfiguration = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: SELLER_MARKET });

    const crawler = new CheerioCrawler({
        proxyConfiguration,
        maxConcurrency: config.maxConcurrency,
        maxRequestsPerCrawl: config.maxRequestsPerCrawl,
        sameDomainDelaySecs: config.sameDomainDelaySecs,
        maxRequestRetries: config.maxRequestRetries,
        requestHandler: router,
        failedRequestHandler,
        // Look like a normal browser so AliExpress is less likely to serve the anti-bot page.
        preNavigationHooks: [
            async ({ request }) => {
                request.headers = {
                    ...request.headers,
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    Cookie: localeCookie(SELLER_MARKET),
                };
            },
        ],
    });

    log.info(`Checking seller status of ${requests.length} AliExpress store URL(s)...`);
    await crawler.run(requests);
    log.info('Done. See the dataset for per-store availability results.');
}
