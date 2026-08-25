import { createHash } from 'node:crypto';

import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';

import { detectShipToCountry, localeCookie, resolveShipToCountry, storefrontHost } from '../src/country.js';
import { buildPdpData, buildSignedUrl, classifyMtopResponse, gatewayFor, readTokenFromSetCookie, unwrapJsonp } from '../src/mtop.js';
import { extractProductId, looksBlocked, normalizeAliexpressUrl, normalizeUrl, parseProductStatus } from '../src/routes.js';

const PRODUCT_URL = 'https://vi.aliexpress.com/item/1005004771213104.html';
const US_URL = 'https://www.aliexpress.us/item/3256811881845913.html?spm=a2g0o.home&gps-id=x';

// A live product page is large; pad the body so it passes the size-based block check.
const bigBody = (head: string) => `<html><head>${head}</head><body>${'x'.repeat(6000)}</body></html>`;

describe('extractProductId', () => {
    it('extracts the numeric id from an item URL', () => {
        expect(extractProductId(PRODUCT_URL)).toBe('1005004771213104');
        expect(extractProductId(US_URL)).toBe('3256811881845913');
    });

    it('returns null when the URL has no item id', () => {
        expect(extractProductId('https://vi.aliexpress.com/')).toBeNull();
    });
});

describe('normalizeAliexpressUrl', () => {
    it('rewrites any host + strips tracking query to canonical www.aliexpress.com', () => {
        expect(normalizeAliexpressUrl(US_URL)).toBe('https://www.aliexpress.com/item/3256811881845913.html');
    });

    it('leaves non-item URLs untouched', () => {
        expect(normalizeAliexpressUrl('https://vi.aliexpress.com/')).toBe('https://vi.aliexpress.com/');
    });
});

describe('detectShipToCountry', () => {
    it('prefers the gatewayAdapt stamp over the subdomain', () => {
        expect(detectShipToCountry('https://www.aliexpress.com/item/1.html?gatewayAdapt=glo2esp')).toBe('ES');
        // The stamp wins even when it disagrees with the host.
        expect(detectShipToCountry('https://vi.aliexpress.com/item/1.html?gatewayAdapt=glo2deu')).toBe('DE');
    });

    it('falls back to the locale subdomain', () => {
        expect(detectShipToCountry(PRODUCT_URL)).toBe('VN');
        expect(detectShipToCountry('https://es.aliexpress.com/item/1005008991183191.html')).toBe('ES');
    });

    it('returns null for hosts carrying no regional signal', () => {
        expect(detectShipToCountry('https://www.aliexpress.com/item/1.html')).toBeNull();
        expect(detectShipToCountry('https://m.aliexpress.com/item/1.html')).toBeNull();
    });

    it('returns null for non-AliExpress or malformed URLs', () => {
        expect(detectShipToCountry('https://example.com/item/1.html')).toBeNull();
        expect(detectShipToCountry('not a url')).toBeNull();
    });

    it('defaults regionless URLs to US', () => {
        expect(resolveShipToCountry('https://www.aliexpress.com/item/1.html')).toBe('US');
        expect(resolveShipToCountry(PRODUCT_URL)).toBe('VN');
    });
});

describe('storefrontHost', () => {
    it('maps a country to its storefront subdomain', () => {
        expect(storefrontHost('ES')).toBe('es.aliexpress.com');
        expect(storefrontHost('VN')).toBe('vi.aliexpress.com');
        expect(storefrontHost('US')).toBe('www.aliexpress.com');
    });

    it('falls back to www for markets without a localized host', () => {
        expect(storefrontHost('GB')).toBe('www.aliexpress.com');
        expect(storefrontHost()).toBe('www.aliexpress.com');
    });
});

describe('normalizeUrl', () => {
    it('puts a product on the storefront of its market', () => {
        expect(normalizeUrl(US_URL, 'product', 'ES')).toBe('https://es.aliexpress.com/item/3256811881845913.html');
        expect(normalizeUrl(PRODUCT_URL, 'product', 'VN')).toBe('https://vi.aliexpress.com/item/1005004771213104.html');
    });

    it('keeps stores on www regardless of the market', () => {
        const store = 'https://es.aliexpress.com/store/1101692994?spm=a2g0o.x';
        expect(normalizeUrl(store, 'seller', 'ES')).toBe('https://www.aliexpress.com/store/1101692994');
    });
});

describe('localeCookie', () => {
    it('pins the region to the market and the rest to USD/en_US', () => {
        expect(localeCookie('ES')).toContain('region=ES');
        expect(localeCookie('es')).toContain('region=ES');
        expect(localeCookie('ES')).toContain('c_tp=USD');
        expect(localeCookie('ES')).toContain('b_locale=en_US');
    });
});

