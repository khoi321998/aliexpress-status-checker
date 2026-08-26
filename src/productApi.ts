// API-based existence check — the fast path.
//
// The AliExpress PC product page is a client-side React app: the HTML ships almost no data
// (`window.runParams` is empty, `isCSR=true`), and ALL product fields arrive in a single XHR to
// the MTOP endpoint `mtop.aliexpress.pdp.pc.query`. Two items on the same storefront — one buyable
// and one the storefront has withdrawn — ship BYTE-FOR-BYTE equivalent HTML heads, so no amount of
// HTML parsing answers the per-market question. The API has to be asked directly.
//
// Rather than render the page, wait for hydration and scrape the DOM (40–50s/attempt), we let the
// page fire that one signed request on load and either fire it OURSELVES through the page's request
// context or INTERCEPT the response it already fetched (~6–10s/attempt). The browser holds the
// cookies and the `_m_h5_tk` token, so we never replicate anything secret — we just sign with the
// token the server itself handed the session.
//
// Signing (Alibaba MTOP H5): `sign = MD5(token & t & appKey & data)`, where `token` is the part of
// the `_m_h5_tk` cookie before `_`. The first call on a tokenless session returns
// `FAIL_SYS_TOKEN_EMPTY` but SETS that cookie, so we re-read it and retry — the "token dance", and
// the reason the first call looking like a failure is normal.
//
// Ported from the sibling `aliexpress-data-scraper` Actor (`src/productApi.ts`), trimmed to the one
// module an existence check reads: PRODUCT_TITLE (does it resolve?) and GLOBAL_DATA (was it
// withdrawn from this market?).
import { createHash, randomBytes } from 'node:crypto';

import type { Log } from 'apify';
import type { Page } from 'playwright';

import type { RegionAddress, Storefront } from './storefront.js';
import { GLOBAL_STOREFRONT } from './storefront.js';
import { storefrontHost } from './url.js';

/** The MTOP API that returns the full PC product payload. */
const PDP_QUERY_RE = /mtop\.aliexpress\.pdp\.pc\.query/i;
const PDP_API = 'mtop.aliexpress.pdp.pc.query';
/** Per-API H5 appKey for the PC product endpoint. Public — embedded in the page's own JS. */
const PDP_APP_KEY = '12574478';

/** Which MTOP gateway (and the site identity that goes with it) a given ship-to must be asked on. */
interface Gateway {
    /** MTOP H5 endpoint base. */
    acsBase: string;
    /** Site origin the signed call claims to come from (referer/origin headers). */
    origin: string;
    /** `ext.site` in the pdp payload — AliExpress's own name for the storefront. */
    site: string;
    /** `ext.host` in the pdp payload. */
    host: string;
}

/**
 * Pick the gateway for a ship-to country.
 *
 * aliexpress.us is a legally separate US storefront with its own catalogue, and `acs.aliexpress.us`
 * only answers for it — asking it about a listing that is only on the global site is exactly the
 * "403 from Spain" symptom. So US keeps the `.us` gateway it has always used, and every other
 * ship-to goes to the global `.com` gateway, which is the only one that serves non-US regions.
 *
 * `site` is NOT the gateway. The `.com` gateway answers for every storefront; which CATALOGUE it
 * answers from is decided by `ext.site`, and that comes from the caller's {@link Storefront} — see
 * `storefront.ts` for why sending `glo` from a Spanish session reports availability Spain does not
 * have.
 */
function gatewayFor(shipToCountry: string, storefront: Storefront): Gateway {
    if (shipToCountry.toUpperCase() === 'US') {
        return { acsBase: 'https://acs.aliexpress.us/h5', origin: 'https://www.aliexpress.us', site: 'usa', host: 'www.aliexpress.us' };
    }
    // Claim the same storefront the crawler actually navigated to (`es.aliexpress.com`, ...), so the
    // referer and `ext.host` match the page the signed call is supposed to be coming from.
    const host = storefrontHost(shipToCountry);
    return { acsBase: 'https://acs.aliexpress.com/h5', origin: `https://${host}`, site: storefront.site, host };
}

/** Per-page holder for the intercepted pdp.pc.query JSON, resolved by the response listener. */
interface PdpWaiter {
    promise: Promise<Record<string, unknown> | null>;
    settle: (value: Record<string, unknown> | null) => void;
    settled: boolean;
}
const pdpWaiters = new WeakMap<Page, PdpWaiter>();

/** Narrow an unknown to a plain object; non-objects become `{}`. */
function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Arm the pdp.pc.query interceptor on a page BEFORE navigation. The first "full" response (the
 * token-empty retry returns a tiny error body, so we wait for a sizable one) is parsed and resolves
 * {@link waitForPdpResult}. Idempotent per page.
 */
