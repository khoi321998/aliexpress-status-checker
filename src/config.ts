// Central, typed configuration for the AliExpress status checker.
//
// Everything tunable lives here so the crawler wiring in `main.ts` stays declarative and
// operators have a single place to reason about anti-bot trade-offs. Values come from the
// Actor input (see `.actor/input_schema.json`) with safe production defaults applied here;
// anything not worth surfacing in the Console form is just a constant in this file.
//
// Anti-bot strategy: avoidance + rotation only. When AliExpress serves a captcha / punish /
// verify / empty page, we abandon the burned session (IP + fingerprint) and retry on a fresh
// one. We deliberately do NOT solve captchas — the Alibaba slider is solver-resistant and
// rotating off a clean residential IP is cheaper and more reliable.
//
// Ported from the sibling `aliexpress-data-scraper` Actor (`src/config.ts`), trimmed to the knobs an
// existence check actually has: there is no capture mode, no seller pipeline and no captcha solver.

import type { Storefront } from './storefront.js';
import { GLOBAL_STOREFRONT, storefrontFor } from './storefront.js';
import { detectShipToCountry } from './url.js';

/**
 * What kind of URL the run checks:
 *   - `product`: item pages, through a browser + the signed `pdp.pc.query` API, per market.
 *   - `seller`: store pages, over plain HTTP via `og:title` — a store exists or it doesn't,
 *     identically in every market, and it says so server-side. See `sellerPipeline.ts`.
 */
export type Mode = 'product' | 'seller';

/** The accepted `mode` values, as a runtime list for input validation. */
export const MODES: readonly Mode[] = ['product', 'seller'];

/** Raw Actor input shape (mirrors `.actor/input_schema.json`). */
export interface CheckerInput {
    startUrls?: { url: string }[];
    mode?: string;
    headless?: boolean;
    /**
     * Force one ship-to country (ISO-3166 alpha-2) for every start URL. Leave empty to auto-detect
     * it per URL from the locale subdomain / `gatewayAdapt` stamp the user pasted.
     */
    shipToCountry?: string;
    /**
     * Force the RESIDENTIAL proxy group for EVERY country, including ones the datacenter pool can
     * serve. Non-US ship-to already uses residential automatically — see {@link proxyGroupsFor}.
     */
    residentialProxy?: boolean;
    /**
     * Ask each ship-to country's OWN storefront (`site=esp`, page in Spanish) instead of the global
     * catalogue. See {@link CheckerConfig.matchStorefrontLocale}. Default `true`.
     */
    matchStorefrontLocale?: boolean;
    /** Upper bound on URLs checked in one run. */
    maxRequestsPerCrawl?: number;
    /** How many URLs are checked in parallel. */
    maxConcurrency?: number;
    /** How many times a blocked URL is retried on a fresh session before it is recorded as blocked. */
    maxRequestRetries?: number;
    /** Seller mode only — minimum delay between consecutive store requests. */
    sameDomainDelaySecs?: number;
}

/** Fully-resolved configuration consumed by the crawler. */
export interface CheckerConfig {
    /** Which of the two pipelines this run uses. */
    mode: Mode;
    maxRequestsPerCrawl: number;
    maxConcurrency: number;
    maxRequestRetries: number;
    /** Hard cap for a single navigation. Kept well below the handler timeout. */
    navigationTimeoutSecs: number;
    /** Whole-request budget (navigation + the signed pdp.pc.query call). */
    requestHandlerTimeoutSecs: number;
    /** Seller mode only — minimum delay between consecutive store requests. */
    sameDomainDelaySecs: number;
    headless: boolean;
    /** Force RESIDENTIAL everywhere, even for countries the datacenter pool can serve. */
    residentialProxy: boolean;
    /**
     * Countries the Apify DATACENTER pool actually holds IPs in. Anything outside this list has to
     * go through RESIDENTIAL — see {@link proxyGroupsFor}.
     */
    datacenterCountries: string[];

    /**
     * Explicit ship-to override (ISO-3166 alpha-2) applied to every URL, or `null` to auto-detect
     * per URL.
     *
     * This drives BOTH the `aep_usuc_f` region cookie AND the proxy exit country. Splitting them
     * (ES ship-to over a US IP) is what AliExpress punishes hardest: a US datacenter IP asking for
     * Spanish delivery is a contradiction no real buyer produces, and the whole run gets captcha'd.
     */
    shipToCountry: string | null;
    /** Ship-to used when a URL carries no regional signal and no override is set. Fixed to "US". */
    defaultShipToCountry: string;

    /**
     * Check each product on the ship-to country's OWN storefront, exactly as a buyer there does:
     * `site=esp`, `b_locale=es_ES`, `c_tp=EUR` — instead of the global catalogue in USD/English.
     *
     * This is THE availability switch. The global catalogue answers for listings a localized
     * storefront has withdrawn, so with this off a product a Spanish buyer cannot order is reported
     * as existing. With it on, AliExpress says so outright (`bigBossBan`) and the row carries
     * `exists: false` with `errorCode: 'unavailable_in_region'`.
     *
     * Set to `false` to ask the global catalogue for every market — "does this item id exist at
     * all", rather than "can a buyer in this market get it".
     */
    matchStorefrontLocale: boolean;

