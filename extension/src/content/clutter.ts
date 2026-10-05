// Clutter skipping (F03): ads, cookie banners and navigation the page repeats are left out
// of the snapshot, so the assistant reads the page the user came for. The snapshot counts
// what was dropped in flags.clutter_removed.

/** Words in an id or class name that mark an advert. Whole words only, so "add" and "head" pass. */
const AD_WORDS = new Set([
  'ad',
  'ads',
  'adv',
  'advert',
  'adverts',
  'advertisement',
  'advertising',
  'sponsored',
  'adslot',
  'adunit',
  'adbox',
  'adsense',
  'adsbygoogle',
  'adcontainer',
  'adwrapper',
  'dfp',
  'gpt',
]);
const AD_ATTRIBUTES = ['data-ad', 'data-ad-slot', 'data-ad-unit', 'data-ad-client', 'data-adunit'];
const AD_LABEL = /^(ad|ads|advert|advertisement|sponsored|sponsored content)$/i;

const CONSENT_WORDS = new Set([
  'cookie',
  'cookies',
  'consent',
  'gdpr',
  'ccpa',
  'cmp',
  'onetrust',
  'cookiebot',
  'cookielaw',
]);
const COOKIE_TEXT = /\bcookies?\b/i;
const ACCEPT_TEXT = /\b(accept|agree|allow|got it|ok|okay|i understand|reject|decline)\b/i;
/** A cookie banner is short. Anything longer is likely a page about cookies. */
const MAX_BANNER_TEXT = 1500;
/** Elements that hold the page's own content; never clutter, whatever their class says. */
const CONTENT_TAGS = new Set(['main', 'article', 'body', 'html']);

/** A navigation block repeats an earlier one when this share of its links was already listed. */
const REPEAT_SHARE = 0.8;
const MIN_REPEATED_LINKS = 3;

export type ClutterKind = 'ad' | 'cookie_banner' | 'repeated_nav';

/** Splits ids and class names into lowercase words: "topAdSlot", "top-ad_slot" -> top ad slot. */
function nameWords(el: Element): string[] {
  const raw = `${el.id} ${el.getAttribute('class') ?? ''}`;
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isAd(el: Element): boolean {
  if (CONTENT_TAGS.has(el.localName)) return false;
  let marked = el.localName === 'ins' && el.classList.contains('adsbygoogle');
  marked ||= AD_ATTRIBUTES.some((name) => el.hasAttribute(name));
  const label = el.getAttribute('aria-label') ?? el.getAttribute('aria-roledescription') ?? '';
  marked ||= AD_LABEL.test(label.trim());
  marked ||= nameWords(el).some((word) => AD_WORDS.has(word));
  // A wrapper such as <div class="page-with-ads"> that holds the page itself is not an ad.
  return marked && !el.querySelector('main, article, h1');
}

/**
 * A cookie or consent notice: named like one and talking about cookies or consent, or a
 * dialog or pinned box about cookies with a button to accept or reject them.
 */
export function isCookieBanner(el: Element): boolean {
  if (CONTENT_TAGS.has(el.localName)) return false;
  const named = nameWords(el).some((word) => CONSENT_WORDS.has(word));
  // Cheap checks first: reading textContent on every element would be quadratic.
  if (!named && !isOverlay(el)) return false;
  const text = el.textContent ?? '';
  if (text.length > MAX_BANNER_TEXT || !COOKIE_TEXT.test(text)) return false;
  if (named) return true;
  return Array.from(el.querySelectorAll('button, [role="button"], a, input[type="button"]')).some(
    (button) => ACCEPT_TEXT.test(button.textContent || (button as HTMLInputElement).value || ''),
  );
}

function isOverlay(el: Element): boolean {
  const role = el.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog' || el.localName === 'dialog') return true;
  const position = el.ownerDocument.defaultView?.getComputedStyle(el).position;
  return position === 'fixed' || position === 'sticky';
}

/** Remembers the links of the navigation blocks seen so far, to spot one that repeats them. */
export class NavigationMemory {
  private readonly seen = new Set<string>();

  /** Returns true when `nav` repeats earlier navigation; otherwise remembers its links. */
  isRepeat(nav: Element): boolean {
    const names = linkNames(nav);
    if (names.length >= MIN_REPEATED_LINKS) {
      const known = names.filter((name) => this.seen.has(name)).length;
      if (known / names.length >= REPEAT_SHARE) return true;
    }
    for (const name of names) this.seen.add(name);
    return false;
  }
}

function linkNames(nav: Element): string[] {
  const names = Array.from(nav.querySelectorAll('a[href]'), (link) =>
    (link.getAttribute('aria-label') || link.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase(),
  ).filter(Boolean);
  return [...new Set(names)];
}

/** Classifies `el` as clutter, or returns null. `role` is the element's computed role. */
export function clutterKind(
  el: Element,
  role: string | null,
  navigation: NavigationMemory,
): ClutterKind | null {
  if (isAd(el)) return 'ad';
  if (isCookieBanner(el)) return 'cookie_banner';
  if (role === 'navigation' && navigation.isRepeat(el)) return 'repeated_nav';
  return null;
}
