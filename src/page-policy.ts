const YOUTUBE_PLAYER = '#movie_player.html5-video-player, .html5-video-player';
const YOUTUBE_LIVE_PLAYER = '#movie_player.ytp-live, .html5-video-player.ytp-live, ytd-watch-flexy[is-live]';
const YOUTUBE_LIVE_BADGE = '#movie_player .ytp-live-badge, .html5-video-player .ytp-live-badge';
type YoutubePageEvent = CustomEvent<{
  endpoint?: { watchEndpoint?: { videoId?: unknown } };
  response?: { playerResponse?: { videoDetails?: { videoId?: unknown; isLive?: unknown } } };
}>;
let youtubeVideo: { videoId: string; live: boolean | null } | null = null;
const TWITCH_ROUTES = new Set([
  'activate', 'collections', 'directory', 'downloads', 'drops', 'friends',
  'inventory', 'jobs', 'login', 'messages', 'moderator', 'p', 'payments',
  'prime', 'products', 'search', 'settings', 'signup', 'store',
  'subscriptions', 'team', 'teams', 'turbo', 'videos', 'wallet'
]);

function isYoutube(host: string): boolean {
  return host === 'youtube.com' || host.endsWith('.youtube.com')
    || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com');
}

function youtubeVideoId(url = new URL(location.href)): string | undefined {
  return url.searchParams.get('v') ?? /^\/(?:live|embed)\/([^/]+)/.exec(url.pathname)?.[1];
}

export function isLivePage(): boolean {
  const url = new URL(location.href);
  const host = url.hostname.toLowerCase();
  if (host === 'live.bilibili.com') return true;
  if (host === 'player.twitch.tv') {
    return url.searchParams.has('channel') && !url.searchParams.has('video');
  }
  if (host === 'twitch.tv' || host === 'www.twitch.tv' || host === 'm.twitch.tv') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'popout' || parts[0] === 'embed') return !!parts[1];
    return parts.length === 1 && !TWITCH_ROUTES.has(parts[0]);
  }
  if (!isYoutube(host)) return false;
  const videoId = youtubeVideoId(url);
  // Navigation identifies the programme even when a preroll hides LIVE.
  // Keep processing off while the next video's response is still pending.
  if (videoId && youtubeVideo?.videoId === videoId) return youtubeVideo.live ?? true;
  if (document.querySelector(YOUTUBE_LIVE_PLAYER)) return true;
  // DVR streams expose a visible LIVE button without the ytp-live class.
  // Recorded videos retain the same button, hidden by the player's CSS.
  if ([...document.querySelectorAll(YOUTUBE_LIVE_BADGE)]
    .some(badge => badge.getClientRects().length > 0)) return true;
  if (videoId) {
    for (const metadata of document.querySelectorAll('meta[itemprop="isLiveBroadcast"][content="True"]')) {
      const publication = metadata.closest('[itemprop="publication"]');
      const describedUrl = publication?.closest('[itemtype$="/VideoObject"]')?.getAttribute('itemid');
      if (!describedUrl || publication?.querySelector('meta[itemprop="endDate"]')) continue;
      try {
        if (new URL(describedUrl, location.href).searchParams.get('v') === videoId) return true;
      } catch { /* Ignore malformed page metadata. */ }
    }
  }
  if (url.pathname === '/embed/live_stream' || /\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/live\/?$/.test(url.pathname)) return true;
  // /live links also address archived streams. A loaded non-live player
  // identifies a recording; before the player arrives keep live links off.
  return /^\/live\/[^/]+/.test(url.pathname) && !document.querySelector(YOUTUBE_PLAYER);
}

export function pageIdentity(): string {
  const url = new URL(location.href);
  return `${url.hostname}${url.pathname}|${url.searchParams.get('v') ?? ''}|${url.searchParams.get('channel') ?? ''}|${url.searchParams.get('video') ?? ''}`;
}

export function observePagePolicy(scan: () => void): void {
  window.addEventListener('popstate', scan);
  window.addEventListener('hashchange', scan);
  if (!isYoutube(location.hostname)) return;
  const onNavigation = (event: Event) => {
    const detail = (event as YoutubePageEvent).detail;
    const pending = event.type === 'yt-navigate-start';
    const details = detail?.response?.playerResponse?.videoDetails;
    const videoId = pending ? detail?.endpoint?.watchEndpoint?.videoId : details?.videoId;
    if (typeof videoId === 'string' && videoId === youtubeVideoId()) {
      youtubeVideo = { videoId, live: pending ? null : details?.isLive === true };
    }
    scan();
  };
  document.addEventListener('yt-navigate-start', onNavigation);
  document.addEventListener('yt-navigate-finish', onNavigation);
  document.addEventListener('yt-page-data-updated', scan);
  // Live state can arrive after the video without a child-list mutation.
  new MutationObserver(records => {
    if (records.some(record => record.target instanceof Element
      && (record.target.matches(`${YOUTUBE_PLAYER}, .ytp-live-badge, meta[itemprop="isLiveBroadcast"], meta[itemprop="endDate"], [itemtype$="/VideoObject"]`)
        || record.target.localName === 'ytd-watch-flexy'))) scan();
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class', 'is-live', 'style', 'hidden', 'content', 'itemid'] });
}