export function armPdpInterceptor(page: Page): void {
    if (pdpWaiters.has(page)) {
        return;
    }
    let settle!: (value: Record<string, unknown> | null) => void;
    const promise = new Promise<Record<string, unknown> | null>((resolve) => {
        settle = resolve;
    });
    const waiter: PdpWaiter = { promise, settle, settled: false };
    pdpWaiters.set(page, waiter);

    page.on('response', async (res) => {
        if (waiter.settled || !PDP_QUERY_RE.test(res.url())) {
            return;
        }
        let body: string;
        try {
            body = await res.text();
        } catch {
            return;
        }
        // The token-empty bootstrap reply is a few hundred bytes; the real payload is tens of KB.
        if (body.length < 5_000) {
            return;
        }
        try {
            const json = JSON.parse(body.replace(/^\s*\w+\(/, '').replace(/\)\s*;?\s*$/, ''));
            const result = asRecord(asRecord(asRecord(json).data).result);
            if (Object.keys(result).length > 0) {
                waiter.settled = true;
                waiter.settle(result);
            }
        } catch {
            // Malformed/partial — ignore and wait for a cleaner one.
        }
    });
}

/**
 * Await the intercepted pdp.pc.query `result` object, or `null` if it doesn't arrive within
 * `timeoutMs` (treated as a block/empty by the caller, which then rotates). Returns `null` if the
 * interceptor was never armed for this page.
 */
export async function waitForPdpResult(page: Page, timeoutMs: number): Promise<Record<string, unknown> | null> {
    const waiter = pdpWaiters.get(page);
    if (!waiter) {
        return null;
    }
    let timer: NodeJS.Timeout;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const result = await Promise.race([waiter.promise, timeout]);
    clearTimeout(timer!);
    return result;
}

function md5(input: string): string {
    return createHash('md5').update(input).digest('hex');
}

/** Read the MTOP token (part of `_m_h5_tk` before the `_`) from the gateway's cookie jar. */
async function readMtopToken(page: Page, acsBase: string): Promise<string> {
    const cookies = await page.context().cookies(acsBase).catch(() => []);
    const tk = cookies.find((c) => c.name === '_m_h5_tk');
    return tk ? tk.value.split('_')[0] : '';
}

/**
 * Build the `data` payload the PC page sends for pdp.pc.query (locale/region inline, not cookie).
 *
 * `address.country` is the ship-to and it decides whether the listing resolves at all: a seller who
 * does not ship to the requested country answers with an empty `result`, which the caller cannot
 * distinguish from an anti-bot block. It must agree with the `region` in the page's `aep_usuc_f`
 * cookie.
 *
 * `address.province`/`city` are AliExpress's own region ids for the buyer's resolved delivery
 * address. A real browser always carries them and they narrow availability further than the country
 * alone (a seller can serve a country but not an island region). We forward whatever the session was
 * given and send `''` otherwise — never a made-up id.
 */
function buildPdpData(productId: string | number, address: RegionAddress, storefront: Storefront, gateway: Gateway): string {
    const ext = JSON.stringify({
        foreverRandomToken: randomBytes(16).toString('hex'),
        site: gateway.site,
        crawler: false,
        'x-m-biz-bx-region': '',
        signedIn: false,
        host: gateway.host,
    });
    return JSON.stringify({
        productId: String(productId),
        _lang: storefront.locale,
        _currency: storefront.currency,
        country: address.country,
        province: address.province,
        city: address.city,
        channel: '',
        pdp_ext_f: '',
        pdpNPI: '',
        sourceType: '',
        clientType: 'pc',
        ext,
    });
}

/**
 * Sign + fire ONE MTOP H5 call through the page's request context, with the token dance.
 *
 * The first call on a tokenless session returns `FAIL_SYS_TOKEN_EMPTY` but sets the cookie, so we
 * re-read it and retry. `data` is the EXACT JSON string that is both signed and sent. Returns the
 * parsed response object, or `null` on a non-JSON body (a block) / transport failure. Callers inspect
 * `ret`/`data.result` to tell block from success.
 */
