#!/usr/bin/env node
// A small client for the PublicWWW API - https://publicwww.com/docs/api/
// Node 18+, no dependencies.
//
//   import { Client } from "./publicwww.mjs";
//   const pw = new Client ();                 // key from $PUBLICWWW_KEY
//   const page = await pw.search ('"angular.min.js"', { perPage: 20 });
//   for await (const row of pw.iterAll ('"angular.min.js"')) console.log (row.domain);
//
//   node publicwww.mjs account
//   node publicwww.mjs search '"angular.min.js"' 20
//   node publicwww.mjs export '"angular.min.js"' > sites.txt

import { pathToFileURL } from "node:url";

const API = process.env.PUBLICWWW_API || "https://api.publicwww.com";
const USER_AGENT = "publicwww-api-javascript/1.0";

export class PublicWWWError extends Error {
  constructor (status, code, message) {
    super (`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

export class Client {
  constructor ({ key = process.env.PUBLICWWW_KEY, api = API } = {}) {
    if (!key) throw new PublicWWWError (0, "missing_key", "set PUBLICWWW_KEY or pass { key }");
    this.key = key;
    this.api = api.replace (/\/$/, "");
  }

  // GET a path. Waits out the rate limit; any other error is thrown.
  async #get (path, params = {}) {
    const url = new URL (this.api + path);
    for (const [k, v] of Object.entries (params)) url.searchParams.set (k, v);

    for (;;) {
      const res = await fetch (url, {
        headers: { Authorization: `Bearer ${this.key}`, "User-Agent": USER_AGENT },
      });
      if (res.ok) return res;

      let err = {};
      try { err = (await res.json ()).error || {}; } catch {}
      // Two different 429s: too_many_requests means "slow down and repeat",
      // quota_exceeded means "come back tomorrow".
      if (res.status === 429 && err.code === "too_many_requests") {
        const wait = Number (res.headers.get ("Retry-After") || err.retry_after || 10);
        await new Promise (r => setTimeout (r, wait * 1000));
        continue;
      }
      throw new PublicWWWError (res.status, err.code || "http_error", err.message || res.statusText);
    }
  }

  // Plan, quota and limits. Spends nothing.
  async account () {
    return (await this.#get ("/v1/account")).json ();
  }

  // One page of results: { total, total_pages, truncated, results, ... }
  async search (query, { page = 1, perPage = 100, ...params } = {}) {
    return (await this.#get ("/v1/search", { ...params, query, page, per_page: perPage })).json ();
  }

  // Every row of a query your plan covers, streamed as NDJSON: one search,
  // nothing held in memory. perPage defaults to the plan's max_per_page
  // (asking for more is a 400 per_page_too_large). Pass an object as meta to
  // receive the metadata line (total, returned, truncated).
  async * iterAll (query, { perPage, meta, ...params } = {}) {
    if (!perPage) perPage = (await this.account ()).limits.max_per_page;
    const res = await this.#get ("/v1/search", { ...params, query, per_page: perPage, format: "ndjson" });

    const decoder = new TextDecoder ();
    let buf = "";
    const lines = function * (final) {
      let i;
      while ((i = buf.indexOf ("\n")) >= 0 || (final && buf.length)) {
        const line = i >= 0 ? buf.slice (0, i) : buf;
        buf = i >= 0 ? buf.slice (i + 1) : "";
        if (line.trim ()) yield JSON.parse (line);
      }
    };
    const rows = function * (objs) {
      for (const obj of objs) {
        if (obj.object === "meta") { if (meta) Object.assign (meta, obj); continue; }   // the first line
        yield obj;
      }
    };
    for await (const chunk of res.body) {
      buf += decoder.decode (chunk, { stream: true });
      yield * rows (lines (false));
    }
    buf += decoder.decode ();
    yield * rows (lines (true));
  }
}

// ---- command line ------------------------------------------------------------

async function main ([cmd, query, perPage]) {
  const pw = new Client ();
  if (cmd === "account") {
    console.log (JSON.stringify (await pw.account (), null, 2));
  } else if (cmd === "search" && query) {
    const page = await pw.search (query, { perPage: Number (perPage) || 20 });
    console.log (`${page.total} sites match, page ${page.page} of ${page.total_pages}` +
                 (page.truncated ? " (cut short by the plan)" : ""));
    for (const r of page.results) console.log ([r.rank ?? "", r.domain, r.url].join ("\t"));
  } else if (cmd === "export" && query) {
    const meta = {};
    for await (const r of pw.iterAll (query, { meta })) process.stdout.write (r.url + "\n");
    if (meta.truncated) console.error (`note: the plan returned ${meta.returned} of ${meta.total}`);
  } else {
    console.error ("usage: publicwww.mjs account | search QUERY [PER_PAGE] | export QUERY");
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL (process.argv[1]).href) {
  main (process.argv.slice (2)).catch (err => { console.error (err.message); process.exitCode = 1; });
}
