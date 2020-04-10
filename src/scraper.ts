import { resolveSelector, getRangeSelector, Selector } from './web-annotation'
import { RangeSelection } from './selection'
import { BlobReader } from './blob-reader'

// Selection that isn't empty
export { Selector }

export type ScrapeData = {
  url: string
  icon: string | null
  hero: string[]
  title: string
  description: string
  name: string

  selector: null | Selector[]
}

export type ArchiveData = {
  url: string
  data: ArrayBuffer
}

const baseURL = (spec: string): string => {
  var url = new URL(spec)
  url.search = ''
  url.hash = ''
  var href = url.href
  return href.endsWith('/') ? href : href + '/'
}

const makeRelative = (url: string): string => './' + url.replace(/:\/\//g, '/')

export type HostMessage =
  | { type: 'scraped'; scraped: ScrapeData }
  | { type: 'archived'; archived: ArchiveData }

export const clip = (document: Document): Promise<ScrapeData> => {
  const selection = RangeSelection.get(document)
  return selection ? clipSelection(selection) : clipSummary(document)
}

export const clipSummary = async (document: Document): Promise<ScrapeData> => {
  /*
      Pull structured content out of the DOM.
      - Hero images
      - Title
      - Summary
      - Site name
      - Article content
      Things we can use:
      - `<title>`
      - meta description
      - Twitter card meta tags
      - Facebook Open Graph tags
      - Win8 Tile meta tags
      - meta description
      - Search snippet things like schema.org
      - microformats
      https://github.com/mozilla/readability
      http://schema.org/CreativeWork
      https://dev.twitter.com/cards/markup
      https://developers.facebook.com/docs/sharing/webmasters#markup
      https://developer.apple.com/library/ios/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html
      http://blogs.msdn.com/b/ie/archive/2014/05/21/support-a-live-tile-for-your-website-on-windows-and-windows-phone-8-1.aspx
      http://www.oembed.com/
      https://developer.chrome.com/multidevice/android/installtohomescreen
      */

  // Utils
  // -----------------------------------------------------------------------------

  // Scraping and content scoring helpers
  // -----------------------------------------------------------------------------

  // @TODO need some methods for scaling and cropping images.

  await loaded(document)

  return {
    url: document.URL,
    icon: scrapeIcon(document.documentElement),
    hero: [...scrapeHeroImgUrls(document.documentElement)],
    title: scrapeTitle(document.documentElement, '').trim(),
    description: scrapeDescription(document.documentElement, '').trim(),
    name: scrapeSiteName(document.documentElement, '').trim(),
    selector: null,
  }
}

export const clipSelection = async (selection: RangeSelection): Promise<ScrapeData> => {
  const { document } = selection
  const url = document.URL
  const icon = scrapeIcon(document.documentElement)
  const title = scrapeTitle(document.documentElement, '').trim()
  const name = scrapeSiteName(document.documentElement, '').trim()
  const [firstRange] = selection.ranges()
  const { commonAncestorContainer } = firstRange

  // First try scraping images from content, then fall back to scraping from the document.
  // We just pick the first one.
  let imgs =
    commonAncestorContainer.nodeType !== Node.ELEMENT_NODE
      ? []
      : [
          ...findHeroImgUrls(
            <HTMLElement>commonAncestorContainer,
            (image) => selection.selection.containsNode(image) && isImgSizeAtLeast(image, 200, 100)
          ),
        ]

  const images = concat([imgs, scrapeHeroImgUrls(document.documentElement)])
  const hero = [...take(1, images)]
  const description = selection.toText().trim()
  const selector = getRangeSelector(firstRange)

  return { url, icon, hero, title, description, name, selector: [selector] }
}

const loaded = (document: Document) =>
  new Promise((resolve) => {
    if (document.readyState === 'complete') {
      resolve()
    } else {
      const listener = (_event: Event) => {
        document.removeEventListener('load', listener)
        resolve()
      }

      document.addEventListener('load', listener)
    }
  })

// Function

const identity = <a>(x: a): a => x

// Iterables

const filter = function* <a>(p: (item: a) => boolean, source: Iterable<a>): Iterable<a> {
  for (const item of source) {
    if (p(item)) {
      yield item
    }
  }
}

const map = function* <a, b>(f: (item: a) => b, source: Iterable<a>): Iterable<b> {
  for (const item of source) {
    yield f(item)
  }
}

const reduce = <a, b>(reducer: (item: a, state: b) => b, state: b, items: Iterable<a>): b => {
  let result = state
  for (const item of items) {
    result = reducer(item, state)
  }
  return result
}

const concat = function* <a>(iterables: Iterable<Iterable<a>>): Iterable<a> {
  for (const iterable of iterables) {
    for (const item of iterable) {
      yield item
    }
  }
}

const take = function* <a>(n: number, iterable: Iterable<a>): Iterable<a> {
  if (n > 0) {
    let count = 0
    for (const item of iterable) {
      yield item
      if (++count >= n) {
        break
      }
    }
  }
}

const first = <a>(iterable: Iterable<a>, fallback: a): a => {
  for (const item of iterable) {
    return item
  }
  return fallback
}

// DOM

const query = function* <a>(
  selector: string,
  decode: (el: Element) => null | a,
  root: Document | Element | DocumentFragment
): Iterable<a> {
  const elements = [...(<any>root.querySelectorAll(selector))]
  for (const element of elements) {
    const data = decode(element)
    if (data != null) {
      yield data
    }
  }
}

const getText = ({ textContent }: Element): string => textContent || ''

const getContent = (metaEl: Element): string | null =>
  !(metaEl instanceof HTMLMetaElement) ? null : metaEl.content == '' ? null : metaEl.content

const getSrc = (imgEl: HTMLImageElement): string => imgEl.src

const getHref = (linkEl: Element): string | null =>
  linkEl instanceof HTMLLinkElement ? linkEl.href : null

// Does element match a particular tag name?
const matchesTag = (el: Element, pattern: RegExp) => el.tagName.search(pattern) !== -1

const matchesClass = (el: Element, pattern: RegExp) => el.className.search(pattern) !== -1

// Scraper

// Score the content-y-ness of a string. Note that this is an imperfect score
// and you'll be better off if you combine it with other heuristics like
// element classname, etc.
const scoreContentyness = (text: string) => {
  // If paragraph is less than 25 characters, don't count it.
  if (text.length < 25) return 0

  // Ok, we've weeded out the no-good cases. Start score at one.
  var score = 1

  // Add points for any commas within.
  score = score + text.split(',').length

  // For every 100 characters in this paragraph, add another point.
  // Up to 3 points.
  score = score + Math.min(Math.floor(text.length / 100), 3)

  return score
}

// Score a child element to find out how "content-y" it is.
// A score is determined by things like number of commas, etc.
// Maybe eventually link density.
const scoreElContentyness = (el: Element) => scoreContentyness(getText(el))
const isSufficientlyContenty = (el: Element, base = 3) => scoreElContentyness(el) > base

const UNLIKELY_CONTENT_CLASSNAMES = /date|social|community|remark|discuss|disqus|e[\-]?mail|rss|print|extra|share|login|sign|reply|combx|comment|com-|contact|header|menu|foot|footer|footnote|masthead|media|meta|outbrain|promo|related|scroll|shoutbox|sidebar|sponsor|shopping|tags|tool|widget|sidebar|sponsor|ad-break|agegate|pagination|pager|popup|tweet|twitter/i

const isUnlikelyCandidate = (el: Element) => matchesClass(el, UNLIKELY_CONTENT_CLASSNAMES)

const countWords = (text: string) => text.split(/\s/).length

// Is text long enough to be content?
const isSufficientlyLong = (text: string) => text.length > 25
const isTextSufficientlyLong = (el: Element) => isSufficientlyLong(getText(el))
const isntEmpty = (text: string) => text != ''

const getElTextLength = (el: Element) => getText(el).length
const sum = (a: number, b: number) => a + b

// Calculat the density of links in content.
const calcLinkDensity = (el: Element) => {
  const linkSizes = query('a', getElTextLength, el)
  const linkSize = reduce(sum, 0, linkSizes)
  const textSize = getElTextLength(el)

  return linkSize / textSize
}

// Is the link density of this element high?
const isHighLinkDensity = (el: Element) => calcLinkDensity(el) > 0.5

// Extract a clean title from text that has been littered with separator
// garbage.
const cleanTitle = (text: string): string => {
  var title = text
  if (text.match(/\s[\|\-:]\s/)) {
    title = text.replace(/(.*)[\|\-:] .*/gi, '$1')

    if (countWords(title) < 3) {
      title = text.replace(/[^\|\-]*[\|\-](.*)/gi, '$1')
    }

    // Fall back to title if word count is too short.
    if (countWords(title) < 5) {
      title = text
    }
  }

  // Trim spaces.
  return title.trim()
}

const getCleanText = (el: Element) => cleanTitle(getText(el))

// Content scrapers
// -----------------------------------------------------------------------------

// Find a good title within page.
// Usage: `scrapeTitle(htmlEl, 'Untitled')`.
const scrapeTitle = (el: Element, fallback = 'Untitled'): string => {
  const candidates = concat([
    query('meta[property="og:title"], meta[name="twitter:title"]', getContent, el),

    // Query hentry Microformats. Note that we just grab the blog title,
    // even on a blog listing page. You're going to associate the first title
    // with the identity of the page because it's the first thing you see on
    // the page when it loads.
    query('.entry-title, .h-entry .p-name', getText, el),
    // @TODO look at http://schema.org/Article `[itemprop=headline]`
    query('title', getCleanText, el),
    // If worst comes to worst, fall back on headings.
    query('h1, h2, h3', getText, el),
    [fallback],
  ])

  return first(candidates, fallback)
}

const scrapeDescriptionFromContent = (pageEl: Element, fallback: string) => {
  // Query for all paragraphs on the page.
  // Trim down paragraphs to the ones we deem likely to be content.
  // Then map to `textContent`.

  const paragraphs = query('p', identity, pageEl)

  const isQualified = (p: Element) => {
    const qualified =
      !isUnlikelyCandidate(p) &&
      isTextSufficientlyLong(p) &&
      !isHighLinkDensity(p) &&
      isSufficientlyContenty(p)

    return qualified
  }

  const qualified = filter(isQualified, paragraphs)
  return map(getText, qualified)
}

// Find a good description for the page.
// Usage: `scrapeDescription(htmlEl, '')`.
const scrapeDescription = (el: Element, fallback: string) => {
  const candidates = concat([
    // Prefer social media descriptions to `meta[name=description]` because they
    // are curated for readers, not search bots.
    query('meta[name="twitter:description"]', getContent, el),
    query('meta[property="og:description"]', getContent, el),
    // Scrape hentry Microformat description.
    query('.entry-summary, .h-entry .p-summary', getText, el),
    // @TODO process description to remove garbage from descriptions.
    query('meta[name=description]', getContent, el),
    // @TODO look at http://schema.org/Article `[itemprop=description]`
    scrapeDescriptionFromContent(el, fallback),
  ])

  return first(candidates, fallback)
}

// You probably want to use the base URL as fallback.
const scrapeSiteName = (el: Element, fallback: string) => {
  const candidates = concat([
    // Prefer the standard meta tag.
    query('meta[name="application-name"]', getContent, el),
    query('meta[property="og:site_name"]', getContent, el),
    // Note that this one is an `@name`.
    query('meta[name="twitter:site"]', getContent, el),
    [fallback],
  ])

  return first(candidates, fallback)
}

const isImgSizeAtLeast = (imgEl: HTMLImageElement, w: number, h: number) =>
  imgEl.naturalWidth > w && imgEl.naturalHeight > h

const isImgHeroSize = (imgEl: HTMLImageElement) => isImgSizeAtLeast(imgEl, 480, 300)

// Collect Twitter image urls from meta tags.
// Returns an array of 1 or more Twitter img urls, or null.
// See https://dev.twitter.com/cards/markup.
const queryTwitterImgUrls = (pageEl: Document | Element | DocumentFragment) =>
  query(
    `
    meta[name="twitter:image"],
    meta[name="twitter:image:src"],
    meta[name="twitter:image0"],
    meta[name="twitter:image1"],
    meta[name="twitter:image2"],
    meta[name="twitter:image3"]
    `,
    getContent,
    pageEl
  )

// Collect Facebook Open Graph image meta tags.
// Returns an aray of 0 or more meta elements.
// These 2 meta tags are equivalent. If the first doesn't exist, look for
// the second.
// See https://developers.facebook.com/docs/sharing/webmasters#images.
const queryOpenGraphImgUrls = (el: Document | Element | DocumentFragment) =>
  query(
    `
    meta[property="og:image"],
    meta[property="og:image:url"]
    `,
    getContent,
    el
  )

const findHeroImgUrls = (
  pageEl: Document | Element | DocumentFragment,
  isQualified: (image: HTMLImageElement) => boolean = isImgHeroSize
) => {
  const candidates = <Iterable<HTMLImageElement>>query('img', identity, pageEl)
  const heroSized = filter(isQualified, candidates)
  const urls = map(getSrc, heroSized)

  // can be a lot of images we limit to 4
  return take(4, filter(isntEmpty, urls))
}

// Scrape up to 4 featured images.
// We favor meta tags like `twitter:image` and `og:image` because those are
// hand-curated. If we don't them, we'll dig through the content ourselves.
// Returns an array of image urls.
// @TODO it might be better just to grab everything, then de-dupe URLs.
const scrapeHeroImgUrls = (el: Document | Element | DocumentFragment) => {
  // Note that Facebook OpenGraph image queries are kept seperate from Twitter
  // image queries. This is to prevent duplicates when sites include both.
  // If we find Twitter first, we'll return it and never look for Facebook.
  // We'll favor Twitter image URLs, since there can be more than one.
  const all = concat([queryOpenGraphImgUrls(el), queryTwitterImgUrls(el), findHeroImgUrls(el)])

  return all
}

enum IconRel {
  icon = 'icon',
  shortcutIcon = 'shortcut icon',
  appleTouchIcon = 'apple-touch-icon',
  appleTouchIconPrecomposed = 'apple-touch-icon-precomposed',
  maskIcon = 'mask-icon',
}

type Size = [number, number]

class Icon {
  sourceElement: HTMLLinkElement
  blobCache: null | Blob | Promise<Blob>
  static decode(link: Element) {
    if (link.tagName === 'LINK') {
      return new Icon(<HTMLLinkElement>link)
    } else {
      return null
    }
  }
  constructor(link: HTMLLinkElement) {
    this.sourceElement = link
    this.blobCache = null
  }
  get type(): string {
    return this.sourceElement.type
  }
  get rel(): IconRel {
    return <IconRel>this.sourceElement.rel
  }
  get href() {
    return this.sourceElement.href
  }
  *sizes(): Iterable<Size> {
    const {
      sourceElement: { sizes },
    } = this
    let index = 0
    while (index < sizes.length) {
      const entry = sizes[index]
      if (entry.toLowerCase() === 'any') {
        yield [Infinity, Infinity]
      } else {
        const [width, height] = entry.split('x')
        yield [parseInt(width), parseInt(height)]
      }
    }
  }
  async toBlob(): Promise<Blob> {
    if (!this.blobCache) {
      this.blobCache = fetchBlob(this.href, {
        cache: 'force-cache',
        redirect: 'follow',
      })
    }
    return this.blobCache
  }
  async toBlobURL() {
    const blob = await this.toBlob()
    return URL.createObjectURL(blob)
  }
  async toDataURL(): Promise<string> {
    const blob = await this.toBlob()
    return await BlobReader.readAsDataURL(blob)
  }
}

const fetchBlob = async (input: RequestInfo, init?: RequestInit | undefined): Promise<Blob> => {
  const response = await fetch(input, init)
  const blob = await response.blob()
  return blob
}

const scrapeIcons = (el: HTMLElement): Iterable<Icon> =>
  query(
    `
    link[rel="shortcut icon"],
    link[rel="apple-touch-icon"],
    link[rel="apple-touch-icon-precomposed"]
    link[rel="mask-icon"],
    link[rel="icon"]
    `,
    Icon.decode,
    el
  )

const scrapeIcon = (el: HTMLElement): string | null =>
  first(
    map(({ href }) => href, scrapeIcons(el)),
    null
  )

// If we have 4 or more images, we show 4 images in combination.
// Otherwise, use the first featured image only.
const isImgCombo = (imgUrls: string[]) => imgUrls.length > 3