async function callMtopRequest(page: Page, api: string, data: string, log: Log, gateway: Gateway): Promise<Record<string, unknown> | null> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const token = await readMtopToken(page, gateway.acsBase);
        const t = Date.now().toString();
        const sign = md5(`${token}&${t}&${PDP_APP_KEY}&${data}`);
        const params = new URLSearchParams({
            jsv: '2.5.1',
            appKey: PDP_APP_KEY,
            t,
            sign,
            api,
            v: '1.0',
            type: 'originaljsonp',
            dataType: 'jsonp',
            callback: 'mtopjsonp',
            data,
        });
        const url = `${gateway.acsBase}/${api}/1.0/?${params.toString()}`;

        let body: string;
        try {
            const res = await page.request.get(url, {
                timeout: 15_000,
                headers: { referer: `${gateway.origin}/`, origin: gateway.origin },
            });
            body = await res.text();
        } catch (error) {
            log.warning('MTOP request failed — retrying.', { api, attempt, error: error instanceof Error ? error.message : String(error) });
            continue;
        }

        let json: Record<string, unknown>;
        try {
            json = JSON.parse(body.replace(/^\s*\w+\(/, '').replace(/\)\s*;?\s*$/, ''));
        } catch {
            log.warning('MTOP non-JSON body (likely block).', { api, attempt, snippet: body.slice(0, 120) });
            return null;
        }

        const { ret } = json as { ret?: unknown[] };
        const retStr = Array.isArray(ret) && typeof ret[0] === 'string' ? (ret[0] as string) : '';
        // Token not ready: the response just set a fresh `_m_h5_tk` cookie; loop to re-read + re-sign.
        if (/TOKEN_EMPTY|TOKEN_EXPIRED|TOKEN_EXOIRED/i.test(retStr)) {
            continue;
        }
        return json;
    }
    return null;
}

/**
 * Fetch the product modules via `mtop.aliexpress.pdp.pc.query` DIRECTLY (no product-page navigation
 * needed beyond the session bootstrap). Returns the `data.result` module map, or `null` when blocked
 * (e.g. `FAIL_SYS_USER_VALIDATE`) so the caller rotates to a fresh session.
 */
export async function fetchPdpDirect(
    page: Page,
    productId: string | number,
    log: Log,
    address: RegionAddress = { country: 'US', province: '', city: '' },
    storefront: Storefront = GLOBAL_STOREFRONT,
): Promise<Record<string, unknown> | null> {
    const gateway = gatewayFor(address.country, storefront);
    const json = await callMtopRequest(page, PDP_API, buildPdpData(productId, address, storefront, gateway), log, gateway);
    if (!json) {
        return null;
    }
    const result = asRecord(asRecord(json.data).result);
    if (Object.keys(result).length > 0) {
        return result;
    }
    const { ret } = json as { ret?: unknown[] };
    // An empty result here is ambiguous: an anti-bot block OR a listing the seller simply won't ship
    // to the requested address. Log the region so the second case is diagnosable from the run log.
    log.warning('pdp.pc.query — no result (block or unavailable for ship-to).', {
        ret: Array.isArray(ret) ? ret[0] : null,
        shipToCountry: address.country,
        site: gateway.site,
    });
    return null;
}

/** Why a storefront refuses to sell a listing to the requested address. */
export interface PdpUnavailability {
    /** AliExpress's own code, e.g. `SITEM_BAN_NO_AVAIL_SKU`. */
    errorCode: string;
    /** The shopper-facing sentence AliExpress renders in place of the buy box, in the storefront's language. */
    message: string | null;
}

/**
 * Detect the "this storefront does not sell this item to you" answer.
 *
 * It is NOT an error response: `ret` is `SUCCESS`, HTTP is 200, and `data.result` is a well-formed
 * object — it just holds `GLOBAL_DATA` alone, with every product module (PRODUCT_TITLE, PRICE,
 * HEADER_IMAGE_PC, …) absent and `globalData.bigBossBan: true` in their place.
 *
 * Without this check the caller sees a result object with no title and can only read it as an
 * anti-bot block, which sends the crawler through its full retry-and-rotate budget chasing a listing
 * no fresh IP will ever return. `bigBossBan` is a merchandising decision, not a defence.
 */
export function pdpUnavailability(result: Record<string, unknown>): PdpUnavailability | null {
    const globalData = asRecord(asRecord(result.GLOBAL_DATA).globalData);
    if (globalData.bigBossBan !== true) {
        return null;
    }
    const code = typeof globalData.errorCode === 'string' ? globalData.errorCode.trim() : '';
    const tip = typeof globalData.bigBossBanTip === 'string' ? globalData.bigBossBanTip.trim() : '';
    return { errorCode: code || 'BIG_BOSS_BAN', message: tip || null };
}

/**
 * Title — PRODUCT_TITLE.text.
 *
 * For this Actor the title IS the existence proof: a listing that resolves for the requested market
 * carries one, and nothing else in the payload is a cheaper or more reliable yes/no.
 */
export function parseTitle(result: Record<string, unknown>): string | null {
    const t = asRecord(result.PRODUCT_TITLE).text;
    return typeof t === 'string' && t.trim() !== '' ? t.trim() : null;
}
