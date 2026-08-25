// Per-market availability via the MTOP API the product page itself calls.
//
// WHY this file exists: the AliExpress PC product page is a client-side React app. Its HTML is a
// shell — it carries `og:title` and nothing else that varies with availability. Two items on the
// same storefront, one buyable in ES and one answering "este artículo no está disponible en tu
// ubicación", ship BYTE-FOR-BYTE equivalent heads: `<title>` empty, `description` empty, `keywords`
// empty, `og:title` populated on both. Every product field — price, SKU, and whether the seller
// ships to your market at all — arrives afterwards in ONE signed XHR to
// `mtop.aliexpress.pdp.pc.query`. So no amount of HTML parsing can answer the per-market question;
// the API has to be asked directly.
//
// The mechanism is ported from the sibling `aliexpress-screenshot` Actor (`src/productApi.ts`),
// which runs it inside a Playwright page. Here it runs over plain HTTP through Crawlee's
// `sendRequest`, so it inherits the crawler's session cookie jar and its per-country proxy — the
// same exit IP that just fetched the storefront HTML. That warm-up matters: a cold, browserless
// call to this endpoint answers `FAIL_SYS_USER_VALIDATE`.
//
// Signing (Alibaba MTOP H5): `sign = MD5(token & t & appKey & data)`, where `token` is the part of
// the `_m_h5_tk` cookie before `_`. A tokenless session's first call returns `FAIL_SYS_TOKEN_EMPTY`
// but SETS that cookie — so we re-read it and retry immediately. That is the "token dance", and it
// is why the first call looking like a failure is normal. No secrets are replicated: the appKey is
// public and the token comes from the server's own Set-Cookie.
import { createHash, randomBytes } from 'node:crypto';

import { storefrontHost } from './country.js';

/** The MTOP API that returns the full PC product payload. */
const PDP_API = 'mtop.aliexpress.pdp.pc.query';
/** Per-API H5 appKey used by the PC product endpoint. Public, embedded in the page's own JS. */
const PDP_APP_KEY = '12574478';
/** How many times to re-sign after a token-not-ready reply before giving up. */
const MAX_TOKEN_ATTEMPTS = 3;

/** The minimal shape of Crawlee's `sendRequest`, so this module needs no crawler types. */
export type SendRequest = (overrideOptions: {
    url: string;
    method?: 'GET';
    headers?: Record<string, string>;
    responseType?: 'text';
    throwHttpErrors?: boolean;
}) => Promise<{ body: string; headers: Record<string, string | string[] | undefined>; statusCode: number }>;

/**
 * What the API said about this item in this market.
 *
 * `blocked` is deliberately distinct from `unavailable`: reporting an anti-bot wall as "the seller
 * doesn't ship here" would be a confident lie, so the caller retries on a fresh session instead.
 */
export type MtopVerdict =
    | { status: 'available'; title: string; ret: string }
    | { status: 'unavailable'; ret: string }
    | { status: 'blocked'; ret: string; reason: string };

/** Which MTOP gateway (and the site identity that goes with it) a ship-to must be asked on. */
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
 * only answers for it — asking it about a listing that lives only on the global site produces a
 * spurious "not found". Every non-US ship-to goes to the global `.com` gateway, which is the only
 * one that serves those markets.
 */
export function gatewayFor(shipToCountry: string): Gateway {
    if (shipToCountry.toUpperCase() === 'US') {
        return { acsBase: 'https://acs.aliexpress.us/h5', origin: 'https://www.aliexpress.us', site: 'usa', host: 'www.aliexpress.us' };
    }
    // Claim the same storefront the crawler actually fetched (`es.aliexpress.com`, ...), so referer
    // and `ext.host` match the page this signed call is supposed to be coming from.
    const host = storefrontHost(shipToCountry);
    return { acsBase: 'https://acs.aliexpress.com/h5', origin: `https://${host}`, site: 'glo', host };
}

function md5(input: string): string {
    return createHash('md5').update(input).digest('hex');
}

/** Narrow an unknown to a plain object; non-objects become `{}`. */
function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Build the `data` payload the PC page sends for pdp.pc.query (locale/region inline, not cookie).
 *
 * `country` is the ship-to and it decides whether the listing resolves at all: a seller who does
 * not ship there answers with an empty `result`. It must agree with the `region` in the page's
 * `aep_usuc_f` cookie and with the proxy's exit country, or the answer is about another market.
 */
export function buildPdpData(productId: string, shipToCountry: string, gateway: Gateway): string {
    const ext = JSON.stringify({
        foreverRandomToken: randomBytes(16).toString('hex'),
        site: gateway.site,
        crawler: false,
        'x-m-biz-bx-region': '',
        signedIn: false,
        host: gateway.host,
    });
    return JSON.stringify({
        productId,
        _lang: 'en_US',
        _currency: 'USD',
        country: shipToCountry.toUpperCase(),
        province: '',
        city: '',
        channel: '',
        pdp_ext_f: '',
        pdpNPI: '',
        sourceType: '',
        clientType: 'pc',
        ext,
    });
}

