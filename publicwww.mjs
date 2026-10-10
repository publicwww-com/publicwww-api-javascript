#!/usr/bin/env node
// A small client for the PublicWWW API - https://publicwww.com/docs/api/
// Node 18+, no dependencies.
//
//   import { Client } from "./publicwww.mjs";
//   const pw = new Client ();                 // key from $PUBLICWWW_KEY
//   const page = await pw.search ('"angular.min.js"', { perPage: 20 });
//   for await (const row of pw.iterAll ('"angular.min.js"')) console.log (row.domain);
//
//   const c = await pw.createCluster ({ query: '"googletagmanager.com/gtm.js"' });
//   for await (const row of pw.iterExtract (c.id, { presets: ["email", "phone"] })) console.log (row.domain, row.values);
//
//   node publicwww.mjs account
//   node publicwww.mjs search '"angular.min.js"' 20
//   node publicwww.mjs export '"angular.min.js"' > sites.txt
//   node publicwww.mjs cluster-create --query '"googletagmanager.com/gtm.js"'
//   node publicwww.mjs extract 12 --presets email,phone > contacts.csv

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API = process.env.PUBLICWWW_API || "https://api.publicwww.com";
const USER_AGENT = "publicwww-api-javascript/1.1";

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

  // GET a path, or POST body as JSON when it is given. Waits out the rate
  // limit; any other error is thrown.
  async #get (path, params = {}, body) {
    const url = new URL (this.api + path);
    for (const [k, v] of Object.entries (params)) url.searchParams.set (k, v);
    const headers = { Authorization: `Bearer ${this.key}`, "User-Agent": USER_AGENT };
    const init = body === undefined ? { headers }
      : { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify (body) };

    for (;;) {
      const res = await fetch (url, init);
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

  async #json (path, params, body) {
    return (await this.#get (path, params, body)).json ();
  }

  // Plan, quota and limits, clusters included. Spends nothing.
  async account () {
    return this.#json ("/v1/account");
  }

  // One page of results: { total, total_pages, truncated, results, ... }
  async search (query, { page = 1, perPage = 100, ...params } = {}) {
    return this.#json ("/v1/search", { ...params, query, page, per_page: perPage });
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

  // ---- clusters: saved lists of sites, to extract data from or combine ----

  // The account's clusters, newest first: { count, max, clusters: [{ id, name, size, created }] }
  async clusters () {
    return this.#json ("/v1/clusters");
  }

  // One cluster and a page of its domains (perPage up to 10000).
  async cluster (id, { page = 1, perPage = 1000 } = {}) {
    return this.#json (`/v1/clusters/${Number (id)}`, { page, per_page: perPage });
  }

  // Every domain of a cluster, page after page.
  async * iterCluster (id, { perPage = 10000 } = {}) {
    for (let page = 1; ; page ++) {
      const res = await this.cluster (id, { page, perPage });
      yield * res.domains;
      if (page >= res.total_pages) return;
    }
  }

  // A new cluster from a search ({ query }, costs one search like search())
  // or from a list of domains or urls ({ domains }; only sites in the index
  // are kept). 409 cluster_limit when the account has 100.
  async createCluster ({ query, domains, name } = {}) {
    const body = query !== undefined ? { query } : { domains: [...(domains || [])] };
    if (name) body.name = name;
    return this.#json ("/v1/clusters", {}, body);
  }

  // A new cluster: "and" - domains in every cluster, "or" - in any, "diff" -
  // in the first but not in the second (exactly two).
  async combineClusters (operation, ids, { name } = {}) {
    const body = { operation, clusters: ids.map (Number) };
    if (name) body.name = name;
    return this.#json ("/v1/clusters/combine", {}, body);
  }

  // Ready-made extraction expressions: { presets: [{ name, regex, about }] }
  async clusterPresets () {
    return this.#json ("/v1/clusters/presets");
  }

  // One part of an extraction: domains [offset, offset + limit) of the cluster
  // (limit up to 1000). presets are names ("email", "phone", ...), regex your
  // own PCRE in slashes, the first group is the value. The answer has rows
  // ({ domain, values - one array per expression, matches }) and next_offset,
  // null when the cluster is done. Costs extraction points.
  async extract (id, { presets = [], regex = [], offset = 0, limit = 1000, skipEmpty = true } = {}) {
    return this.#json (`/v1/clusters/${Number (id)}/extract`, {},
                       { presets, regex, offset, limit, skip_empty: skipEmpty });
  }

  // Every row of an extraction over the whole cluster from offset on, part
  // after part (following next_offset). Pass an object as meta to receive the
  // last part's numbers (regex, points_left, ...). If the day's extraction
  // points run out midway, throws PublicWWWError extract_quota_exceeded; its
  // message says the offset to resume from.
  async * iterExtract (id, { meta, offset = 0, ...opts } = {}) {
    while (offset !== null) {
      const { rows, ...part } = await this.extract (id, { ...opts, offset });
      yield * rows;
      if (meta) Object.assign (meta, part);
      if (part.stopped === "extract_quota_exceeded")
        throw new PublicWWWError (429, "extract_quota_exceeded",
                                  `the day's extraction points ran out; resume with offset=${part.next_offset}`);
      offset = part.next_offset;
    }
  }

  async renameCluster (id, name) {
    return this.#json (`/v1/clusters/${Number (id)}/rename`, {}, { name });
  }

  // Deletes the cluster for good: { deleted: id, name }
  async deleteCluster (id) {
    return this.#json (`/v1/clusters/${Number (id)}/delete`, {}, {});
  }
}

