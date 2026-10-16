// safety.mjs — SOURCE SAFETY: domain allowlist (brief §7, non-negotiable)
// -----------------------------------------------------------------------------
// A source link may be published only if it points at a specific page on a
// vetted source. The same rules run in the DrewBrews Content Studio at render
// time (lib/radar/safety.ts); keep the two in step.
//   • Reddit:  a /r/<vetted sub>/comments/<id> thread
//   • YouTube: a single video — watch?v=<id> or youtu.be/<id>. The channel is
//              vetted because the scout only reads videos from the channels in
//              sources.txt (their own feed / API listing).
//   • Articles: a vetted host plus a real path (never a homepage), and on the
//              same site as the feed it came from.
// Anything else is dropped and logged with the reason, never published.
// -----------------------------------------------------------------------------

export const SAFE_HOSTS = ['sprudge.com', 'dailycoffeenews.com', 'perfectdailygrind.com', 'notabarista.org',
  'baristahustle.com', 'sca.coffee', 'scanews.coffee', 'coffeereview.com'];
export const VETTED_SUBS = ['pourover', 'espresso', 'jameshoffmann', 'barista', 'oxorapidbrewer', 'coffee'];

// Platforms have their own rules; they never count as article sites.
const PLATFORM_HOSTS = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'reddit.com', 'redd.it'];

const bareHost = host => host.toLowerCase().replace(/^www\./, '');
const hostIn = (host, list) => list.some(h => host === h || host.endsWith('.' + h));

/** The allowlist for this run: built-ins plus what sources.txt lists (comment lines ignored). */
export function buildAllowlist({ subs = [], rssHosts = [] }) {
  return {
    subs: [...new Set([...VETTED_SUBS, ...subs.map(s => s.toLowerCase())])],
    hosts: [...new Set([...SAFE_HOSTS, ...rssHosts.map(bareHost)])].filter(h => !hostIn(h, PLATFORM_HOSTS)),
  };
}

/** Why a URL is not allowed, or null when it is. */
export function unsafeReason(u, allow) {
  if (typeof u !== 'string' || !u.trim()) return 'no link';
  let url;
  try { url = new URL(u.trim()); } catch { return 'not a valid URL'; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `scheme ${url.protocol} not allowed`;
  if (url.username || url.password) return 'login inside the URL';
  const host = bareHost(url.hostname);
  const seg = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);

  if (hostIn(host, ['reddit.com'])) {
    const m = url.pathname.match(/^\/r\/([a-z0-9_]+)\/comments\/[a-z0-9]+/i);
    if (!m) return 'Reddit link is not a thread (subreddit root or other page)';
    return allow.subs.includes(m[1].toLowerCase()) ? null : `r/${m[1]} is not a vetted subreddit`;
  }
  if (host === 'youtube.com') {
    return url.pathname === '/watch' && /^[\w-]{6,}$/.test(url.searchParams.get('v') ?? '') ? null : 'YouTube link is not a single video (channel or other page)';
  }
  if (host === 'youtu.be') return seg.length === 1 && /^[\w-]{6,}$/.test(seg[0]) ? null : 'youtu.be link has no video id';
  if (hostIn(host, PLATFORM_HOSTS)) return `${host} page is not a thread or video`;
  if (!hostIn(host, allow.hosts)) return `${host} is not on the allowlist`;
  if (!(seg.length >= 1 && seg.join('/').length >= 6)) return 'homepage or too-short path, not an article';
  return null;
}

export const isAllowedSourceUrl = (u, allow) => unsafeReason(u, allow) === null;

/** Collected item → reason it must not reach the radar, or null. Articles must stay on their feed's site. */
export function itemReason(item, allow) {
  const reason = unsafeReason(item?.url, allow);
  if (reason) return reason;
  if (item.kind === 'article' && item.feedHost) {
    const host = bareHost(new URL(item.url).hostname);
    if (!hostIn(host, [bareHost(item.feedHost)])) return `article link leaves its feed's site (${item.feedHost} → ${host})`;
  }
  return null;
}

/** Split items into safe and dropped (with reasons). */
export function gate(items, allow) {
  const safe = [], dropped = [];
  for (const item of items) {
    const reason = itemReason(item, allow);
    if (reason) dropped.push({ reason, source: item?.source ?? '?', title: item?.title ?? item?.name ?? '?', url: item?.url ?? item?.source_url ?? '' });
    else safe.push(item);
  }
  return { safe, dropped };
}
