// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { setTimeout } from 'node:timers/promises';

import { CheerioCrawler } from '@crawlee/cheerio';
// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';

// this is ESM project, and as such, it requires you to specify extensions in your relative imports
// note that we need to use `.js` even when inside TS files
import { currentActorRunId } from './actorRun.js';
import { DEFAULT_SHIP_TO_COUNTRY, localeCookie, resolveShipToCountry } from './country.js';
import { failedRequestHandler, type Mode, normalizeUrl, router } from './routes.js';

interface Input {
    startUrls: { url: string }[];
    mode: Mode;
    verifyShipTo: boolean;
    maxConcurrency: number;
    sameDomainDelaySecs: number;
    maxRequestRetries: number;
}

await Actor.init();

// Stamped on every output row too, so a dataset can always be traced back to the run that filled it.
log.info(`Actor run ID: ${currentActorRunId() ?? '(none — running locally)'}`);

// Gracefully shut down when the run is aborted, to minimize cost.
Actor.on('aborting', async () => {
    await setTimeout(1000);
    await Actor.exit();
});

// Structure of input is defined in .actor/input_schema.json
const {
    startUrls = [],
    mode = 'product',
    verifyShipTo = true,
    maxConcurrency = 5,
    sameDomainDelaySecs = 0,
    maxRequestRetries = 3,
} = (await Actor.getInput<Input>()) ?? ({} as Input);

// Validate input early and fail with a clear message.
if (!Array.isArray(startUrls) || startUrls.length === 0) {
    throw new Error('Input "startUrls" is required and must contain at least one AliExpress product URL.');
}

// Resolve the market for each start URL BEFORE normalizing it — normalization drops the query
// string the `gatewayAdapt` signal lives in. Seller mode has nothing to localize (a store exists or
// it doesn't, identically in every market), so it stays on the default.
//
// A per-index uniqueKey ensures every input row is checked, even when the same URL is listed
// multiple times (Crawlee would otherwise dedupe identical URLs) — and it also lets one run check
// the same item under two different markets.
const requests = startUrls.map(({ url }, index) => {
    const country = mode === 'product' ? resolveShipToCountry(url) : DEFAULT_SHIP_TO_COUNTRY;
    const normalized = normalizeUrl(url, mode, country);
    return {
        url: normalized,
        uniqueKey: `${index}-${country}-${normalized}`,
        userData: { originalUrl: url, mode, country, verifyShipTo },
    };
});

// --- Proxy: exit in the country whose storefront we ask ------------------------------------------
//
// AliExpress gates availability on the market, so the storefront host, the proxy exit IP and the
// `aep_usuc_f` region cookie must all name ONE country. A Spanish storefront fetched over a US IP
// is a contradiction no real buyer produces — AliExpress answers it with captchas, and the answer
// it does give is about the wrong market anyway.
//
// Mechanically: `newUrlFunction` is called per request with that request in hand (Crawlee calls
// `newProxyInfo(sessionId, { request })` for every page), so each request leaves through its own
// country. `newUrlFunction` cannot be combined with `countryCode`, hence the delegation to a real
// per-country ProxyConfiguration — which also handles the proxy-password bootstrap. Residential
// everywhere: AliExpress blocks datacenter IPs aggressively, and the datacenter pool is US-only.
const proxyByCountry = new Map<string, Awaited<ReturnType<typeof Actor.createProxyConfiguration>>>();
async function proxyForCountry(country: string) {
    if (!proxyByCountry.has(country)) {
        proxyByCountry.set(country, await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: country }));
        log.info(`Proxy country added: ${country}`, { groups: ['RESIDENTIAL'] });
    }
    return proxyByCountry.get(country);
}

const proxyConfiguration = await Actor.createProxyConfiguration({
    newUrlFunction: async (sessionId, options) => {
        const country = (options?.request?.userData?.country as string | undefined) ?? DEFAULT_SHIP_TO_COUNTRY;
        const perCountry = await proxyForCountry(country);
        // Suffix the session id with the country so one Crawlee session can never be handed the
        // same sticky IP for two different markets.
        return (await perCountry?.newUrl(sessionId ? `${sessionId}_${country}` : undefined)) ?? null;
    },
});

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency,
    sameDomainDelaySecs,
    maxRequestRetries,
    requestHandler: router,
    failedRequestHandler,
    // Look like a normal browser so AliExpress is less likely to serve the anti-bot page, and
    // declare the same market in the locale cookie that the host and the proxy already name.
    preNavigationHooks: [
        async ({ request }) => {
            const country = (request.userData?.country as string | undefined) ?? DEFAULT_SHIP_TO_COUNTRY;
            request.headers = {
                ...request.headers,
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                Cookie: localeCookie(country),
            };
        },
    ],
});

log.info(`Checking ${mode} status of ${startUrls.length} AliExpress URL(s)...`);
if (mode === 'product') {
    log.info('Resolved market per URL.', Object.fromEntries(requests.map((r) => [r.url, r.userData.country])));
}

await crawler.run(requests);

log.info('Done. See the dataset for per-product availability results.');

// Gracefully exit the Actor process.
await Actor.exit();
