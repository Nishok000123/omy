import axios from 'axios';
import * as cheerio from 'cheerio';



const HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

// A pool of common desktop User-Agent strings to rotate on each request – helps avoid 403 blocks.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// -------------------------------------------------------------------
// Cloudflare clearance cookie cache (per base URL, 5 min TTL)
// -------------------------------------------------------------------
const cloudflareCache = {};

/**
 * Attempt to get / refresh a Cloudflare clearance cookie for a site.
 * We do a lightweight GET to the home page and capture any set-cookie header.
 * This works for sites that issue the clearance immediately (no JS challenge).
 */
async function ensureClearance(baseUrl) {
  const cached = cloudflareCache[baseUrl];
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return; // still fresh

  try {
    const res = await axios.get(baseUrl, {
      headers: { ...HEADERS, 'User-Agent': getRandomUserAgent() },
      timeout: DEFAULT_TIMEOUT,
      maxRedirects: 5,
      validateStatus: null
    });
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      const cf = setCookie.find(c => c.startsWith('cf_clearance='));
      if (cf) {
        cloudflareCache[baseUrl] = { cookie: cf.split(';')[0], ts: Date.now() };
      }
    }
  } catch (_) {
    // clearance attempt failed – continue without cookie
  }
}

/**
 * Build full request headers for a site.
 * Mixes rotating UA + Referer + Accept-Encoding + any stored clearance cookie.
 */
function getRequestHeaders(baseUrl) {
  const base = {
    ...HEADERS,
    'User-Agent': getRandomUserAgent(),
    Referer: baseUrl,
    'Accept-Encoding': 'gzip, deflate, br'
  };
  if (cloudflareCache[baseUrl]) {
    base.Cookie = cloudflareCache[baseUrl].cookie;
  }
  return base;
}

const cache = {};
const CACHE_TTL = 60 * 60 * 1000; // 1 hour cache duration
const DEFAULT_TIMEOUT = 15000;

/** 300 ms throttle before every outbound request to stay under CDN rate limits. */
async function throttledDelay() {
  await new Promise(r => setTimeout(r, 300));
}

async function axiosGetWithRetry(url, options = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      await throttledDelay();
      return await axios.get(url, { ...options, timeout: options.timeout || DEFAULT_TIMEOUT });
    } catch (err) {
      if (i === retries) throw err;
      const delay = Math.pow(2, i) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function getCached(key) {
  const entry = cache[key];
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data;
  }
  return null;
}

function setCached(key, data) {
  cache[key] = {
    timestamp: Date.now(),
    data
  };
}

