# PublicWWW API - JavaScript

A small client for the [PublicWWW API](https://publicwww.com/docs/api/): search the
source code (HTML, JavaScript, CSS) of hundreds of millions of websites from your
own code. One ES module, no dependencies, Node 18+ (it uses the built-in `fetch`).

## Setup

Issue a token on your [profile page](https://publicwww.com/profile/api) (a paid
plan is required for the API) and keep it in the environment, not in the code:

```sh
export PUBLICWWW_KEY=...
```

## Command line

```sh
node publicwww.mjs account                          # plan and quota, spends nothing
node publicwww.mjs search '"angular.min.js"' 20     # one page
node publicwww.mjs export '"angular.min.js"' > sites.txt   # every url your plan covers
```

## As a module

```js
import { Client, PublicWWWError } from "./publicwww.mjs";

const pw = new Client ();                          // key from $PUBLICWWW_KEY

const page = await pw.search ('"angular.min.js"', { perPage: 20 });
console.log (page.total, "sites match");
for (const r of page.results) console.log (r.rank, r.domain, r.url);   // rank is null for unranked sites

// Everything at once, streamed as NDJSON: one search, nothing held in memory.
const meta = {};
for await (const r of pw.iterAll ('"angular.min.js" site:de', { meta })) console.log (r.domain);
if (meta.truncated) console.log (`the plan returned ${meta.returned} of ${meta.total}`);
```

The query is the usual [PublicWWW syntax](https://publicwww.com/docs/query-syntax/):
`"exact phrase"`, several words for all of them, `-word` to exclude, `site:de`,
`depth:all` for inner pages.

## Clusters

A cluster is a saved list of sites - the results of a search or your own list - to
pull values out of their page source or to combine with other clusters. See
[clusters in the API](https://publicwww.com/docs/api/clusters/).

```sh
node publicwww.mjs cluster-create --query '"googletagmanager.com/gtm.js"'   # prints id, size, created, name
node publicwww.mjs extract 12 --presets email,phone > contacts.csv          # the whole cluster, part after part
node publicwww.mjs extract 12 --regex '/data-site-id="([0-9]+)"/i' > ids.csv
node publicwww.mjs cluster-combine diff 14 12 --name "new this month"       # also: and, or
node publicwww.mjs clusters      # and: cluster ID, presets, cluster-rename ID NAME, cluster-delete ID
```

```js
const gtm = await pw.createCluster ({ query: '"googletagmanager.com/gtm.js"' });   // costs one search
const mine = await pw.createCluster ({ domains: ["example.com", "https://example.org/"], name: "mine" });

// Every site, in parts of up to 1000 (following next_offset); spends extraction points.
for await (const row of pw.iterExtract (gtm.id, { presets: ["email", "phone"] })) {
  const [emails, phones] = row.values;               // one array per expression
  console.log (row.domain, emails, phones);
}

const hotjar = await pw.createCluster ({ query: '"static.hotjar.com"' });
const both = await pw.combineClusters ("and", [gtm.id, hotjar.id]);   // "or"; "diff" - the first without the second
for await (const domain of pw.iterCluster (both.id)) console.log (domain);
await pw.deleteCluster (hotjar.id);
```

`clusterPresets ()` lists the ready-made expressions: email, phone, whatsapp,
telegram, skype, facebook, instagram, twitter, linkedin, gtm, ga4, ua, hotjar,
adsense, bitcoin. Your own `regex` is a PCRE in slashes; the first group is the
value. `extract ()` is one part, `next_offset` says where the next one starts. An
account keeps up to 100 clusters (`409 cluster_limit` past that). If the day's
extraction points run out midway, `iterExtract` throws `extract_quota_exceeded`
with the offset to resume from (`extract ... --offset N`).

## Errors

Any refusal throws `PublicWWWError` with `.status` and `.code`, except one: `429 too_many_requests` (more than ten
requests a minute) is waited out using `Retry-After` and the request is repeated.
`429 quota_exceeded` is different - the day's searches are used up, retrying will
not help. All codes: [errors](https://publicwww.com/docs/api/errors/).

`PUBLICWWW_API` overrides the API address if you ever need to.

## See also

- [API documentation](https://publicwww.com/docs/api/)
- [MCP server](https://publicwww.com/docs/mcp/) - the same search for AI assistants:
  `https://api.publicwww.com/mcp`
- The same client in [Python](https://github.com/publicwww-com/publicwww-api-python), [PHP](https://github.com/publicwww-com/publicwww-api-php), [Go](https://github.com/publicwww-com/publicwww-api-go), [Ruby](https://github.com/publicwww-com/publicwww-api-ruby)

## License

MIT
