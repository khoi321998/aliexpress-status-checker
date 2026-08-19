// Ship-to country resolution.
//
// AliExpress gates availability on the MARKET, not just on the item id: a listing the seller does
// not ship to the US can be perfectly alive on `es.aliexpress.com` and answer with a page that has
// no `og:title` on `www.aliexpress.com`. Reporting that as "removed" is simply wrong.
//
// So every URL carries its own country, read off the URL the user pasted, and the storefront host,
// the proxy exit IP and the `aep_usuc_f` region cookie all have to name that ONE country. Splitting
// them (Spanish storefront over a US IP) is a contradiction no real buyer produces and AliExpress
// answers it with captchas.
//
// Adapted from the sibling `aliexpress-data-scraper` Actor (`src/url.ts`, `src/config.ts`).

/** Ship-to used when a URL carries no regional signal (`www.`, `m.`, `best.`). */
export const DEFAULT_SHIP_TO_COUNTRY = 'US';

/**
 * Ship-to country → the storefront subdomain AliExpress serves that market on. Countries without a
 * dedicated localized host (GB, AU, CA, MX, ...) fall through to `www`, which is what a buyer there
 * actually browses.
 */
const COUNTRY_TO_SUBDOMAIN: Record<string, string> = {
    US: 'www',
    ES: 'es',
    FR: 'fr',
    DE: 'de',
    IT: 'it',
    NL: 'nl',
    PL: 'pl',
    PT: 'pt',
    BR: 'pt',
    RU: 'ru',
    TR: 'tr',
    KR: 'ko',
    JP: 'ja',
    VN: 'vi',
    TH: 'th',
    ID: 'id',
    IL: 'he',
    SA: 'ar',
    AE: 'ar',
};

/** The storefront host for a ship-to country, e.g. `ES` → `es.aliexpress.com`. */
export function storefrontHost(country?: string): string {
    const sub = country ? (COUNTRY_TO_SUBDOMAIN[country.toUpperCase()] ?? 'www') : 'www';
    return `${sub}.aliexpress.com`;
}

/**
 * ISO-3166 alpha-3 (as AliExpress writes it in `gatewayAdapt=glo2<iso3>`) → alpha-2, for the
 * markets AliExpress runs a localized gateway for. Anything not listed falls through to the
 * subdomain heuristic below.
 */
const GATEWAY_ISO3_TO_ISO2: Record<string, string> = {
    usa: 'US',
    esp: 'ES',
    fra: 'FR',
    deu: 'DE',
    ita: 'IT',
    nld: 'NL',
    pol: 'PL',
    prt: 'PT',
    bra: 'BR',
    rus: 'RU',
    tur: 'TR',
    kor: 'KR',
    jpn: 'JP',
    vnm: 'VN',
    tha: 'TH',
    idn: 'ID',
    isr: 'IL',
    sau: 'SA',
    are: 'AE',
    gbr: 'GB',
    aus: 'AU',
    can: 'CA',
    mex: 'MX',
    chl: 'CL',
};

/**
 * Locale subdomain → the country AliExpress ships to on that storefront. Only unambiguous
 * language↔market pairs are listed; `www`, `m`, `best`, ... deliberately map to nothing so the
 * caller falls back to the default.
 *
 * `pt` → BR because AliExpress's Portuguese storefront targets Brazil, not Portugal (a Portuguese
 * buyer lands on `pt.aliexpress.com` with `gatewayAdapt=glo2prt`, which the ISO-3 map catches first).
 */
const SUBDOMAIN_TO_COUNTRY: Record<string, string> = {
    us: 'US',
    es: 'ES',
    fr: 'FR',
    de: 'DE',
    it: 'IT',
    nl: 'NL',
    pl: 'PL',
    pt: 'BR',
    ru: 'RU',
    tr: 'TR',
    ko: 'KR',
    ja: 'JP',
    vi: 'VN',
    th: 'TH',
    id: 'ID',
    he: 'IL',
    ar: 'SA',
};

/**
 * Work out which market the user was shopping in when they copied this URL, so the check runs
 * under the SAME region.
 *
 * Two signals, most explicit first:
 *   1. `?gatewayAdapt=glo2esp` — AliExpress's own redirect stamp, an ISO-3 country code. Trusted
 *      over the subdomain, which can lag behind a manual region switch.
 *   2. the locale subdomain (`es.`, `de.`, `vi.`, ...).
 *
 * Returns `null` when the URL carries no regional signal (`www.`, `m.`), leaving the choice to the
 * caller's default.
 *
 * Must be called on the RAW url — normalization strips exactly the signals it reads.
 */
export function detectShipToCountry(raw: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(raw.trim());
    } catch {
        return null;
    }
    if (!/(^|\.)aliexpress\.(com|us)$/i.test(parsed.hostname)) {
        return null;
    }

    const gateway = parsed.searchParams.get('gatewayAdapt');
    const iso3 = gateway?.match(/glo2([a-z]{3})/i)?.[1]?.toLowerCase();
    if (iso3 && GATEWAY_ISO3_TO_ISO2[iso3]) {
        return GATEWAY_ISO3_TO_ISO2[iso3];
    }

    const sub = parsed.hostname.toLowerCase().split('.')[0];
    return SUBDOMAIN_TO_COUNTRY[sub] ?? null;
}

/** The ship-to country for one start URL: whatever the URL carries, else the default. */
export function resolveShipToCountry(rawUrl: string): string {
    return detectShipToCountry(rawUrl) ?? DEFAULT_SHIP_TO_COUNTRY;
}

/**
 * The AliExpress locale cookie. `region` is the ship-to and is the whole point of this file;
 * currency and language stay pinned to USD/en_US so results are comparable across markets.
 */
export function localeCookie(country: string): string {
    return `aep_usuc_f=site=glo&c_tp=USD&region=${country.toUpperCase()}&b_locale=en_US&ae_u_p_s=2; intl_locale=en_US`;
}
