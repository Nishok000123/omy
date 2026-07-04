import axios from 'axios';
import * as cheerio from 'cheerio';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

const cache = {};
const CACHE_TTL = 60 * 60 * 1000; // 1 hour cache duration
const DEFAULT_TIMEOUT = 15000;

async function axiosGetWithRetry(url, options = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
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
  const iframeSrc = post$('iframe[src*="player-x.php"]').attr('src');
  if (iframeSrc) {
    try {
      const urlObj = new URL(iframeSrc);
      const q = urlObj.searchParams.get('q');
      if (q) {
        const decoded = Buffer.from(q, 'base64').toString('utf8');
        const match = decoded.match(/src=["'](https?:\/\/[^"']+)["']/);
        if (match) return match[1];
      }
    } catch (e) {
      // Ignore URL parsing errors
    }
  }
  return null;
}

/**
 * Scrapes Kamaclips.com
 */
async function scrapeKamaClips(page = 1, searchTerm = '', limit = 10) {
  const cacheKey = `kamaclips_${page}_${searchTerm || 'default'}_l${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const baseUrl = 'https://kamaclips.com';
  let url = '';
  if (searchTerm) {
    url = page === 1 
      ? `${baseUrl}/?s=${encodeURIComponent(searchTerm)}` 
      : `${baseUrl}/page/${page}/?s=${encodeURIComponent(searchTerm)}`;
  } else {
    url = page === 1 ? baseUrl : `${baseUrl}/page/${page}/`;
  }

  try {
    const res = await axiosGetWithRetry(url, { headers: HEADERS });
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
          siteName: 'KamaClips'
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
          const postRes = await axiosGetWithRetry(post.url, { headers: HEADERS });
          const post$ = cheerio.load(postRes.data);
          let videoUrl = post$('meta[itemprop="contentURL"]').attr('content');

          if (!videoUrl) {
            const iframeUrl = extractIframeVideoUrl(post$);
            if (iframeUrl) videoUrl = iframeUrl;
          }

          if (!videoUrl) {
            videoUrl = post$('video source').attr('src');
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
    console.error(`Error scraping KamaClips (Page ${page}, Search: ${searchTerm}):`, err.message);
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
    const res = await axiosGetWithRetry(url, { headers: HEADERS });
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
                  siteName: 'ViralMMS'
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
            siteName: 'ViralMMS'
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
            const postRes = await axiosGetWithRetry(post.url, { headers: HEADERS });
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
    const res = await axiosGetWithRetry(url, { headers: HEADERS });
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
          siteName: 'DesiSexVdo'
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
          const postRes = await axiosGetWithRetry(post.url, { headers: HEADERS });
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
    const res = await axiosGetWithRetry(url, { headers: HEADERS });
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
                  siteName: siteName
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
            siteName: siteName
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
          const postRes = await axiosGetWithRetry(post.url, { headers: HEADERS });
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
    const res = await axiosGetWithRetry(url, { headers: HEADERS });
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
                  siteName: 'DesiHub'
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
            siteName: 'DesiHub'
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
          const postRes = await axiosGetWithRetry(post.url, { headers: HEADERS });
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
    const res = await axiosGetWithRetry(url, { headers: HEADERS });
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
          siteName: 'DesiBF'
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
          const postRes = await axiosGetWithRetry(post.url, { headers: HEADERS });
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
    const res = await axiosGetWithRetry(url, { headers: HEADERS });
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
                  siteName: 'DesiLeak49'
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
            siteName: 'DesiLeak49'
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
          const postRes = await axiosGetWithRetry(post.url, { headers: HEADERS });
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
    const res = await axiosGetWithRetry(url, { headers: HEADERS });
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
          siteName: 'MastiRaja'
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
          const postRes = await axiosGetWithRetry(post.url, { headers: HEADERS });
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

export {
  normalizeUrl,
  scrapeKamaClips,
  scrapeViralMms,
  scrapeDesiSexVdo,
  scrapeDesiBabe,
  scrapeDesiHub,
  scrapeDesiBF,
  scrapeDesiLeak49,
  scrapeMastiRaja,
  getCached,
  setCached,
  cache,
  CACHE_TTL
};