    sessionPool: {
        /** Small pool keeps residential IPs sticky and reused instead of churning. */
        maxPoolSize: number;
        /** Reuse a healthy session a few times (warm cookies) before it is recycled. */
        maxUsageCount: number;
        /** Retire a session after this many errors. 1 = drop a burned IP immediately. */
        maxErrorScore: number;
    };

    /** Refresh the browser (and thus its fingerprint) after this many pages. */
    retireBrowserAfterPageCount: number;
}

/**
 * Merge Actor input with production defaults into a single immutable config object.
 *
 * Defaults are deliberately conservative for a browser + residential-proxy crawl of a
 * hostile target: low concurrency, generous retries (rotation needs room to find a clean
 * IP), and rotation as the only challenge strategy.
 */
export function buildConfig(input: CheckerInput): CheckerConfig {
    const maxConcurrency = clamp(input.maxConcurrency, 1, 10, 2);
    // Lenient like the rest of this file: an unrecognized/absent mode falls back to the default
    // rather than throwing, so a typo degrades gracefully instead of failing the run at startup.
    const mode: Mode = MODES.includes(input.mode as Mode) ? (input.mode as Mode) : 'product';

    return {
        mode,
        maxRequestsPerCrawl: clamp(input.maxRequestsPerCrawl, 1, 1_000, 100),
        maxConcurrency,
        maxRequestRetries: clamp(input.maxRequestRetries, 0, 20, 10),
        navigationTimeoutSecs: 45,
        // 90s: navigation + the signed pdp.pc.query call (with its token dance) and nothing else —
        // this Actor fetches no description, no reviews and no seller profile.
        requestHandlerTimeoutSecs: 90,
        sameDomainDelaySecs: clamp(input.sameDomainDelaySecs, 0, 60, 0),
        headless: input.headless ?? true,
        residentialProxy: input.residentialProxy ?? false,
        // The account's datacenter groups (SHADER / BUYPROXIES* / StaticUS3) are US-only; asking
        // proxy.apify.com for any other country returns 407 "Selected proxy groups have no usable
        // proxies from country '<XX>'", which surfaces in the browser as ERR_TUNNEL_CONNECTION_FAILED.
        datacenterCountries: ['US'],
        shipToCountry: input.shipToCountry?.trim().toUpperCase() || null,
        defaultShipToCountry: 'US',
        matchStorefrontLocale: input.matchStorefrontLocale ?? true,
        sessionPool: {
            // A touch larger than concurrency so a retired session can be replaced without stalling.
            maxPoolSize: Math.max(maxConcurrency + 2, 4),
            maxUsageCount: 5,
            maxErrorScore: 1,
        },
        retireBrowserAfterPageCount: 5,
    };
}

/**
 * Clamp an optional numeric input into range, falling back to `fallback` when it is absent or not a
 * finite number. Lenient like the rest of this file: a garbage value degrades to the default rather
 * than throwing at startup.
 */
function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(Math.max(Math.round(value), min), max);
}

/**
 * Decide the ship-to country for ONE start URL: an explicit input override wins, otherwise the
 * region the pasted URL carries, otherwise the default.
 *
 * Call this on the RAW url — {@link normalizeAliExpressUrl} strips exactly the signals it reads.
 */
export function resolveShipToCountry(rawUrl: string, config: CheckerConfig): string {
    return config.shipToCountry ?? detectShipToCountry(rawUrl) ?? config.defaultShipToCountry;
}

/**
 * The storefront identity to present for ONE ship-to country under the current config — the single
 * place {@link CheckerConfig.matchStorefrontLocale} is honoured.
 *
 * Off ⇒ the global catalogue for every region. On ⇒ that country's own storefront.
 */
export function storefrontForRequest(shipToCountry: string, config: CheckerConfig): Storefront {
    return config.matchStorefrontLocale ? storefrontFor(shipToCountry) : GLOBAL_STOREFRONT;
}

/**
 * Which Apify proxy groups to request for a given exit country. `[]` means the automatic datacenter
 * pool.
 *
 * Residential is not merely "better" outside the US — it is the only thing that works. The
 * datacenter pool holds US addresses only, so `country-ES` there is refused at the CONNECT stage
 * with 407 and the crawl dies before it ever reaches AliExpress. Datacenter therefore stays for the
 * countries it can actually serve (where it's cheaper), and everything else goes residential.
 */
export function proxyGroupsFor(country: string, config: CheckerConfig): string[] {
    if (config.residentialProxy) {
        return ['RESIDENTIAL'];
    }
    return config.datacenterCountries.includes(country.toUpperCase()) ? [] : ['RESIDENTIAL'];
}
