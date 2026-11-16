// feed/writePolicy — WHO MAY WRITE WHAT, as code instead of tribal knowledge.
//
// THE PROBLEM THIS SOLVES. The app has exactly ONE feed table (`properties`);
// price, address, landmarks, geo and the place-card identity are all columns on
// it. So "single writer per table" cannot be expressed as table ownership — it
// has to be stated per WRITE SURFACE (the columns one operation touches, and the
// edge function that carries it). Without that statement, every box that can
// reach the function can rewrite any of them, and the two failures below are
// indistinguishable from success:
//
//   • an atom re-ranking its own rosters from its own map copy. Two hosts now
//     hold a map; they do not hold the SAME map. Whoever writes the roster last
//     wins, silently, and the client is served landmarks measured from a map
//     the master never approved.
//   • a center or a place-card identity written by a renderer, overwriting the
//     one the map pass measured and audited.
//
// THE RULE. Every surface has exactly one owning role. The MASTER (the box that
// owns the authoritative map: it can EDIT that file) owns everything derived
// from the map — centers, rosters, place-card identity. An ATOM owns exactly the
// facts only it can know, because they came out of a conversation with the
// owner: the price and the address. Everyone else reads.
//
// WHY THE ROLE IS DERIVED AND NOT CONFIGURED. A permission that must be
// remembered is a permission that will be forgotten on a re-imaged box. The
// evidence is the artifact itself: the master is the host whose map file the
// process can WRITE. `deploy_map.sh` ships the atom's copy read-only, so an atom
// cannot pass this check even with the tooling installed — and a master whose
// map was accidentally made read-only fails CLOSED (refuses to write rosters,
// with a message saying how to fix it) instead of quietly becoming a satellite.
// `LINA_ROLE` stays as the explicit operator override for the odd box.

import * as fs from 'fs';

/** The two roles a LINA box can have. */
export type HostRole = 'master' | 'atom';

/** One operation that writes the live feed, and the only role that may run it. */
export interface FeedWriteSurface {
  /** Stable id used in code and in refusals. */
  id: string;
  /** The `properties` columns (or side tables) this operation touches. */
  columns: string;
  /** The edge function / REST path that carries the write (for the operator). */
  via: string;
  /** The ONE role allowed to perform it. */
  owner: HostRole;
  /** Why that role owns it — one line, printed in refusals. */
  why: string;
}

/**
 * THE MAP. Adding a surface is the only way to write the feed; a surface with
 * no entry here is not writable by any tool in this repo (see `assertFeedWrite`
 * — an unknown id throws, it never defaults to allowed).
 */
export const FEED_WRITE_SURFACES: readonly FeedWriteSurface[] = [
  {
    id: 'geo:center',
    columns: 'properties.lat, lon, geo_source, geocoded_at, neighborhood',
    via: 'map pass R2 (repair) · scripts/backfill-geo.ts',
    owner: 'master',
    why: 'the center is measured against the authoritative map; a host with a copy would measure it against a different map',
  },
  {
    id: 'landmarks:roster',
    columns: 'properties.landmarks, landmark_policy_version',
    via: 'update-property-landmarks · hermes:landmarks:feed',
    owner: 'master',
    why: 'the roster is the map ranked; only the box that authored the map may rank it',
  },
  {
    id: 'place:card',
    columns: 'properties.place_id, place_url',
    via: 'map pass R4 · scripts/capture-place-urls.ts',
    owner: 'master',
    why: 'the place card is a Google identity resolved on the authored map, not re-guessed per host',
  },
  {
    id: 'price:public',
    columns: 'properties.price',
    via: 'update-property-price · hermes-price.sh (owner sync)',
    owner: 'atom',
    why: 'the price is an owner-dictated fact; only the atom that asked the owner has it',
  },
  {
    id: 'address:owner',
    columns: 'properties.address',
    via: 'update-property-address · hermes-price.sh (owner sync)',
    owner: 'atom',
    why: 'the owner owns the building; the correction exists only in the atom\'s conversation',
  },
  {
    id: 'status:listing',
    columns: 'properties.status, published',
    via: 'update-property-status',
    owner: 'master',
    why: 'publication is an agency decision made once, not per satellite',
  },
] as const;

const BY_ID = new Map(FEED_WRITE_SURFACES.map(s => [s.id, s]));

/** The surface record, or undefined when the id is not in the map. */
export function feedWriteSurface(id: string): FeedWriteSurface | undefined {
  return BY_ID.get(id);
}