// ---- command line ------------------------------------------------------------

const USAGE = `usage: publicwww.mjs account | search QUERY [PER_PAGE] | export QUERY
       | clusters | cluster ID | cluster-create (--query Q | --domains-file F) [--name N]
       | cluster-combine and|or|diff ID ID... [--name N] | presets
       | extract ID [--presets a,b] [--regex R]... [--offset N] | cluster-rename ID NAME | cluster-delete ID`;

// Positional arguments and --options; --regex may repeat.
function parseArgs (args) {
  const pos = [], opt = { regex: [] };
  for (let i = 0; i < args.length; i ++) {
    const m = /^--([a-z-]+)$/.exec (args[i]);
    if (!m) { pos.push (args[i]); continue; }
    const v = args[++ i] ?? "";
    if (m[1] === "regex") opt.regex.push (v); else opt[m[1]] = v;
  }
  return { pos, opt };
}

const clusterLine = c => [c.id, c.size, c.created, c.name].join ("\t");
const csvCell = s => /[",\r\n]/.test (s) ? `"${s.replace (/"/g, '""')}"` : s;

async function main ([cmd, ...rest]) {
  const { pos, opt } = parseArgs (rest);
  const [query, perPage] = rest;
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
  } else if (cmd === "clusters") {
    const res = await pw.clusters ();
    console.log (`${res.count} clusters of at most ${res.max}`);
    for (const c of res.clusters) console.log (clusterLine (c));
  } else if (cmd === "cluster" && pos[0]) {
    for await (const d of pw.iterCluster (pos[0])) process.stdout.write (d + "\n");
  } else if (cmd === "cluster-create" && (opt.query || opt["domains-file"])) {
    const domains = opt.query ? undefined
      : readFileSync (opt["domains-file"] === "-" ? 0 : opt["domains-file"], "utf8").split (/\r?\n/).map (s => s.trim ()).filter (Boolean);
    console.log (clusterLine (await pw.createCluster ({ query: opt.query, domains, name: opt.name })));
  } else if (cmd === "cluster-combine" && pos.length >= 3) {
    console.log (clusterLine (await pw.combineClusters (pos[0], pos.slice (1), { name: opt.name })));
  } else if (cmd === "presets") {
    for (const p of (await pw.clusterPresets ()).presets) console.log (`${p.name}\t${p.about}`);
  } else if (cmd === "extract" && pos[0]) {
    const presets = (opt.presets || "").split (",").map (s => s.trim ()).filter (Boolean);
    const meta = {};
    let n = 0;
    const offset = Number (opt.offset) || 0;
    if (!offset) process.stdout.write (["domain", ...presets, ...opt.regex].map (csvCell).join (",") + "\n");
    for await (const r of pw.iterExtract (pos[0], { presets, regex: opt.regex, offset, meta })) {
      process.stdout.write ([r.domain, ...r.values.map (v => v.join ("\n"))].map (csvCell).join (",") + "\n");
      n ++;
    }
    console.error (`${n} sites with matches, ${meta.points_left} extraction points left`);
  } else if (cmd === "cluster-rename" && pos.length >= 2) {
    console.log (clusterLine (await pw.renameCluster (pos[0], pos[1])));
  } else if (cmd === "cluster-delete" && pos[0]) {
    const res = await pw.deleteCluster (pos[0]);
    console.log (`deleted ${res.deleted}\t${res.name}`);
  } else {
    console.error (USAGE);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL (process.argv[1]).href) {
  process.stdout.on ("error", err => { if (err.code === "EPIPE") process.exit (0); throw err; });   // | head
  main (process.argv.slice (2)).catch (err => { console.error (err.message); process.exitCode = 1; });
}