// helper to clean and normalize URLs
function normalizeUrl(url, base) {
  if (!url) return null;
  let normalized = url;
  if (url.startsWith('//')) normalized = `https:${url}`;
  else if (url.startsWith('/')) normalized = `${base}${url}`;
  
  if (normalized.includes('downloaddirect.xyz/embed/')) {
    const uuid = normalized.split('/embed/')[1];
    if (uuid) {
      const cleanUuid = uuid.split(/[?#]/)[0];
      return `https://video.downloaddirect.xyz/${cleanUuid}.mp4`;
    }
  }
  return normalized;
}

// helper to extract video URL from specific iframe embeds
function extractIframeVideoUrl(post$) {
  const iframeSrc =
    post$('iframe[src*="player-x.php"]').attr('src') ||
    post$('iframe[data-lazy-src*="player-x.php"]').attr('data-lazy-src') ||
    post$('iframe[data-src*="player-x.php"]').attr('data-src');
  if (iframeSrc) {
    try {
      const urlObj = new URL(iframeSrc, 'https://example.com');
      const q = urlObj.searchParams.get('q');
      if (q) {
        let decoded = Buffer.from(q, 'base64').toString('utf8');
        // may be percent-encoded HTML
        try { decoded = decodeURIComponent(decoded); } catch (_) {}
        const match =
          decoded.match(/src=["'](https?:\/\/[^"']+)['"]/i) ||
          decoded.match(/(https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/i);
        if (match) return match[1].replace(/&amp;/g, '&');
      }
    } catch (e) {
      // Ignore URL parsing errors
    }
  }
  return null;
}

const AD_EMBED_RE = /orbsrv|doubleclick|googlesyndication|exoclick|trafficjunky|juicyads|adsterra|popads|adservice|facebook\.com\/plugins|twitter\.com\/i\/videos/i;
const PLAYER_HOST_RE = /luluvdo|lulustream|streamtape|dood|mixdrop|filemoon|voe\.|streamwish|vidhide|pixeldrain|bunkr|emturbovid|player-x|xvideos\.com\/embed|spankbang|ok\.ru|vidmoly|doodstream|mp4upload|streamsb|wolfstream|videzz|vidtube/i;

function absolutizeUrl(u) {
  if (!u || u === 'about:blank') return null;
  let s = String(u).trim().replace(/&amp;/g, '&');
  if (s.startsWith('//')) s = 'https:' + s;
  if (!/^https?:\/\//i.test(s)) return null;
  if (AD_EMBED_RE.test(s)) return null;
  return s;
}

/** Best-effort direct video / embed URL from a post HTML page */
function extractDirectVideoFromHtml(html, post$) {
  let videoUrl =
    extractIframeVideoUrl(post$) ||
    post$('video source[src]').attr('src') ||
    post$('video[src]').attr('src') ||
    post$('meta[property="og:video:secure_url"]').attr('content') ||
    post$('meta[property="og:video"]').attr('content') ||
    null;
  videoUrl = absolutizeUrl(videoUrl);

  if (!videoUrl) {
    post$('script[type="application/ld+json"]').each((_, el) => {
      if (videoUrl) return;
      try {
        const data = JSON.parse(post$(el).html() || post$(el).text() || '{}');
        const nodes = data['@graph'] || (Array.isArray(data) ? data : [data]);
        for (const node of nodes) {
          if (node?.['@type'] === 'VideoObject' && node.contentUrl && /\.mp4/i.test(node.contentUrl)) {
            videoUrl = absolutizeUrl(node.contentUrl);
            break;
          }
        }
      } catch (_) {}
    });
  }

  if (!videoUrl) {
    const mp4 = String(html).match(/https?:\/\/[^"'\\\s>]+\.mp4[^"'\\\s>]*/i);
    if (mp4) videoUrl = absolutizeUrl(mp4[0]);
  }

  // Prefer player inside main video container (skip ad iframes)
  if (!videoUrl) {
    const candidates = [];
    const collectFrom = (root) => {
      root.find('iframe').addBack('iframe').each((_, el) => {
        for (const a of ['data-lazy-src', 'data-src', 'src']) {
          const v = absolutizeUrl(post$(el).attr(a));
          if (v) candidates.push(v);
        }
      });
      root.find('noscript').each((_, el) => {
        const raw = post$(el).html() || '';
        const m = raw.match(/src=["']([^"']+)["']/i);
        if (m) {
          const v = absolutizeUrl(m[1]);
          if (v) candidates.push(v);
        }
      });
    };

    const playerBox = post$('.responsive-player, .video-player, .player-wrap, #video-player, .fluid-width-video-wrapper');
    if (playerBox.length) collectFrom(playerBox);
    if (!candidates.length) collectFrom(post$('body').length ? post$('body') : post$.root());

    // also scan full HTML noscript blocks (rocket-lazyload)
    const ns = String(html).matchAll(/<noscript[^>]*>([\s\S]*?)<\/noscript>/gi);
    for (const m of ns) {
      const src = m[1].match(/src=["']([^"']+)["']/i);
      if (src) {
        const v = absolutizeUrl(src[1]);
        if (v && PLAYER_HOST_RE.test(v)) candidates.push(v);
      }
    }

    const ranked = [...new Set(candidates)].sort((a, b) => {
      const sa = PLAYER_HOST_RE.test(a) ? 0 : 1;
      const sb = PLAYER_HOST_RE.test(b) ? 0 : 1;
      return sa - sb;
    });
    videoUrl = ranked[0] || null;
  }

  // raw HTML scan for known embed hosts
  if (!videoUrl) {
    const hostHit = String(html).match(
      /https?:\/\/(?:www\.)?(?:luluvdo|lulustream|streamtape|dood\.|doodstream|mixdrop|filemoon|streamwish|vidhide|emturbovid|xvideos\.com\/embedframe)[^\s"'<>]*/i
    );
    if (hostHit) videoUrl = absolutizeUrl(hostHit[0]);
  }

  return videoUrl;
}

/**
 * Scrapes DesiPorn.one  (KamaClips replacement — no Cloudflare block)
 * Listing: div.item > a[href*="/videos/"]  |  Search: /search/?q=term&from=N
 */
async function scrapeDesiPorn(page = 1, searchTerm = '', limit = 10) {
  const cacheKey = `desiporn_${page}_${searchTerm || 'default'}_l${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const baseUrl = 'https://desiporn.one';
  const from = (page - 1) * 30; // site uses offset-based pagination
  let url;
  if (searchTerm) {
    url = from === 0
      ? `${baseUrl}/search/?q=${encodeURIComponent(searchTerm)}`
      : `${baseUrl}/search/?q=${encodeURIComponent(searchTerm)}&from=${from}`;
  } else {
    url = from === 0 ? baseUrl : `${baseUrl}/most-popular/?from=${from}`;
  }

  try {
    await ensureClearance(baseUrl);
    const res = await axiosGetWithRetry(url, { headers: getRequestHeaders(baseUrl) });
    const $ = cheerio.load(res.data);
    const posts = [];

    $('div.item').each((_, el) => {
      const a = $(el).find('a[href*="/videos/"]').first();
      const title = a.attr('title') || a.find('strong.title').text().trim();
      const href = a.attr('href');
      const imgSrc = a.find('img.thumb').attr('data-original') || a.find('img.thumb').attr('src');

      if (title && href) {
        posts.push({
          title,
          url: normalizeUrl(href, baseUrl),
          thumbnail: normalizeUrl(imgSrc, baseUrl),
          siteName: 'DesiPorn',
          siteBaseUrl: baseUrl
        });
      }
    });

    const uniquePosts = [];
    const urls = new Set();
    for (const post of posts) {
      if (!urls.has(post.url)) {
        urls.add(post.url);
        uniquePosts.push(post);
      }
      if (uniquePosts.length >= limit) break;
    }

    // Resolve each post page to extract direct video URL
    const resolvedPosts = await Promise.all(
      uniquePosts.map(async (post) => {
        try {
          const postRes = await axiosGetWithRetry(post.url, { headers: getRequestHeaders(baseUrl) });
          const post$ = cheerio.load(postRes.data);

          // DesiPorn stores the MP4 in a <source> inside <video> or og:video
          let videoUrl = post$('video source[src]').attr('src')
            || post$('video[src]').attr('src')
            || post$('meta[property="og:video:secure_url"]').attr('content')
            || post$('meta[property="og:video"]').attr('content');

          post.videoUrl = normalizeUrl(videoUrl, baseUrl);
          if (!post.thumbnail) {
            post.thumbnail = post$('meta[property="og:image"]').attr('content');
          }
          return post;
        } catch (_) {
          return post;
        }
      })
    );

    const validPosts = resolvedPosts.filter(p => p.videoUrl);
    setCached(cacheKey, validPosts);
    return validPosts;
  } catch (err) {
    console.error(`Error scraping DesiPorn (Page ${page}, Search: ${searchTerm}):`, err.message);
    return [];
  }
}

/**
 * Scrapes Viralmms.com
 */
async function scrapeViralMms(page = 1, limit = 10) {
  const cacheKey = `viralmms_${page}_l${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const baseUrl = 'https://viralmms.com';
  const url = page === 1 ? baseUrl : `${baseUrl}/page/${page}`;
  try {
    await ensureClearance(baseUrl);
    const res = await axiosGetWithRetry(url, { headers: getRequestHeaders(baseUrl) });
    const $ = cheerio.load(res.data);
    const posts = [];

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).text());
        const graph = data['@graph'] || (Array.isArray(data) ? data : [data]);
        for (const node of graph) {
          if ((node['@type'] === 'ItemList' || node['@type'] === 'CollectionPage') && node.itemListElement) {
            for (const itemElement of node.itemListElement) {
              const item = itemElement.item;
              if (item && item['@type'] === 'VideoObject') {
                posts.push({
                  title: item.name,
                  url: normalizeUrl(item.url, baseUrl),
                  videoUrl: normalizeUrl(item.contentUrl, baseUrl),
                  thumbnail: normalizeUrl(item.thumbnailUrl, baseUrl),
                  siteName: 'ViralMMS',
                  siteBaseUrl: baseUrl
                });
              }
            }
          }
        }
      } catch (e) {}
    });

    if (posts.length === 0) {
      const pagePosts = [];
      $('a[href^="/post/"]').each((_, el) => {
        const title = $(el).find('p').text().trim() || $(el).text().trim();
        const href = $(el).attr('href');
        if (title && href) {
          pagePosts.push({
            title,
            url: normalizeUrl(href, baseUrl),
            siteName: 'ViralMMS',
            siteBaseUrl: baseUrl
          });
        }
      });

      const uniquePosts = [];
      const urls = new Set();
      for (const p of pagePosts) {
        if (!urls.has(p.url)) {
          urls.add(p.url);
          uniquePosts.push(p);
        }
        if (uniquePosts.length >= limit) break;
      }

      const resolved = await Promise.all(
        uniquePosts.map(async (post) => {
          try {
            const postRes = await axiosGetWithRetry(post.url, { headers: getRequestHeaders(baseUrl) });
            const post$ = cheerio.load(postRes.data);
            let videoUrl = null;
            let thumbnail = null;

            post$('script[type="application/ld+json"]').each((_, el) => {
              try {
                const data = JSON.parse(post$(el).text());
                const graph = data['@graph'] || (Array.isArray(data) ? data : [data]);
                for (const node of graph) {
                  if (node['@type'] === 'VideoObject') {
                    videoUrl = node.contentUrl;
                    thumbnail = node.thumbnailUrl;
                    break;
                  }
                }
              } catch (e) {}
            });

            if (!videoUrl) {
              const embedIframe = post$('iframe[src*="downloaddirect.xyz/embed"]').attr('src');
              if (embedIframe) videoUrl = embedIframe;
            }

            post.videoUrl = normalizeUrl(videoUrl, baseUrl);
            post.thumbnail = normalizeUrl(thumbnail || post$('meta[property="og:image"]').attr('content'), baseUrl);
            return post;
          } catch (err) {
            return post;
          }
        })
      );

      const validPosts = resolved.filter(p => p.videoUrl);
      setCached(cacheKey, validPosts);
      return validPosts;
    }

    const limitedPosts = posts.slice(0, limit);
    setCached(cacheKey, limitedPosts);
    return limitedPosts;
  } catch (err) {
    console.error(`Error scraping ViralMms (Page ${page}):`, err.message);
    return [];
  }
}

/**
 * Scrapes Desisexvdo.com
 */
async function scrapeDesiSexVdo(page = 1, searchTerm = '', limit = 10) {
  const cacheKey = `desisexvdo_${page}_${searchTerm || 'default'}_l${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const baseUrl = 'https://desisexvdo.com';
  let url = '';
  if (searchTerm) {
    url = page === 1 
      ? `${baseUrl}/?s=${encodeURIComponent(searchTerm)}` 
      : `${baseUrl}/page/${page}/?s=${encodeURIComponent(searchTerm)}`;
  } else {
    url = page === 1 ? `${baseUrl}/?filter=popular` : `${baseUrl}/page/${page}/?filter=popular`;
  }

  try {
    await ensureClearance(baseUrl);
    const res = await axiosGetWithRetry(url, { headers: getRequestHeaders(baseUrl) });
    const $ = cheerio.load(res.data);
    const posts = [];

    $('.video-loop .video-block').each((_, el) => {
      const title = $(el).find('a.infos').attr('title') || $(el).find('.title').text().trim();
      const href = $(el).find('a.infos').attr('href') || $(el).find('a.thumb').attr('href');
      const imgSrc = $(el).find('img.video-img').attr('data-src') || $(el).find('img.video-img').attr('src');

      if (title && href) {
        posts.push({
          title,
          url: normalizeUrl(href, baseUrl),
          thumbnail: normalizeUrl(imgSrc, baseUrl),
          siteName: 'DesiSexVdo',
          siteBaseUrl: baseUrl
        });
      }
    });

    const uniquePosts = [];
    const urls = new Set();
    for (const post of posts) {
      if (!urls.has(post.url)) {
        urls.add(post.url);
        uniquePosts.push(post);
      }
      if (uniquePosts.length >= limit) break;
    }

    const resolvedPosts = await Promise.all(
      uniquePosts.map(async (post) => {
        try {
          const postRes = await axiosGetWithRetry(post.url, { headers: getRequestHeaders(baseUrl) });
          const post$ = cheerio.load(postRes.data);
          let videoUrl = null;
          let thumbnail = null;

          post$('script[type="application/ld+json"]').each((_, el) => {
            try {
              const data = JSON.parse(post$(el).text());
              const graph = data['@graph'] || (Array.isArray(data) ? data : [data]);
              for (const node of graph) {
                if (node['@type'] === 'VideoObject') {
                  videoUrl = node.contentUrl;
                  thumbnail = node.thumbnailUrl;
                  break;
                }
              }
            } catch (e) {}
          });

          if (!videoUrl) {
            videoUrl = post$('video source').attr('src');
          }
          if (!thumbnail) {
            thumbnail = post$('video').attr('poster') || post$('meta[property="og:image"]').attr('content');
          }

          post.videoUrl = normalizeUrl(videoUrl, baseUrl);
          if (thumbnail) {
            post.thumbnail = normalizeUrl(thumbnail, baseUrl);
          }
          return post;
        } catch (err) {
          return post;
        }
      })
    );

    const validPosts = resolvedPosts.filter(p => p.videoUrl);
    setCached(cacheKey, validPosts);
    return validPosts;
  } catch (err) {
    console.error(`Error scraping DesiSexVdo (Page ${page}, Search: ${searchTerm}):`, err.message);
    return [];
  }
}

/**
 * Generic scraper function for Desi sites with similar structures (e.g. DesiBabe, DesiHub)
 */
async function scrapeGenericDesiSite(siteName, baseUrl, cacheKeyPrefix, page = 1, limit = 10) {
  const cacheKey = `${cacheKeyPrefix}_${page}_l${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const url = page === 1 ? baseUrl : `${baseUrl}/page/${page}`;
  try {
    await ensureClearance(baseUrl);
    const res = await axiosGetWithRetry(url, { headers: getRequestHeaders(baseUrl) });
    const $ = cheerio.load(res.data);
    const posts = [];

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).text());
        const graph = data['@graph'] || (Array.isArray(data) ? data : [data]);
        for (const node of graph) {
          if ((node['@type'] === 'CollectionPage' || node['@type'] === 'WebPage') && node.mainEntity && node.mainEntity.itemListElement) {
            for (const item of node.mainEntity.itemListElement) {
              if (item.url && item.name) {
                posts.push({
                  title: item.name,
                  url: normalizeUrl(item.url, baseUrl),
                  siteName: siteName,
                  siteBaseUrl: baseUrl
                });
              }
            }
          }
        }
      } catch (e) {}
    });

    if (posts.length === 0) {
      $('a[href^="/post/"]').each((_, el) => {
        const title = $(el).find('h3').text().trim() || $(el).attr('title') || $(el).text().trim();
        const href = $(el).attr('href');
        if (title && href) {
          posts.push({
            title,
            url: normalizeUrl(href, baseUrl),
            siteName: siteName,
            siteBaseUrl: baseUrl
          });
        }
      });
    }

    const uniquePosts = [];
    const urls = new Set();
    for (const post of posts) {
      if (!urls.has(post.url)) {
        urls.add(post.url);
        uniquePosts.push(post);
      }
      if (uniquePosts.length >= limit) break;
    }

    const resolvedPosts = await Promise.all(
      uniquePosts.map(async (post) => {
        try {
          const postRes = await axiosGetWithRetry(post.url, { headers: getRequestHeaders(baseUrl) });
          const post$ = cheerio.load(postRes.data);
          let videoUrl = null;
          let thumbnail = null;

          post$('script[type="application/ld+json"]').each((_, el) => {
            try {
              const data = JSON.parse(post$(el).text());
              const graph = data['@graph'] || (Array.isArray(data) ? data : [data]);
              for (const node of graph) {
                if (node['@type'] === 'VideoObject') {
                  videoUrl = node.contentUrl;
                  thumbnail = node.thumbnailUrl;
                  break;
                }
              }
            } catch (e) {}
          });

          if (!videoUrl) {
            const embedIframe = post$('iframe[src*="downloaddirect.xyz/embed"]').attr('src');
            if (embedIframe) videoUrl = embedIframe;
          }

          post.videoUrl = normalizeUrl(videoUrl, baseUrl);
          post.thumbnail = normalizeUrl(thumbnail || post$('meta[property="og:image"]').attr('content'), baseUrl);
          return post;
        } catch (err) {
          return post;
        }
      })
    );

    const validPosts = resolvedPosts.filter(p => p.videoUrl);
    setCached(cacheKey, validPosts);
    return validPosts;
  } catch (err) {
    console.error(`Error scraping ${siteName} (Page ${page}):`, err.message);
    return [];
  }
}

/**
 * Scrapes Desibabe.tv
 */
async function scrapeDesiBabe(page = 1, limit = 10) {
  return scrapeGenericDesiSite('DesiBabe', 'https://desibabe.tv', 'desibabe', page, limit);
}

/**
 * Scrapes Desihub.to
 */
async function scrapeDesiHub(page = 1, limit = 10) {
  const cacheKey = `desihub_${page}_l${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const baseUrl = 'https://desihub.to';
  const url = page === 1 ? baseUrl : `${baseUrl}/page/${page}`;
  try {
    await ensureClearance(baseUrl);
    const res = await axiosGetWithRetry(url, { headers: getRequestHeaders(baseUrl) });
    const $ = cheerio.load(res.data);
    const posts = [];

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).text());
        const graph = data['@graph'] || (Array.isArray(data) ? data : [data]);
        for (const node of graph) {
          if ((node['@type'] === 'CollectionPage' || node['@type'] === 'WebPage') && node.mainEntity && node.mainEntity.itemListElement) {
            for (const item of node.mainEntity.itemListElement) {
              if (item.url && item.name) {
                posts.push({
                  title: item.name,
                  url: normalizeUrl(item.url, baseUrl),
                  siteName: 'DesiHub',
                  siteBaseUrl: baseUrl
                });
              }
            }
          }
        }
      } catch (e) {}
    });

    if (posts.length === 0) {
      $('a[href^="/post/"]').each((_, el) => {
        const title = $(el).find('h3').text().trim() || $(el).attr('title') || $(el).text().trim();
        const href = $(el).attr('href');
        if (title && href) {
          posts.push({
            title,
            url: normalizeUrl(href, baseUrl),
            siteName: 'DesiHub',
            siteBaseUrl: baseUrl
          });
        }
      });
    }

    const uniquePosts = [];
    const urls = new Set();
    for (const post of posts) {
      if (!urls.has(post.url)) {
        urls.add(post.url);
        uniquePosts.push(post);
      }
      if (uniquePosts.length >= limit) break;
    }

    const resolvedPosts = await Promise.all(
      uniquePosts.map(async (post) => {
        try {
          const postRes = await axiosGetWithRetry(post.url, { headers: getRequestHeaders(baseUrl) });
          const post$ = cheerio.load(postRes.data);
          let videoUrl = null;
          let thumbnail = null;

          post$('script[type="application/ld+json"]').each((_, el) => {
            try {
              const data = JSON.parse(post$(el).text());
              const graph = data['@graph'] || (Array.isArray(data) ? data : [data]);
              for (const node of graph) {
                if (node['@type'] === 'VideoObject') {
                  videoUrl = node.contentUrl;
                  thumbnail = node.thumbnailUrl;
                  break;
                }
              }
            } catch (e) {}
          });

          if (!videoUrl) {
            const embedIframe = post$('iframe[src*="downloaddirect.xyz/embed"]').attr('src');
            if (embedIframe) videoUrl = embedIframe;
          }

          post.videoUrl = normalizeUrl(videoUrl, baseUrl);
          post.thumbnail = normalizeUrl(thumbnail || post$('meta[property="og:image"]').attr('content'), baseUrl);
          return post;
        } catch (err) {
          return post;
        }
      })
    );

    const validPosts = resolvedPosts.filter(p => p.videoUrl);
    setCached(cacheKey, validPosts);
    return validPosts;
  } catch (err) {
    console.error(`Error scraping DesiHub (Page ${page}):`, err.message);
    return [];
  }
}

/**
 * Scrapes Desibf.com
 */
async function scrapeDesiBF(page = 1, searchTerm = '', limit = 10) {
  const cacheKey = `desibf_${page}_${searchTerm || 'default'}_l${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const baseUrl = 'https://desibf.com';
  let url = '';
  if (searchTerm) {
    url = page === 1 
      ? `${baseUrl}/?s=${encodeURIComponent(searchTerm)}` 
      : `${baseUrl}/page/${page}/?s=${encodeURIComponent(searchTerm)}`;
  } else {
    url = page === 1 ? baseUrl : `${baseUrl}/page/${page}/`;
  }

  try {
    await ensureClearance(baseUrl);
    const res = await axiosGetWithRetry(url, { headers: getRequestHeaders(baseUrl) });
    const $ = cheerio.load(res.data);
    const posts = [];

    $('.thumb-block').each((_, el) => {
      const title = $(el).attr('title') || $(el).find('.title').text().trim();
      const href = $(el).attr('href') || $(el).find('a').attr('href');
      const imgSrc = $(el).find('img.video-main-thumb').attr('src') || $(el).find('img.video-main-thumb').attr('data-src');

      if (title && href) {
        posts.push({
          title,
          url: normalizeUrl(href, baseUrl),
          thumbnail: normalizeUrl(imgSrc, baseUrl),
          siteName: 'DesiBF',
          siteBaseUrl: baseUrl
        });
      }
    });

    const uniquePosts = [];
    const urls = new Set();
    for (const post of posts) {
      if (!urls.has(post.url)) {
        urls.add(post.url);
        uniquePosts.push(post);
      }
      if (uniquePosts.length >= limit) break;
    }

    const resolvedPosts = await Promise.all(
      uniquePosts.map(async (post) => {
        try {
          const postRes = await axiosGetWithRetry(post.url, { headers: getRequestHeaders(baseUrl) });
          const post$ = cheerio.load(postRes.data);
          let videoUrl = post$('meta[itemprop="contentURL"]').attr('content');

          if (!videoUrl) {
            const iframeUrl = extractIframeVideoUrl(post$);
            if (iframeUrl) videoUrl = iframeUrl;
          }

          if (!videoUrl) {
            videoUrl = post$('video source').attr('src') || post$('video').attr('src');
          }

          post.videoUrl = normalizeUrl(videoUrl, baseUrl);
          return post;
        } catch (err) {
          return post;
        }
      })
    );

    const validPosts = resolvedPosts.filter(p => p.videoUrl);
    setCached(cacheKey, validPosts);
    return validPosts;
  } catch (err) {
    console.error(`Error scraping DesiBF (Page ${page}, Search: ${searchTerm}):`, err.message);
    return [];
  }
}

/**
 * Scrapes Desileak49.com
 */
async function scrapeDesiLeak49(page = 1, searchTerm = '', limit = 10) {
  const cacheKey = `desileak49_${page}_${searchTerm || 'default'}_l${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const baseUrl = 'https://desileak49.com';
  let url = '';
  if (searchTerm) {
    url = page === 1 
      ? `${baseUrl}/search/?key=${encodeURIComponent(searchTerm)}` 
      : `${baseUrl}/search/?key=${encodeURIComponent(searchTerm)}&page=${page}`;
  } else {
    url = page === 1 ? baseUrl : `${baseUrl}/?page=${page}`;
  }

  try {
    await ensureClearance(baseUrl);
    const res = await axiosGetWithRetry(url, { headers: getRequestHeaders(baseUrl) });
    const $ = cheerio.load(res.data);
    const posts = [];

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).text());
        const graph = data['@graph'] || (Array.isArray(data) ? data : [data]);
        for (const node of graph) {
          if (node['@type'] === 'ItemList' && node.itemListElement) {
            for (const item of node.itemListElement) {
              if (item.url && item.name) {
                posts.push({
                  title: item.name,
                  url: normalizeUrl(item.url, baseUrl),
                  siteName: 'DesiLeak49',
                  siteBaseUrl: baseUrl
                });
              }
            }
          }
        }
      } catch (e) {}
    });

    if (posts.length === 0) {
      $('a[href*="/video/"]').each((_, el) => {
        const title = $(el).find('p').text().trim() || $(el).attr('title') || $(el).text().trim();
        const href = $(el).attr('href');
        if (title && href) {
          posts.push({
            title,
            url: normalizeUrl(href, baseUrl),
            siteName: 'DesiLeak49',
            siteBaseUrl: baseUrl
          });
        }
      });
    }

    const uniquePosts = [];
    const urls = new Set();
    for (const post of posts) {
      if (!urls.has(post.url)) {
        urls.add(post.url);
        uniquePosts.push(post);
      }
      if (uniquePosts.length >= limit) break;
    }

    const resolvedPosts = await Promise.all(
      uniquePosts.map(async (post) => {
        try {
          const postRes = await axiosGetWithRetry(post.url, { headers: getRequestHeaders(baseUrl) });
          const post$ = cheerio.load(postRes.data);
          let videoUrl = post$('meta[property="og:video"]').attr('content');
          let thumbnail = post$('meta[property="og:image"]').attr('content');

          if (!videoUrl) {
            videoUrl = post$('video source').attr('src') || post$('video').attr('src');
          }

          post.videoUrl = normalizeUrl(videoUrl, baseUrl);
          post.thumbnail = normalizeUrl(thumbnail, baseUrl);
          return post;
        } catch (err) {
          return post;
        }
      })
    );

    const validPosts = resolvedPosts.filter(p => p.videoUrl);
    setCached(cacheKey, validPosts);
    return validPosts;
  } catch (err) {
    console.error(`Error scraping DesiLeak49 (Page ${page}, Search: ${searchTerm}):`, err.message);
    return [];
  }
}

/**
 * Scrapes Mastiraja.com
 */
async function scrapeMastiRaja(page = 1, searchTerm = '', limit = 10) {
  const cacheKey = `mastiraja_${page}_${searchTerm || 'default'}_l${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const baseUrl = 'https://mastiraja.com';
  let url = '';
  if (searchTerm) {
    url = page === 1 
      ? `${baseUrl}/?s=${encodeURIComponent(searchTerm)}` 
      : `${baseUrl}/page/${page}/?s=${encodeURIComponent(searchTerm)}`;
  } else {
    url = page === 1 ? baseUrl : `${baseUrl}/page/${page}/`;
  }

  try {
    await ensureClearance(baseUrl);
    const res = await axiosGetWithRetry(url, { headers: getRequestHeaders(baseUrl) });
    const $ = cheerio.load(res.data);
    const posts = [];

    $('.thumb-block').each((_, el) => {
      const title = $(el).attr('title') || $(el).find('.title').text().trim() || $(el).find('a').attr('title');
      const href = $(el).attr('href') || $(el).find('a').attr('href');
      const imgSrc = $(el).find('img.video-main-thumb').attr('src') || $(el).find('img.video-main-thumb').attr('data-src');

      if (title && href) {
        posts.push({
          title,
          url: normalizeUrl(href, baseUrl),
          thumbnail: normalizeUrl(imgSrc, baseUrl),
          siteName: 'MastiRaja',
          siteBaseUrl: baseUrl
        });
      }
    });

    const uniquePosts = [];
    const urls = new Set();
    for (const post of posts) {
      if (!urls.has(post.url)) {
        urls.add(post.url);
        uniquePosts.push(post);
      }
      if (uniquePosts.length >= limit) break;
    }

    const resolvedPosts = await Promise.all(
      uniquePosts.map(async (post) => {
        try {
          const postRes = await axiosGetWithRetry(post.url, { headers: getRequestHeaders(baseUrl) });
          const post$ = cheerio.load(postRes.data);
          let videoUrl = post$('meta[itemprop="contentURL"]').attr('content');

          if (!videoUrl) {
            const iframeUrl = extractIframeVideoUrl(post$);
            if (iframeUrl) videoUrl = iframeUrl;
          }

          if (!videoUrl) {
            videoUrl = post$('video source').attr('src') || post$('video').attr('src');
          }

          post.videoUrl = normalizeUrl(videoUrl, baseUrl);
          return post;
        } catch (err) {
          return post;
        }
      })
    );

    const validPosts = resolvedPosts.filter(p => p.videoUrl);
    setCached(cacheKey, validPosts);
    return validPosts;
  } catch (err) {
    console.error(`Error scraping MastiRaja (Page ${page}, Search: ${searchTerm}):`, err.message);
    return [];
  }
}




// ============================================================
// NEW SCRAPERS: MMSBee & DesiPapa
// ============================================================

/**
 * Scrapes MMSBee.org (WordPress-based, accessible, good desi content)
 * Listing: article.post > h2.title > a  |  Categories: /indian/, /desi/, /latest/
 * Search: /?s=term
 */
async function scrapeMMSBee(page = 1, searchTerm = '', limit = 10) {
  const cacheKey = `mmsbee_${page}_${searchTerm || 'default'}_l${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const baseUrl = 'https://www.mmsbee.org';
  let url;
  if (searchTerm) {
    url = page === 1
      ? `${baseUrl}/?s=${encodeURIComponent(searchTerm)}`
      : `${baseUrl}/page/${page}/?s=${encodeURIComponent(searchTerm)}`;
  } else {
    url = page === 1 ? `${baseUrl}/latest/` : `${baseUrl}/latest/page/${page}/`;
  }

  try {
    await ensureClearance(baseUrl);
    const res = await axiosGetWithRetry(url, { headers: getRequestHeaders(baseUrl) });
    const $ = cheerio.load(res.data);
    const posts = [];

    // Main post listing - articles with title links
    $('article.post, .post-item, .entry').each((_, el) => {
      const a = $(el).find('h2 a, h3 a, .entry-title a, .post-title a').first();
      if (!a.length) return;
      const title = a.text().trim() || a.attr('title');
      const href = a.attr('href');
      const imgSrc = $(el).find('img').first().attr('src') || $(el).find('img').first().attr('data-src');

      if (title && href) {
        posts.push({
          title,
          url: normalizeUrl(href, baseUrl),
          thumbnail: normalizeUrl(imgSrc, baseUrl),
          siteName: 'MMSBee',
          siteBaseUrl: baseUrl
        });
      }
    });

    // Fallback: any link in content area
    if (posts.length === 0) {
      $('.content a[href*="/"]').each((_, el) => {
        const a = $(el);
        const title = a.text().trim();
        const href = a.attr('href');
        if (title && href && href.includes(baseUrl) && posts.length < limit * 2) {
          posts.push({
            title,
            url: normalizeUrl(href, baseUrl),
            thumbnail: '',
            siteName: 'MMSBee',
            siteBaseUrl: baseUrl
          });
        }
      });
    }

    const uniquePosts = [];
    const urls = new Set();
    for (const post of posts) {
      if (!urls.has(post.url)) {
        urls.add(post.url);
        uniquePosts.push(post);
      }
      if (uniquePosts.length >= limit) break;
    }

    // Resolve video URLs from individual post pages
    const resolvedPosts = await Promise.all(
      uniquePosts.map(async (post) => {
        try {
          const postRes = await axiosGetWithRetry(post.url, { headers: getRequestHeaders(baseUrl) });
          const post$ = cheerio.load(postRes.data);

          // WP sites often have video in iframe, video tag, or og:video
          let videoUrl = post$('meta[property="og:video"]').attr('content')
            || post$('meta[itemprop="contentURL"]').attr('content')
            || post$('video source').attr('src')
            || post$('iframe[src*="video"], iframe[src*="embed"]').attr('src');

          // Try to find video in content
          if (!videoUrl) {
            post$('.entry-content, .post-content, .content').find('video, iframe').each((_, el) => {
              const src = $(el).attr('src');
              if (src && (src.includes('.mp4') || src.includes('.m3u8') || src.includes('video'))) {
                videoUrl = src;
                return false;
              }
            });
          }

          post.videoUrl = normalizeUrl(videoUrl, baseUrl);
          if (!post.thumbnail) {
            post.thumbnail = post$('meta[property="og:image"]').attr('content') || post$('.entry-content img').first().attr('src');
          }
          return post;
        } catch (_) {
          return post;
        }
      })
    );

    const validPosts = resolvedPosts.filter(p => p.videoUrl);
    setCached(cacheKey, validPosts);
    return validPosts;
  } catch (err) {
    console.error(`Error scraping MMSBee (Page ${page}, Search: ${searchTerm}):`, err.message);
    return [];
  }
}

/**
 * Scrapes DesiPapa.com (Simple HTML site, accessible)
 * Listing: div.video-item or similar  |  Categories: latest, indian, etc.
 */
async function scrapeDesiPapa(page = 1, searchTerm = '', limit = 10) {
  const cacheKey = `desipapa_${page}_${searchTerm || 'default'}_l${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const baseUrl = 'https://www.desipapa.com';
  let url;
  if (searchTerm) {
    url = `${baseUrl}/search?q=${encodeURIComponent(searchTerm)}`;
  } else {
    url = page === 1 ? `${baseUrl}/` : `${baseUrl}/page/${page}/`;
  }

  try {
    await ensureClearance(baseUrl);
    const res = await axiosGetWithRetry(url, { headers: getRequestHeaders(baseUrl) });
    const $ = cheerio.load(res.data);
    const posts = [];

    // Try multiple selectors for video listings
    const selectors = [
      '.video-item', '.video-block', '.post-item', '.item',
      'article', '.thumb-block', '.video-thumb'
    ];

    for (const sel of selectors) {
      $(sel).each((_, el) => {
        const a = $(el).find('a[href]').first();
        const title = a.attr('title') || a.text().trim() || $(el).find('img').attr('alt');
        const href = a.attr('href');
        const imgSrc = $(el).find('img').attr('src') || $(el).find('img').attr('data-src');

        if (title && href) {
          posts.push({
            title,
            url: normalizeUrl(href, baseUrl),
            thumbnail: normalizeUrl(imgSrc, baseUrl),
            siteName: 'DesiPapa',
            siteBaseUrl: baseUrl
          });
        }
      });
      if (posts.length > 0) break;
    }

    // Fallback: any video links
    if (posts.length === 0) {
      $('a[href*="/video"], a[href*="/watch"]').each((_, el) => {
        const a = $(el);
        const title = a.attr('title') || a.text().trim();
        const href = a.attr('href');
        if (title && href) {
          posts.push({
            title,
            url: normalizeUrl(href, baseUrl),
            thumbnail: '',
            siteName: 'DesiPapa',
            siteBaseUrl: baseUrl
          });
        }
      });
    }

    const uniquePosts = [];
    const urls = new Set();
    for (const post of posts) {
      if (!urls.has(post.url)) {
        urls.add(post.url);
        uniquePosts.push(post);
      }
      if (uniquePosts.length >= limit) break;
    }

    const resolvedPosts = await Promise.all(
      uniquePosts.map(async (post) => {
        try {
          const postRes = await axiosGetWithRetry(post.url, { headers: getRequestHeaders(baseUrl) });
          const post$ = cheerio.load(postRes.data);

          let videoUrl = post$('meta[property="og:video"]').attr('content')
            || post$('video source').attr('src')
            || post$('video').attr('src')
            || post$('iframe[src*="video"]').attr('src');

          post.videoUrl = normalizeUrl(videoUrl, baseUrl);
          if (!post.thumbnail) {
            post.thumbnail = post$('meta[property="og:image"]').attr('content') || post$('img').first().attr('src');
          }
          return post;
        } catch (_) {
          return post;
        }
      })
    );

    const validPosts = resolvedPosts.filter(p => p.videoUrl);
    setCached(cacheKey, validPosts);
    return validPosts;
  } catch (err) {
    console.error(`Error scraping DesiPapa (Page ${page}, Search: ${searchTerm}):`, err.message);
    return [];
  }
}

/**
 * Scrapes Hotpic.cc popular albums (NSFW) - direct MP4 video URLs
 * Listing: /filter/dpd/{page}  |  Albums: /album/{id}  |  Videos embedded in JSON-LD + direct MP4 links
 */
async function scrapeHotpic(page = 1, limit = 10) {
  const cacheKey = `hotpic_${page}_l${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const baseUrl = 'https://hotpic.cc';
  // Popular filter: day+popular+desc = /filter/dpd
  const url = page === 1 ? `${baseUrl}/filter/dpd` : `${baseUrl}/filter/dpd/${page}`;

  try {
    await ensureClearance(baseUrl);
    const res = await axiosGetWithRetry(url, { headers: getRequestHeaders(baseUrl) });
    const $ = cheerio.load(res.data);
    const posts = [];

    // Album cards in #album-list
    $('a[href^="/album/"]').each((_, el) => {
      const a = $(el);
      const href = a.attr('href');
      const title = a.attr('title') || a.attr('data-title') || a.text().trim();
      const imgSrc = a.find('img').attr('data-src') || a.find('img').attr('src');
      if (title && href) {
        posts.push({
          title,
          url: normalizeUrl(href, baseUrl),
          thumbnail: normalizeUrl(imgSrc, baseUrl),
          siteName: 'Hotpic',
          siteBaseUrl: baseUrl
        });
      }
    });

    const uniquePosts = [];
    const urls = new Set();
    for (const post of posts) {
      if (!urls.has(post.url)) {
        urls.add(post.url);
        uniquePosts.push(post);
      }
      if (uniquePosts.length >= limit) break;
    }

    // Resolve each album page for ALL MP4 video URLs
    const resolvedPosts = await Promise.all(
      uniquePosts.map(async (post) => {
        try {
          const postRes = await axiosGetWithRetry(post.url, { headers: getRequestHeaders(baseUrl) });
          const post$ = cheerio.load(postRes.data);

          // Find all MP4 URLs in page HTML
          const mp4Matches = postRes.data.matchAll(/https:\/\/hotpic\.cc\/uploads\/[^"'\s]+\.mp4/g);
          const videoUrls = [...new Set([...mp4Matches].map(m => m[0]))];

          // Also check JSON-LD for VideoObjects
          post$('script[type="application/ld+json"]').each((_, el) => {
            try {
              const data = JSON.parse(post$(el).html());
              const items = Array.isArray(data) ? data : [data];
              for (const item of items) {
                if (item['@type'] === 'VideoObject' && item.contentUrl && item.contentUrl.includes('.mp4')) {
                  videoUrls.push(item.contentUrl);
                }
                if (item['@graph']) {
                  for (const g of item['@graph']) {
                    if (g['@type'] === 'VideoObject' && g.contentUrl && g.contentUrl.includes('.mp4')) {
                      videoUrls.push(g.contentUrl);
                    }
                  }
                }
              }
            } catch (_) {}
          });

          const uniqueVideoUrls = [...new Set(videoUrls)];

          if (uniqueVideoUrls.length === 0) {
            return null;
          }

          // Return album object with all videos grouped
          const albumThumbnail = post.thumbnail || post$('meta[property="og:image"]').attr('content')
            || post$('script[type="application/ld+json"]').first().text().match(/"thumbnailUrl"\s*:\s*"([^"]+)"/)?.[1];
          
          return {
            ...post,
            _isAlbum: true,
            _albumVideos: uniqueVideoUrls.map((videoUrl, idx) => ({
              title: `${post.title} (${idx + 1}/${uniqueVideoUrls.length})`,
              videoUrl: normalizeUrl(videoUrl, baseUrl),
              thumbnail: albumThumbnail
            }))
          };
        } catch (_) {
          return null;
        }
      })
    );

    // Filter valid albums
    const validAlbums = resolvedPosts.filter(p => p && p._albumVideos && p._albumVideos.length > 0);
    setCached(cacheKey, validAlbums);
    return validAlbums;
  } catch (err) {
    console.error(`Error scraping Hotpic (Page ${page}):`, err.message);
    return [];
  }
}

/**
 * LatestDesiMMS — WP tube theme
 * Filters: latest | most-viewed | longest | popular | random
 * Search: pass searchTerm as plain text (not a filter name)
 * Listing: /?filter=X  |  /page/N/?filter=X  |  /?s=term
 * Video: clean-tube-player player-x.php → direct MP4
 */
async function scrapeLatestDesiMms(page = 1, filterOrSearch = 'most-viewed', limit = 10) {
  const FILTERS = new Set(['latest', 'most-viewed', 'longest', 'popular', 'random']);
  const isFilter = FILTERS.has(String(filterOrSearch || '').toLowerCase());
  const filter = isFilter ? String(filterOrSearch).toLowerCase() : 'most-viewed';
  const searchTerm = isFilter ? '' : (filterOrSearch || '');
  const cacheKey = `latestdesimms_${page}_${searchTerm || filter}_l${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const baseUrl = 'https://latestdesimms.com';
  let url;
  if (searchTerm) {
    url = page === 1
      ? `${baseUrl}/?s=${encodeURIComponent(searchTerm)}`
      : `${baseUrl}/page/${page}/?s=${encodeURIComponent(searchTerm)}`;
  } else {
    url = page === 1
      ? `${baseUrl}/?filter=${filter}`
      : `${baseUrl}/page/${page}/?filter=${filter}`;
  }

  try {
    await ensureClearance(baseUrl);
    const res = await axiosGetWithRetry(url, { headers: getRequestHeaders(baseUrl) });
    const $ = cheerio.load(res.data);
    const posts = [];

    $('article.loop-video, article.thumb-block, .videos-list article, article.post').each((_, el) => {
      const a = $(el).find('a[href]').first();
      const href = a.attr('href');
      const title = a.attr('title') || $(el).find('.title, .entry-title, h2, h3').first().text().trim() || a.text().trim();
      const imgSrc =
        $(el).find('img').attr('data-src') ||
        $(el).find('img').attr('data-lazy-src') ||
        $(el).find('img').attr('src');
      if (!href || !title) return;
      if (/\/(page|categories|tags|authors)\//i.test(href)) return;
      if (href === baseUrl || href === baseUrl + '/') return;
      posts.push({
        title: title.replace(/\s+/g, ' ').trim(),
        url: normalizeUrl(href, baseUrl),
        thumbnail: normalizeUrl(imgSrc, baseUrl),
        siteName: 'LatestDesiMMS',
        siteBaseUrl: baseUrl
      });
    });

    // broader fallback
    if (posts.length === 0) {
      $('a[href*="latestdesimms.com/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (!/latestdesimms\.com\/[a-z0-9-]+\/?$/i.test(href)) return;
        if (/page|categories|tags|filter|authors/.test(href)) return;
        const title = $(el).attr('title') || $(el).text().trim();
        const imgSrc = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
        if (title && title.length > 5) {
          posts.push({
            title: title.replace(/\s+/g, ' ').trim().slice(0, 120),
            url: normalizeUrl(href, baseUrl),
            thumbnail: normalizeUrl(imgSrc, baseUrl),
            siteName: 'LatestDesiMMS',
            siteBaseUrl: baseUrl
          });
        }
      });
    }

    const uniquePosts = [];
    const seen = new Set();
    for (const post of posts) {
      if (!post.url || seen.has(post.url)) continue;
      seen.add(post.url);
      uniquePosts.push(post);
      if (uniquePosts.length >= limit) break;
    }

    const resolved = await Promise.all(uniquePosts.map(async (post) => {
      try {
        const postRes = await axiosGetWithRetry(post.url, { headers: getRequestHeaders(baseUrl) });
        const post$ = cheerio.load(postRes.data);
        post.videoUrl = normalizeUrl(extractDirectVideoFromHtml(postRes.data, post$), baseUrl);
        if (!post.thumbnail) {
          post.thumbnail = post$('meta[property="og:image"]').attr('content');
        }
        return post;
      } catch (_) {
        return post;
      }
    }));

    const valid = resolved.filter(p => p.videoUrl);
    setCached(cacheKey, valid);
    return valid;
  } catch (err) {
    console.error(`Error scraping LatestDesiMMS (Page ${page}):`, err.message);
    return [];
  }
}

/**
 * MMSGram forum scrapers
 * Forums:
 *   latest-trending  → /forum/25-latest-trending-content/
 *   desi-new         → /forum/4-desi-new-videos-hd-sd/
 *   exclusive        → /forum/23-mmsgram-exclusive-trending/
 * Extracts host/mp4 links from topics (streamtape etc.) as videoUrl when direct mp4 present
 */
const MMSGRAM_FORUMS = {
  'latest-trending': { path: '/forum/25-latest-trending-content/', label: 'Latest Trending' },
  'desi-new': { path: '/forum/4-desi-new-videos-hd-sd/', label: 'Desi New Videos' },
  exclusive: { path: '/forum/23-mmsgram-exclusive-trending/', label: 'Exclusive Trending' }
};

async function scrapeMmsGram(page = 1, forumKey = 'latest-trending', limit = 10) {
  const key = MMSGRAM_FORUMS[forumKey] ? forumKey : 'latest-trending';
  const forum = MMSGRAM_FORUMS[key];
  const cacheKey = `mmsgram_${key}_${page}_l${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const baseUrl = 'https://mmsgram.com';
  const url = page === 1
    ? `${baseUrl}${forum.path}`
    : `${baseUrl}${forum.path}page/${page}/`;

  try {
    await ensureClearance(baseUrl);
    const res = await axiosGetWithRetry(url, { headers: getRequestHeaders(baseUrl) });
    const $ = cheerio.load(res.data);
    const posts = [];
    const seen = new Set();

    $('a[href*="/topic/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const title = $(el).text().trim().replace(/\s+/g, ' ');
      // skip date-only / short labels
      if (!href.includes('/topic/') || !title || title.length < 8) return;
      if (/^(january|february|march|april|may|june|july|august|september|october|november|december|\d+\s+(minute|hour|day|week|month|year)|just now)/i.test(title)) return;
      const full = normalizeUrl(href.split('?')[0], baseUrl);
      if (seen.has(full)) return;
      seen.add(full);
      posts.push({
        title: title.slice(0, 140),
        url: full,
        thumbnail: null,
        siteName: 'MMSGram',
        siteBaseUrl: baseUrl,
        forum: forum.label
      });
    });

    const uniquePosts = posts.slice(0, limit);

    const resolved = await Promise.all(uniquePosts.map(async (post) => {
      try {
        const postRes = await axiosGetWithRetry(post.url, { headers: getRequestHeaders(baseUrl) });
        const post$ = cheerio.load(postRes.data);
        const html = String(postRes.data);

        // prefer raw .mp4
        let videoUrl = null;
        const mp4s = html.match(/https?:\/\/[^"'\\\s>]+\.mp4[^"'\\\s>]*/gi) || [];
        const cleanMp4 = [...new Set(mp4s.map(u => u.replace(/\\n.*/, '').replace(/<\/a.*/, '')))];
        if (cleanMp4.length) videoUrl = cleanMp4[0];

        // host page links (not always direct stream, but watchable)
        if (!videoUrl) {
          const hosts = [];
          post$('a[href]').each((_, el) => {
            const h = post$(el).attr('href') || '';
            if (/streamtape|doodstream|dood\.|mixdrop|filemoon|voe\.|pixeldrain|bunkr|gofile|cyberfile|streamwish|vidhide|lulustream|luluvdo|ok\.ru/i.test(h)) {
              hosts.push(h);
            }
          });
          if (hosts.length) videoUrl = hosts[0];
        }

        // raw URL scrape fallback
        if (!videoUrl) {
          const raw = html.match(/https?:\/\/(?:streamtape|dood|mixdrop|filemoon|pixeldrain|bunkr|gofile|luluvdo)[^\s"'<>]+/gi);
          if (raw?.length) videoUrl = raw[0].replace(/\\n.*/, '');
        }

        post.videoUrl = videoUrl;
        post.thumbnail =
          post$('meta[property="og:image"]').attr('content') ||
          post$('img').first().attr('src') ||
          null;
        return post;
      } catch (_) {
        return post;
      }
    }));

    // keep posts even without videoUrl if they have topic url (user can open)
    const valid = resolved.filter(p => p.videoUrl || p.url);
    // prefer those with video
    valid.sort((a, b) => (b.videoUrl ? 1 : 0) - (a.videoUrl ? 1 : 0));
    setCached(cacheKey, valid.slice(0, limit));
    return valid.slice(0, limit);
  } catch (err) {
    console.error(`Error scraping MMSGram (Page ${page}):`, err.message);
    return [];
  }
}

/**
 * IndianPorn365 — WP RetroTube theme (same filters as LatestDesiMMS)
 * Filters: latest | most-viewed | longest | popular | random
 * Video often external embed (luluvdo etc.); extract lazy iframe or mp4 when present
 */
async function scrapeIndianPorn365(page = 1, filterOrSearch = 'latest', limit = 10) {
  const FILTERS = new Set(['latest', 'most-viewed', 'longest', 'popular', 'random']);
  const isFilter = FILTERS.has(String(filterOrSearch || '').toLowerCase());
  const filter = isFilter ? String(filterOrSearch).toLowerCase() : 'latest';
  const searchTerm = isFilter ? '' : (filterOrSearch || '');
  const cacheKey = `indianporn365_${page}_${searchTerm || filter}_l${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const baseUrl = 'https://www.indianporn365.net';
  let url;
  if (searchTerm) {
    url = page === 1
      ? `${baseUrl}/?s=${encodeURIComponent(searchTerm)}`
      : `${baseUrl}/page/${page}/?s=${encodeURIComponent(searchTerm)}`;
  } else {
    url = page === 1
      ? `${baseUrl}/?filter=${filter}`
      : `${baseUrl}/page/${page}/?filter=${filter}`;
  }

  try {
    await ensureClearance(baseUrl);
    const res = await axiosGetWithRetry(url, { headers: getRequestHeaders(baseUrl) });
    const $ = cheerio.load(res.data);
    const posts = [];

    $('article.loop-video, article.thumb-block, article.post, .videos-list article').each((_, el) => {
      const a = $(el).find('a[href*="/20"]').first();
      const href = a.attr('href');
      const title =
        a.attr('title') ||
        $(el).find('.title, .entry-title, h2, h3').first().text().trim() ||
        a.text().trim();
      const imgSrc =
        $(el).find('img').attr('data-src') ||
        $(el).find('img').attr('data-lazy-src') ||
        $(el).find('img').attr('src');
      if (!href || !title) return;
      posts.push({
        title: title.replace(/\s+/g, ' ').trim(),
        url: normalizeUrl(href, baseUrl),
        thumbnail: normalizeUrl(imgSrc, baseUrl),
        siteName: 'IndianPorn365',
        siteBaseUrl: baseUrl
      });
    });

    if (posts.length === 0) {
      $('a[href*="/202"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (!/\/20\d{2}\/\d{2}\/\d{2}\//.test(href)) return;
        const title = $(el).attr('title') || $(el).text().trim();
        if (!title || title.length < 6) return;
        posts.push({
          title: title.replace(/\s+/g, ' ').trim().slice(0, 140),
          url: normalizeUrl(href, baseUrl),
          thumbnail: normalizeUrl($(el).find('img').attr('data-src') || $(el).find('img').attr('src'), baseUrl),
          siteName: 'IndianPorn365',
          siteBaseUrl: baseUrl
        });
      });
    }

    const uniquePosts = [];
    const seen = new Set();
    for (const post of posts) {
      if (!post.url || seen.has(post.url)) continue;
      seen.add(post.url);
      uniquePosts.push(post);
      if (uniquePosts.length >= limit) break;
    }

    const resolved = await Promise.all(uniquePosts.map(async (post) => {
      try {
        const postRes = await axiosGetWithRetry(post.url, { headers: getRequestHeaders(baseUrl) });
        const post$ = cheerio.load(postRes.data);
        let videoUrl = extractDirectVideoFromHtml(postRes.data, post$);
        // keep embed hosts as-is (don't force site origin)
        if (videoUrl && !/^https?:\/\//i.test(videoUrl)) {
          videoUrl = normalizeUrl(videoUrl, baseUrl);
        }
        post.videoUrl = videoUrl || null;
        if (!post.thumbnail || String(post.thumbnail).startsWith('data:')) {
          post.thumbnail = post$('meta[property="og:image"]').attr('content') || post.thumbnail;
        }
        return post;
      } catch (_) {
        return post;
      }
    }));

    // prefer posts with video/embed; still return post url fallback so UI not empty
    const withVid = resolved.filter(p => p.videoUrl);
    const valid = withVid.length ? withVid : resolved.filter(p => p.url);
    setCached(cacheKey, valid);
    return valid;
  } catch (err) {
    console.error(`Error scraping IndianPorn365 (Page ${page}):`, err.message);
    return [];
  }
}

export {
  normalizeUrl,
  getRequestHeaders,
  ensureClearance,
  scrapeDesiPorn,
  scrapeMMSBee,
  scrapeDesiPapa,
  scrapeHotpic,
  scrapeViralMms,
  scrapeDesiSexVdo,
  scrapeDesiBabe,
  scrapeDesiHub,
  scrapeDesiBF,
  scrapeDesiLeak49,
  scrapeMastiRaja,
  scrapeLatestDesiMms,
  scrapeMmsGram,
  scrapeIndianPorn365,
  MMSGRAM_FORUMS,
  getCached,
  setCached,
  cache,
  CACHE_TTL
};