/** Thrown when a role may not perform a write. Carries the operator-facing text. */
export class FeedWriteRefused extends Error {
  constructor(
    readonly surface: string,
    readonly role: HostRole,
    readonly owner: HostRole,
    message: string,
  ) {
    super(message);
    this.name = 'FeedWriteRefused';
  }
}

/**
 * Why `role` may not perform `surface`, or undefined when it may.
 *
 * An UNKNOWN surface is a programming error, not a permission question: a typo
 * (`landmarks:rosters`) must never read as "allowed".
 */
export function writeRefusal(surface: string, role: HostRole): string | undefined {
  const s = BY_ID.get(surface);
  if (!s) {
    throw new Error(
      `feed-write: "${surface}" is not a declared write surface — add it to FEED_WRITE_SURFACES in src/feed/writePolicy.ts before writing it.`,
    );
  }
  if (s.owner === role) return undefined;
  return [
    `feed-write: REFUSED — ${s.id} is owned by the ${s.owner}, this host is an ${role}.`,
    `  columns : ${s.columns}`,
    `  via     : ${s.via}`,
    `  why     : ${s.why}`,
    role === 'atom'
      ? '  An atom is a READER for everything derived from the map. Roster/center/place-card\n  repairs belong to the master (the box whose map file is writable): run them there.'
      : '  The master does not write owner-dictated facts — they exist only in the atom\'s\n  conversation and arrive through hermes-price.sh.',
  ].join('\n');
}

/** Throws `FeedWriteRefused` unless `role` owns `surface`. */
export function assertFeedWrite(surface: string, role: HostRole): void {
  const refusal = writeRefusal(surface, role);
  if (refusal) {
    const s = BY_ID.get(surface)!;
    throw new FeedWriteRefused(surface, role, s.owner, refusal);
  }
}

/** The role named in the environment, if any (trimmed, lowercased). */
export function declaredRole(env: NodeJS.ProcessEnv = process.env): HostRole | undefined {
  const raw = (env.LINA_ROLE ?? '').trim().toLowerCase();
  if (raw === '') return undefined;
  if (raw === 'master' || raw === 'atom') return raw;
  throw new Error(`LINA_ROLE="${env.LINA_ROLE}" is not a role — use "master" or "atom" (or unset it to derive the role from the map).`);
}

/**
 * What this host can do to the map file: the ONE piece of evidence the role
 * rests on. Three answers, not a boolean, so the refusal can say which of
 * "not the master" it is — a missing map and a shipped read-only copy are
 * different operator problems (one is a broken install, the other is correct).
 */
export type MapAuthority = 'writable' | 'readonly' | 'missing';
export type AuthorityProbe = (file: string) => MapAuthority;

export const defaultAuthorityProbe: AuthorityProbe = file => {
  try {
    if (!fs.statSync(file).isFile()) return 'missing';
  } catch {
    return 'missing';
  }
  try {
    fs.accessSync(file, fs.constants.W_OK);
    return 'writable';
  } catch {
    return 'readonly';
  }
};

/**
 * THE ROLE OF THIS HOST.
 *
 *   LINA_ROLE set                        → that (an explicit operator override)
 *   else the map file is writable        → master (it owns the authority)
 *   else (read-only, or no map at all)   → atom (fail closed)
 *
 * A missing map is an atom on purpose: the box has no authority to write rosters
 * from, so it must not pretend otherwise.
 */
export function resolveHostRole(opts: {
  env?: NodeJS.ProcessEnv;
  mapPath?: string | undefined;
  probe?: AuthorityProbe;
} = {}): { role: HostRole; why: string } {
  const declared = declaredRole(opts.env);
  if (declared) return { role: declared, why: 'LINA_ROLE is set explicitly' };
  if (!opts.mapPath) return { role: 'atom', why: 'no authoritative map resolved — nothing to author from' };
  const probe = opts.probe ?? defaultAuthorityProbe;
  const authority = probe(opts.mapPath);
  if (authority === 'writable') return { role: 'master', why: `map is writable: ${opts.mapPath}` };
  if (authority === 'readonly') return { role: 'atom', why: `map is read-only: ${opts.mapPath}` };
  return { role: 'atom', why: `map missing at ${opts.mapPath}` };
}

/** The map as a printable table (docs + `cron:check --role` output). */
export function describeWriters(): string {
  const rows = FEED_WRITE_SURFACES.map(s => `  ${s.id.padEnd(17)} ${s.owner.padEnd(7)} ${s.columns}`);
  return ['  surface           owner   columns', ...rows].join('\n');
}
