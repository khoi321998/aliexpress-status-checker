import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';

import { buildConfig, proxyGroupsFor, resolveShipToCountry, storefrontForRequest } from '../src/config.js';
import { parseTitle, pdpUnavailability } from '../src/productApi.js';
import { createStatusResponse, toOutputItem } from '../src/response.js';
import { blockReasonFromError } from '../src/routes.js';
import { extractStoreId, looksBlocked, normalizeStoreUrl, parseSellerStatus } from '../src/sellerPipeline.js';
import { addressFromLocaleCookie, buildLocaleCookie, parseLocaleCookie, storefrontFor } from '../src/storefront.js';
import { detectShipToCountry, extractAliExpressItemId, normalizeAliExpressUrl, storefrontHost } from '../src/url.js';

const PRODUCT_URL = 'https://vi.aliexpress.com/item/1005004771213104.html';
const US_URL = 'https://www.aliexpress.us/item/3256811881845913.html?spm=a2g0o.home&gps-id=x';
const STORE_URL = 'https://es.aliexpress.com/store/1101692994?spm=a2g0o.x';

// A live store page is large; pad the body so it passes the size-based block check.
const bigBody = (head: string) => `<html><head>${head}</head><body>${'x'.repeat(6000)}</body></html>`;

describe('extractAliExpressItemId', () => {
    it('extracts the numeric id from an item URL', () => {
        expect(extractAliExpressItemId(PRODUCT_URL)).toBe('1005004771213104');
        expect(extractAliExpressItemId(US_URL)).toBe('3256811881845913');
    });

    it('returns null when the URL has no item id', () => {
        expect(extractAliExpressItemId('https://vi.aliexpress.com/')).toBeNull();
    });
});

