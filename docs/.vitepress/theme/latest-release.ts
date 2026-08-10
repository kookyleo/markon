export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface MarkonRelease {
  tag: string;
  version: string;
  htmlUrl: string;
  publishedAt: string;
  assets: ReleaseAsset[];
}

interface GitHubAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

const LATEST_RELEASE_API =
  'https://api.github.com/repos/kookyleo/markon/releases/latest';

let pendingRelease: Promise<MarkonRelease | null> | null = null;

function isUserFacingAsset(name: string): boolean {
  return !name.endsWith('.sig')
    && !name.endsWith('.json')
    && !/\.(app|AppImage|nsis)\.(tar\.gz|zip)$/.test(name);
}

function normalizeRelease(data: GitHubRelease): MarkonRelease | null {
  if (
    typeof data.tag_name !== 'string'
    || typeof data.html_url !== 'string'
    || typeof data.published_at !== 'string'
    || !Array.isArray(data.assets)
  ) {
    return null;
  }

  const assets = data.assets.flatMap((candidate: GitHubAsset) => {
    if (
      typeof candidate.name !== 'string'
      || typeof candidate.browser_download_url !== 'string'
      || typeof candidate.size !== 'number'
      || !isUserFacingAsset(candidate.name)
    ) {
      return [];
    }
    return [{
      name: candidate.name,
      url: candidate.browser_download_url,
      size: candidate.size,
    }];
  });

  return {
    tag: data.tag_name,
    version: data.tag_name.replace(/^v/, ''),
    htmlUrl: data.html_url,
    publishedAt: data.published_at,
    assets,
  };
}

async function requestLatestRelease(): Promise<MarkonRelease | null> {
  try {
    const response = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return null;
    return normalizeRelease(await response.json() as GitHubRelease);
  } catch {
    return null;
  }
}

/**
 * Resolve the current stable release once per page load. The documentation
 * build embeds a release snapshot for immediate rendering; this live request
 * replaces it after hydration so a new release never requires a docs rebuild.
 */
export function fetchLatestRelease(): Promise<MarkonRelease | null> {
  pendingRelease ??= requestLatestRelease();
  return pendingRelease;
}