describe('parseProductStatus', () => {
    it('marks a product available when og:title is present', () => {
        const html = bigBody('<meta property="og:title" content="Phone Holder - AliExpress" />');
        const result = parseProductStatus(load(html), US_URL, PRODUCT_URL, 200, html, 'VN');

        expect(result.available).toBe(true);
        expect(result.country).toBe('VN');
        expect(result.status).toBe('available');
        expect(result.title).toBe('Phone Holder - AliExpress');
        expect(result.url).toBe(US_URL);
        expect(result.finalUrl).toBe(PRODUCT_URL);
        expect(result.productId).toBe('3256811881845913');
    });

    it('marks a product unavailable when og:title is missing on a full-size page', () => {
        const html = bigBody('<title>Product not found</title>');
        const result = parseProductStatus(load(html), PRODUCT_URL, PRODUCT_URL, 200, html, 'VN');

        expect(result.available).toBe(false);
        expect(result.status).toBe('unavailable');
        expect(result.title).toBeNull();
    });

    it('throws (retries) on a tiny block stub without og:title', () => {
        const html = '<html><head><title>...</title></head><body>redirecting</body></html>';
        expect(() => parseProductStatus(load(html), PRODUCT_URL, PRODUCT_URL, 200, html, 'VN')).toThrow(/anti-bot/);
    });

    it('throws (retries) when the response came back from another market', () => {
        // AliExpress bounced an ES request to the VN storefront because the exit IP is Vietnamese —
        // the page is real, but it answers about the wrong market.
        const html = bigBody('<meta property="og:title" content="Phone Holder - AliExpress" />');
        const landed = 'https://vi.aliexpress.com/item/1.html?gatewayAdapt=esp2vnm';
        expect(() => parseProductStatus(load(html), PRODUCT_URL, landed, 200, html, 'ES')).toThrow(/storefront/);
    });

    it('accepts a US check that stays on www (no regional signal)', () => {
        const html = bigBody('<meta property="og:title" content="Phone Holder - AliExpress" />');
        const landed = 'https://www.aliexpress.com/item/1.html';
        expect(parseProductStatus(load(html), landed, landed, 200, html, 'US').available).toBe(true);
    });

    it('throws (retries) when redirected to a punish URL', () => {
        const html = bigBody('<title>blocked</title>');
        const punish = 'https://login.aliexpress.com/punish?x=1';
        expect(() => parseProductStatus(load(html), PRODUCT_URL, punish, 200, html)).toThrow();
    });
});

describe('MTOP availability probe', () => {
    const withTitle = { ret: ['SUCCESS::调用成功'], data: { result: { PRODUCT_TITLE: { text: 'Phone Holder' } } } };

    it('reads a populated payload as available', () => {
        expect(classifyMtopResponse(withTitle)).toEqual({ status: 'available', title: 'Phone Holder', ret: 'SUCCESS::调用成功' });
    });

    it('reads SUCCESS with an empty result as "not shipped to this market"', () => {
        // This is the exact shape behind "este artículo no está disponible en tu ubicación".
        expect(classifyMtopResponse({ ret: ['SUCCESS::调用成功'], data: { result: {} } })).toEqual({
            status: 'unavailable',
            ret: 'SUCCESS::调用成功',
        });
    });

    it('never turns an anti-bot ret into a product verdict', () => {
        for (const ret of ['FAIL_SYS_USER_VALIDATE::RGV587_ERROR', 'FAIL_SYS_TRAFFIC_LIMIT::限流']) {
            expect(classifyMtopResponse({ ret: [ret], data: {} }).status).toBe('blocked');
        }
    });

    it('refuses to guess when SUCCESS carries modules but no title', () => {
        const verdict = classifyMtopResponse({ ret: ['SUCCESS'], data: { result: { PRICE: { x: 1 } } } });
        expect(verdict).toEqual({ status: 'blocked', ret: 'SUCCESS', reason: 'success-without-title' });
    });

    it('treats a malformed body as blocked, not as a verdict', () => {
        expect(classifyMtopResponse(null).status).toBe('blocked');
        expect(classifyMtopResponse('<html>captcha</html>').status).toBe('blocked');
    });

    it('unwraps the JSONP callback the endpoint is asked for', () => {
        expect(unwrapJsonp('mtopjsonp({"ret":["SUCCESS"]});')).toBe('{"ret":["SUCCESS"]}');
        expect(unwrapJsonp('{"ret":["SUCCESS"]}')).toBe('{"ret":["SUCCESS"]}');
    });

    it('picks the MTOP token out of Set-Cookie, ignoring the timestamp suffix', () => {
        expect(readTokenFromSetCookie(['_m_h5_tk=abc123_1750000000000; path=/', 'other=1'])).toBe('abc123');
        expect(readTokenFromSetCookie(undefined)).toBeNull();
        expect(readTokenFromSetCookie(['unrelated=1'])).toBeNull();
    });

    it('sends non-US markets to the global gateway and US to the .us one', () => {
        expect(gatewayFor('ES')).toMatchObject({ acsBase: 'https://acs.aliexpress.com/h5', origin: 'https://es.aliexpress.com', site: 'glo' });
        expect(gatewayFor('US')).toMatchObject({ acsBase: 'https://acs.aliexpress.us/h5', site: 'usa' });
    });

    it('signs with MD5(token & t & appKey & data) and carries the ship-to in the payload', () => {
        const gateway = gatewayFor('ES');
        const data = buildPdpData('1005008003575937', 'ES', gateway);
        expect(JSON.parse(data)).toMatchObject({ productId: '1005008003575937', country: 'ES', clientType: 'pc' });

        const url = new URL(buildSignedUrl(data, 'tok', gateway, 1_750_000_000_000));
        expect(url.searchParams.get('sign')).toBe(createHash('md5').update(`tok&1750000000000&12574478&${data}`).digest('hex'));
        expect(url.searchParams.get('api')).toBe('mtop.aliexpress.pdp.pc.query');
        expect(url.searchParams.get('data')).toBe(data);
    });
});

describe('looksBlocked', () => {
    it('flags punish/login final URLs', () => {
        expect(looksBlocked('https://login.aliexpress.com/punish', 'x'.repeat(9000))).toBe(true);
    });

    it('flags tiny bodies', () => {
        expect(looksBlocked('https://www.aliexpress.com/item/1.html', 'short')).toBe(true);
    });

    it('does NOT flag a normal large product page (SDK markers are not used)', () => {
        const html = `${'a'.repeat(9000)} nc_token _____tmd_____ captcha`;
        expect(looksBlocked('https://vi.aliexpress.com/item/1.html', html)).toBe(false);
    });
});
