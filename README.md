# AliExpress Product Status Checker

**Check whether AliExpress products are still live** in bulk. Give the Actor a list of [AliExpress](https://www.aliexpress.com) product URLs and it tells you, for each one, whether the product page is still **available** or has been **removed / disabled**. It works by detecting the `og:title` meta tag, which AliExpress only renders on live product pages.

Run it on the [Apify platform](https://apify.com) to get API access, scheduling, integrations, proxy rotation, and run monitoring out of the box.

## Why use AliExpress Product Status Checker?

- **Catch dead listings** in dropshipping catalogs or affiliate link lists before your customers do.
- **Monitor on a schedule** — run daily/hourly and get alerted when a product disappears.
- **Bulk and fast** — uses lightweight HTTP requests (no headless browser), checking many URLs in parallel.
- **No false positives from blocks** — anti-bot interstitials are detected and retried rather than reported as "unavailable".

## How it works

A live AliExpress product page exposes Open Graph metadata such as:

```html
<meta property="og:title" content="Essager Universal Desktop Mobile Phone Holder ... - AliExpress" />
```

When a product is removed or disabled, that `og:title` tag is gone. The Actor fetches each URL, parses the HTML, and reports the product as **available** only when `og:title` is present.

## How to use

1. Click **Try for free** / open the Actor in Apify Console.
2. Paste your AliExpress product URLs into the **AliExpress product URLs** field.
3. (Recommended) Set **Proxy configuration** to Apify Proxy with **Residential** group — AliExpress blocks datacenter IPs aggressively.
4. Click **Start** and read the results in the **Output** tab or via the API.

## Input

| Field | Type | Description |
| --- | --- | --- |
| `startUrls` | array | **Required.** AliExpress product page URLs to check, e.g. `https://vi.aliexpress.com/item/1005004771213104.html`. |
| `proxyConfiguration` | object | Proxy settings. Residential Apify Proxy strongly recommended. Defaults to no proxy. |
| `maxConcurrency` | integer | Max URLs checked in parallel. Default `10`. |
| `maxRequestRetries` | integer | Retries (with a fresh session) when a URL looks blocked, before recording an error. Default `3`. |

Example input:

```json
{
    "startUrls": [
        { "url": "https://vi.aliexpress.com/item/1005004771213104.html" },
        { "url": "https://www.aliexpress.com/item/1005006000000000.html" }
    ],
    "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] },
    "maxConcurrency": 10
}
```

## Output

The Actor pushes one row per input URL to the dataset. You can download it as JSON, HTML, CSV, or Excel.

```json
{
    "url": "https://vi.aliexpress.com/item/1005004771213104.html",
    "productId": "1005004771213104",
    "available": true,
    "status": "available",
    "title": "Essager Universal Desktop Mobile Phone Holder Stand - AliExpress 202192403",
    "httpStatus": 200,
    "checkedAt": "2026-06-23T10:58:41.936Z"
}
```

### Data fields

| Field | Description |
| --- | --- |
| `url` | The original product URL you provided. |
| `finalUrl` | The URL actually fetched, after normalization and redirects. |
| `productId` | Numeric AliExpress item ID parsed from the URL (or `null`). |
| `available` | `true` if live, `false` if removed/disabled, `null` if it could not be determined. |
| `status` | `available`, `unavailable`, or `error`. |
| `title` | The `og:title` content for live products, otherwise `null`. |
| `httpStatus` | HTTP status code of the response. |
| `error` | Error message when `status` is `error` (e.g. blocked after all retries). |
| `checkedAt` | ISO timestamp of the check. |

## Cost estimation

Each check is a single lightweight HTTP request, so cost is dominated by compute units and (if used) residential proxy traffic. Checking a few hundred URLs typically costs only a fraction of a compute unit. Using residential proxies increases reliability on AliExpress at the cost of proxy data usage.

## Tips

- **Any URL format works** — regional hosts like `aliexpress.us`, `vi.aliexpress.com`, share/affiliate links and long tracking query strings are all accepted. The Actor normalizes each URL to the canonical `www.aliexpress.com/item/<id>.html` before checking, which also avoids a cross-domain cookie issue that breaks `aliexpress.us` requests.
- **Use residential proxies** for anything beyond a handful of URLs — AliExpress serves a captcha/"slide to verify" page to suspicious IPs. The Actor detects these and retries, but residential IPs avoid them in the first place.
- **Schedule it** to monitor your catalog and combine with integrations (Slack, webhooks, Google Sheets) to get notified when products go offline.
- Lower `maxConcurrency` if you see many `error` rows due to blocking.

## FAQ, disclaimers, and support

- **Is scraping AliExpress legal?** This Actor only reads publicly available product pages and does not collect personal data. You are responsible for complying with AliExpress's Terms of Service and applicable laws.
- **A product shows `error` — what now?** It was likely blocked after all retries. Enable/upgrade proxy configuration and re-run.
- **Found a bug or need a custom version?** Open an issue on the Actor's **Issues** tab.