describe('normalizeAliExpressUrl', () => {
    it('puts a product on the storefront host of its market and drops tracking params', () => {
        expect(normalizeAliExpressUrl(US_URL, 'ES')).toBe('https://es.aliexpress.com/item/3256811881845913.html');
        expect(normalizeAliExpressUrl(PRODUCT_URL, 'VN')).toBe('https://vi.aliexpress.com/item/1005004771213104.html');
    });

    it('falls back to www when no country is given', () => {
        expect(normalizeAliExpressUrl(US_URL)).toBe('https://www.aliexpress.com/item/3256811881845913.html');
    });

    it('returns null for non-product AliExpress URLs and non-AliExpress hosts', () => {
        expect(normalizeAliExpressUrl('https://vi.aliexpress.com/')).toBeNull();
        expect(normalizeAliExpressUrl('https://example.com/item/1.html')).toBeNull();
        expect(normalizeAliExpressUrl('not a url')).toBeNull();
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

describe('storefront identity', () => {
    it('maps a market to its own storefront, unknown markets to the global one', () => {
        expect(storefrontFor('ES')).toEqual({ site: 'esp', locale: 'es_ES', currency: 'EUR' });
        expect(storefrontFor('ZZ')).toEqual({ site: 'glo', locale: 'en_US', currency: 'USD' });
    });

    it('collapses every market to the global catalogue when matchStorefrontLocale is off', () => {
        const config = buildConfig({ matchStorefrontLocale: false });
        expect(storefrontForRequest('ES', config).site).toBe('glo');
        expect(storefrontForRequest('ES', buildConfig({})).site).toBe('esp');
    });

    it('round-trips the aep_usuc_f cookie, dropping empty parts', () => {
        const value = buildLocaleCookie({ site: 'esp', province: '', city: '', region: 'ES', b_locale: 'es_ES' });
        expect(value).toBe('site=esp&region=ES&b_locale=es_ES');
        expect(parseLocaleCookie(value)).toEqual({ site: 'esp', region: 'ES', b_locale: 'es_ES' });
    });

    it('carries the session province/city forward, never inventing one', () => {
        expect(addressFromLocaleCookie('ES', 'site=esp&province=919971656567000000&city=12345')).toEqual({
            country: 'ES',
            province: '919971656567000000',
            city: '12345',
        });
        expect(addressFromLocaleCookie('ES', null)).toEqual({ country: 'ES', province: '', city: '' });
    });
});

describe('config', () => {
    it('lets an explicit shipToCountry override the URL signal', () => {
        const config = buildConfig({ shipToCountry: ' de ' });
        expect(resolveShipToCountry(PRODUCT_URL, config)).toBe('DE');
    });

    it('auto-detects per URL and defaults regionless URLs to US', () => {
        const config = buildConfig({});
        expect(resolveShipToCountry(PRODUCT_URL, config)).toBe('VN');
        expect(resolveShipToCountry('https://www.aliexpress.com/item/1.html', config)).toBe('US');
    });

    it('sends every non-datacenter country through residential', () => {
        const config = buildConfig({});
        expect(proxyGroupsFor('US', config)).toEqual([]);
        expect(proxyGroupsFor('ES', config)).toEqual(['RESIDENTIAL']);
        expect(proxyGroupsFor('US', buildConfig({ residentialProxy: true }))).toEqual(['RESIDENTIAL']);
    });

    it('clamps out-of-range numeric input instead of throwing', () => {
        expect(buildConfig({ maxConcurrency: 999 }).maxConcurrency).toBe(10);
        expect(buildConfig({ maxRequestRetries: -5 }).maxRequestRetries).toBe(0);
        expect(buildConfig({}).maxConcurrency).toBe(2);
    });
});

describe('pdp.pc.query verdicts', () => {
    it('reads PRODUCT_TITLE.text as the existence proof', () => {
        expect(parseTitle({ PRODUCT_TITLE: { text: '  Phone Holder  ' } })).toBe('Phone Holder');
        expect(parseTitle({ PRODUCT_TITLE: { text: '' } })).toBeNull();
        expect(parseTitle({})).toBeNull();
    });

    it('detects the storefront refusal (bigBossBan) that carries no title', () => {
        // This is the exact shape behind "este artículo no está disponible en tu ubicación": ret is
        // SUCCESS, the result is well-formed, and every product module is simply absent.
        const refused = {
            GLOBAL_DATA: {
                globalData: {
                    bigBossBan: true,
                    errorCode: 'SITEM_BAN_NO_AVAIL_SKU',
                    bigBossBanTip: 'Este artículo no está disponible en tu ubicación.',
                },
            },
        };
        expect(pdpUnavailability(refused)).toEqual({
            errorCode: 'SITEM_BAN_NO_AVAIL_SKU',
            message: 'Este artículo no está disponible en tu ubicación.',
        });
    });

    it('falls back to a generic code when AliExpress states none', () => {
        expect(pdpUnavailability({ GLOBAL_DATA: { globalData: { bigBossBan: true } } })).toEqual({
            errorCode: 'BIG_BOSS_BAN',
            message: null,
        });
    });

    it('never reads a normal payload as a refusal', () => {
        expect(pdpUnavailability({ PRODUCT_TITLE: { text: 'Phone Holder' } })).toBeNull();
        expect(pdpUnavailability({ GLOBAL_DATA: { globalData: { bigBossBan: false } } })).toBeNull();
    });
});

describe('toOutputItem', () => {
    /** The internal verdict a given code path would produce, ready to project onto a row. */
    const verdict = (fields: Partial<ReturnType<typeof createStatusResponse>>) => {
        const response = createStatusResponse('https://www.aliexpress.com/item/3256811881845913.html', US_URL);
        response.shipToCountry = 'US';
        return Object.assign(response, fields);
    };

    it('reports the URL as the user pasted it, not the canonical one we checked', () => {
        expect(toOutputItem(verdict({ exists: true })).url).toBe(US_URL);
    });

    it('maps a resolved listing to active/available', () => {
        expect(toOutputItem(verdict({ exists: true, title: 'Phone Holder' }))).toMatchObject({
            country: 'US',
            active: true,
            reason: 'available',
        });
    });

    it('maps both "deleted" and "withdrawn from this market" to unavailable', () => {
        for (const errorCode of ['not_found', 'unavailable_in_region'] as const) {
            expect(toOutputItem(verdict({ exists: false, success: false, errorCode }))).toMatchObject({
                active: false,
                reason: 'unavailable',
            });
        }
    });

    it('never reports an anti-bot give-up as unavailable', () => {
        // `exists: null` is a statement about our session, not about the product.
        expect(toOutputItem(verdict({ exists: null, success: false, errorCode: 'blocked' }))).toMatchObject({
            active: false,
            reason: 'error',
        });
    });

    it('emits exactly the six output fields', () => {
        expect(Object.keys(toOutputItem(verdict({ exists: true }))).sort()).toEqual([
            'active',
            'actorRunId',
            'checkedAt',
            'country',
            'reason',
            'url',
        ]);
    });
});

describe('seller mode', () => {
    it('picks the store id out of any store URL', () => {
        expect(extractStoreId(STORE_URL)).toBe('1101692994');
        expect(extractStoreId(PRODUCT_URL)).toBeNull();
    });

    it('keeps stores on www regardless of the host they were pasted from', () => {
        expect(normalizeStoreUrl(STORE_URL)).toBe('https://www.aliexpress.com/store/1101692994');
    });

    it('leaves an unrecognizable store URL untouched', () => {
        expect(normalizeStoreUrl('https://www.aliexpress.com/')).toBe('https://www.aliexpress.com/');
    });

    it('marks a store available when og:title is present', () => {
        const html = bigBody('<meta property="og:title" content="Toy Store - AliExpress" />');
        const result = parseSellerStatus(load(html), STORE_URL, 'https://www.aliexpress.com/store/1101692994', 200, html);

        expect(result).toMatchObject({
            available: true,
            status: 'available',
            title: 'Toy Store - AliExpress',
            url: STORE_URL,
            storeId: '1101692994',
        });
    });

    it('marks a store unavailable when og:title is missing on a full-size page', () => {
        const html = bigBody('<title>Store not found</title>');
        const result = parseSellerStatus(load(html), STORE_URL, STORE_URL, 200, html);

        expect(result).toMatchObject({ available: false, status: 'unavailable', title: null });
    });

    it('throws (retries) on a tiny block stub without og:title', () => {
        const html = '<html><head><title>...</title></head><body>redirecting</body></html>';
        expect(() => parseSellerStatus(load(html), STORE_URL, STORE_URL, 200, html)).toThrow(/anti-bot/);
    });

    it('throws (retries) when redirected to a punish URL', () => {
        const html = bigBody('<title>blocked</title>');
        const punish = 'https://login.aliexpress.com/punish?x=1';
        expect(() => parseSellerStatus(load(html), STORE_URL, punish, 200, html)).toThrow(/anti-bot/);
    });

    it('flags punish/login final URLs and tiny bodies, but not the anti-fraud SDK markers', () => {
        expect(looksBlocked('https://login.aliexpress.com/punish', 'x'.repeat(9000))).toBe(true);
        expect(looksBlocked('https://www.aliexpress.com/store/1.html', 'short')).toBe(true);
        // These strings ship on EVERY page, live ones included — matching them caused false positives.
        const html = `${'a'.repeat(9000)} nc_token _____tmd_____ captcha`;
        expect(looksBlocked('https://www.aliexpress.com/store/1101692994', html)).toBe(false);
    });

    it('is the mode the config resolves to, and falls back to product on a typo', () => {
        expect(buildConfig({ mode: 'seller' }).mode).toBe('seller');
        expect(buildConfig({ mode: 'sellerr' }).mode).toBe('product');
        expect(buildConfig({}).mode).toBe('product');
    });
});

describe('blockReasonFromError', () => {
    it('recovers the reason a rotation encoded into its error message', () => {
        expect(blockReasonFromError(new Error('Anti-bot block (captcha); rotating to a fresh session/proxy.'))).toBe('captcha');
        expect(blockReasonFromError(new Error('Anti-bot block (pdp-timeout); rotating to a fresh session/proxy.'))).toBe('pdp-timeout');
    });

    it('returns null for failures that were not rotations', () => {
        expect(blockReasonFromError(new Error('Navigation timeout of 45000 ms exceeded'))).toBeNull();
    });
});