/** Build the signed request URL for one attempt. Exported for unit testing the signature shape. */
export function buildSignedUrl(data: string, token: string, gateway: Gateway, now = Date.now()): string {
    const t = String(now);
    const params = new URLSearchParams({
        jsv: '2.5.1',
        appKey: PDP_APP_KEY,
        t,
        sign: md5(`${token}&${t}&${PDP_APP_KEY}&${data}`),
        api: PDP_API,
        v: '1.0',
        type: 'originaljsonp',
        dataType: 'jsonp',
        callback: 'mtopjsonp',
        data,
    });
    return `${gateway.acsBase}/${PDP_API}/1.0/?${params.toString()}`;
}

/** Pull the MTOP token (the part of `_m_h5_tk` before the `_`) out of Set-Cookie headers. */
export function readTokenFromSetCookie(setCookie: string | string[] | undefined): string | null {
    const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
    for (const cookie of list) {
        const match = /_m_h5_tk=([^;_]+)_/.exec(cookie);
        if (match) {
            return match[1];
        }
    }
    return null;
}

/** Strip the JSONP wrapper (`mtopjsonp({...})`) that `dataType=jsonp` asks for. */
export function unwrapJsonp(body: string): string {
    return body.replace(/^\s*\w+\(/, '').replace(/\)\s*;?\s*$/, '');
}

/**
 * Classify one parsed MTOP response.
 *
 * The distinction that matters: a `SUCCESS` ret with an EMPTY `result` is the API's way of saying
 * "this listing does not resolve for that ship-to" — that is a real `unavailable`. Any other ret
 * (`FAIL_SYS_USER_VALIDATE`, `FAIL_SYS_TRAFFIC_LIMIT`, ...) is the anti-bot layer talking about our
 * session, not about the product, so it must NOT be reported as a verdict.
 *
 * Pure, so the whole decision table is unit-testable without touching the network.
 */
export function classifyMtopResponse(json: unknown): MtopVerdict {
    const root = asRecord(json);
    const retArray = Array.isArray(root.ret) ? root.ret : [];
    const ret = typeof retArray[0] === 'string' ? retArray[0] : '';
    const result = asRecord(asRecord(root.data).result);

    const rawTitle = asRecord(result.PRODUCT_TITLE).text;
    const title = typeof rawTitle === 'string' && rawTitle.trim() !== '' ? rawTitle.trim() : null;
    if (title) {
        return { status: 'available', title, ret };
    }

    if (/^SUCCESS/i.test(ret)) {
        // Belt and braces: a SUCCESS payload that carries modules but no title is not something we
        // understand, so refuse to call it either way rather than guess.
        if (Object.keys(result).length > 0) {
            return { status: 'blocked', ret, reason: 'success-without-title' };
        }
        return { status: 'unavailable', ret };
    }

    return { status: 'blocked', ret, reason: ret || 'non-success-ret' };
}

/** True when the reply just means "no token yet, here's one" — retry, do not treat as failure. */
function isTokenNotReady(json: unknown): boolean {
    const retArray = Array.isArray(asRecord(json).ret) ? (asRecord(json).ret as unknown[]) : [];
    const ret = typeof retArray[0] === 'string' ? retArray[0] : '';
    // `TOKEN_EXOIRED` is AliExpress's own typo and is returned in the wild — match it deliberately.
    return /TOKEN_EMPTY|TOKEN_EXPIRED|TOKEN_EXOIRED/i.test(ret);
}

/**
 * Ask the API whether `productId` is buyable in `shipToCountry`, over the crawler's own session
 * and proxy.
 *
 * Runs the token dance: sign with whatever token we have (possibly none), and if the reply says the
 * token was empty/expired, re-read the one it just handed us and sign again.
 */
export async function probeAvailability(
    sendRequest: SendRequest,
    productId: string,
    shipToCountry: string,
    onDebug?: (message: string, data: Record<string, unknown>) => void,
): Promise<MtopVerdict> {
    const gateway = gatewayFor(shipToCountry);
    const data = buildPdpData(productId, shipToCountry, gateway);
    let token = '';
    let lastRet = '';

    for (let attempt = 1; attempt <= MAX_TOKEN_ATTEMPTS; attempt += 1) {
        let response: Awaited<ReturnType<SendRequest>>;
        try {
            response = await sendRequest({
                url: buildSignedUrl(data, token, gateway),
                method: 'GET',
                responseType: 'text',
                // A 4xx/5xx body still carries the ret code we want to classify, so read it rather
                // than letting got throw and losing the diagnosis.
                throwHttpErrors: false,
                headers: { referer: `${gateway.origin}/`, origin: gateway.origin, accept: '*/*' },
            });
        } catch (error) {
            return { status: 'blocked', ret: lastRet, reason: `transport: ${error instanceof Error ? error.message : String(error)}` };
        }

        const fresh = readTokenFromSetCookie(response.headers['set-cookie']);
        if (fresh) {
            token = fresh;
        }

        let json: unknown;
        try {
            json = JSON.parse(unwrapJsonp(response.body));
        } catch {
            return { status: 'blocked', ret: lastRet, reason: `non-json (${response.statusCode})` };
        }

        if (isTokenNotReady(json)) {
            lastRet = String(asRecord(json).ret ?? '');
            onDebug?.('MTOP token dance — re-signing.', { attempt, productId, ret: lastRet });
            continue;
        }

        const verdict = classifyMtopResponse(json);
        onDebug?.('MTOP pdp.pc.query answered.', { attempt, productId, shipToCountry, ...verdict });
        return verdict;
    }

    return { status: 'blocked', ret: lastRet, reason: 'token-dance-exhausted' };
}
