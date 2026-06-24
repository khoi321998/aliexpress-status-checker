import { type CheerioCrawlingContext, createCheerioRouter } from '@crawlee/cheerio';
import { Actor } from 'apify';

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
 * Rebuild a clean, canonical URL on the global `www.aliexpress.com` host.
 *
 * AliExpress regional hosts (notably `aliexpress.us`) redirect cross-domain to
 * `aliexpress.com` and set cookies for that domain. A strict cookie jar (Crawlee's
 * default) rejects those cross-domain cookies, breaking the redirect chain and landing
 * on a page without `og:title`. Requesting `www.aliexpress.com` directly avoids the
 * cross-domain hop, and dropping the tracking query string keeps requests clean.
 */
export function normalizeUrl(url: string, mode: Mode): string {
    if (mode === 'seller') {
        const storeId = extractStoreId(url);
        return storeId ? `https://www.aliexpress.com/store/${storeId}` : url;
    }
    const productId = extractProductId(url);
    return productId ? `https://www.aliexpress.com/item/${productId}.html` : url;
}

/** Back-compat: product-only normalizer. */
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
 * Decide availability purely from the parsed page. The presence of the
 * `<meta property="og:title">` tag is the signal: live product/store pages expose it,
 * removed ones do not. Pure (no I/O) so it can be unit-tested.
 *
 * @throws when the page looks like an anti-bot block, so the crawler retries it.
 */
export function parseStatus(
    mode: Mode,
    $: CheerioAPI,
    originalUrl: string,
    finalUrl: string | null,
    statusCode: number | null,
    html: string,
): CheckResult {
    const productId = mode === 'product' ? (extractProductId(originalUrl) ?? extractProductId(finalUrl ?? '')) : null;
    const storeId = mode === 'seller' ? (extractStoreId(originalUrl) ?? extractStoreId(finalUrl ?? '')) : null;
    const title = $('meta[property="og:title"]').attr('content')?.trim() || null;
    const checkedAt = new Date().toISOString();
    const base = { mode, url: originalUrl, finalUrl, productId, storeId, httpStatus: statusCode, htmlLength: html.length, checkedAt };

    if (title) {
        return { ...base, available: true, status: 'available', title };
    }

    if (looksBlocked(finalUrl, html)) {
        throw new Error(`Request looks blocked by AliExpress anti-bot (HTTP ${statusCode}, final URL ${finalUrl}). Retrying with a new session.`);
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
): CheckResult {
    return parseStatus('product', $, originalUrl, finalUrl, statusCode, html);
}

export const router = createCheerioRouter();

// We never follow links — each input URL is checked in isolation.
router.addDefaultHandler(async ({ request, response, body, $, log, pushData }) => {
    const originalUrl = (request.userData?.originalUrl as string | undefined) ?? request.url;
    const mode = ((request.userData?.mode as Mode | undefined) ?? 'product') satisfies Mode;
    const finalUrl = request.loadedUrl ?? request.url;
    const html = typeof body === 'string' ? body : body.toString('utf8');

    const result = parseStatus(mode, $, originalUrl, finalUrl, response?.statusCode ?? null, html);

    const id = result.productId ?? result.storeId;
    if (result.available) {
        log.info(`[${mode}] AVAILABLE: ${result.title}`, { url: originalUrl, id, htmlLength: result.htmlLength });
    } else {
        log.info(`[${mode}] UNAVAILABLE`, { url: originalUrl, id, httpStatus: result.httpStatus, htmlLength: result.htmlLength });
    }

    // Output only the fields the user cares about.
    await pushData({
        url: result.url,
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
    log.warning(`[${mode}] ERROR after retries: ${error.message}`, { url: originalUrl });
    await Actor.pushData({
        url: originalUrl,
        active: false,
        reason: 'error' as const,
        checkedAt: new Date().toISOString(),
    });
}
