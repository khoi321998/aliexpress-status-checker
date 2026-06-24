import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';

import { extractProductId, looksBlocked, normalizeAliexpressUrl, parseProductStatus } from '../src/routes.js';

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

describe('parseProductStatus', () => {
    it('marks a product available when og:title is present', () => {
        const html = bigBody('<meta property="og:title" content="Phone Holder - AliExpress" />');
        const result = parseProductStatus(load(html), US_URL, PRODUCT_URL, 200, html);

        expect(result.available).toBe(true);
        expect(result.status).toBe('available');
        expect(result.title).toBe('Phone Holder - AliExpress');
        expect(result.url).toBe(US_URL);
        expect(result.finalUrl).toBe(PRODUCT_URL);
        expect(result.productId).toBe('3256811881845913');
    });

    it('marks a product unavailable when og:title is missing on a full-size page', () => {
        const html = bigBody('<title>Product not found</title>');
        const result = parseProductStatus(load(html), PRODUCT_URL, PRODUCT_URL, 200, html);

        expect(result.available).toBe(false);
        expect(result.status).toBe('unavailable');
        expect(result.title).toBeNull();
    });

    it('throws (retries) on a tiny block stub without og:title', () => {
        const html = '<html><head><title>...</title></head><body>redirecting</body></html>';
        expect(() => parseProductStatus(load(html), PRODUCT_URL, PRODUCT_URL, 200, html)).toThrow();
    });

    it('throws (retries) when redirected to a punish URL', () => {
        const html = bigBody('<title>blocked</title>');
        const punish = 'https://login.aliexpress.com/punish?x=1';
        expect(() => parseProductStatus(load(html), PRODUCT_URL, punish, 200, html)).toThrow();
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
