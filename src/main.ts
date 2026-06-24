// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { setTimeout } from 'node:timers/promises';

import { CheerioCrawler } from '@crawlee/cheerio';
// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';

// this is ESM project, and as such, it requires you to specify extensions in your relative imports
// note that we need to use `.js` even when inside TS files
import { failedRequestHandler, type Mode, normalizeUrl, router } from './routes.js';

interface Input {
    startUrls: { url: string }[];
    mode: Mode;
    maxConcurrency: number;
    sameDomainDelaySecs: number;
    maxRequestRetries: number;
    proxyConfiguration?: {
        useApifyProxy?: boolean;
        apifyProxyGroups?: string[];
        proxyUrls?: string[];
    };
}

await Actor.init();

// Gracefully shut down when the run is aborted, to minimize cost.
Actor.on('aborting', async () => {
    await setTimeout(1000);
    await Actor.exit();
});

// Structure of input is defined in .actor/input_schema.json
const {
    startUrls = [],
    mode = 'product',
    maxConcurrency = 5,
    sameDomainDelaySecs = 0,
    maxRequestRetries = 3,
    proxyConfiguration: proxyInput,
} = (await Actor.getInput<Input>()) ?? ({} as Input);

// Validate input early and fail with a clear message.
if (!Array.isArray(startUrls) || startUrls.length === 0) {
    throw new Error('Input "startUrls" is required and must contain at least one AliExpress product URL.');
}

// AliExpress aggressively blocks datacenter IPs, so the Actor defaults to US residential
// Apify Proxy when no proxy is provided in the input. Pass `{ useApifyProxy: false }` to disable.
const proxyConfiguration = await Actor.createProxyConfiguration(
    proxyInput ?? { groups: ['RESIDENTIAL'], countryCode: 'US' },
);

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency,
    sameDomainDelaySecs,
    maxRequestRetries,
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
            };
        },
    ],
});

log.info(`Checking ${mode} status of ${startUrls.length} AliExpress URL(s)...`);

// Normalize each URL to the canonical global host (avoids the cross-domain cookie issue
// on regional hosts like aliexpress.us) while keeping the original URL for the output.
// A per-index uniqueKey ensures every input row is checked, even when the same URL is
// listed multiple times (Crawlee would otherwise dedupe identical URLs).
const requests = startUrls.map(({ url }, index) => {
    const normalized = normalizeUrl(url, mode);
    return {
        url: normalized,
        uniqueKey: `${index}-${normalized}`,
        userData: { originalUrl: url, mode },
    };
});

await crawler.run(requests);

log.info('Done. See the dataset for per-product availability results.');

// Gracefully exit the Actor process.
await Actor.exit();
