import { warn } from './logger.ts';

/**
 * Quote Collapse Utility
 *
 * Detects and wraps quoted text in email bodies for collapsible display.
 * Supports common email quoting patterns from various email clients.
 */

// Patterns for detecting quote attribution lines
const QUOTE_ATTRIBUTION_PATTERNS = [
  // "On [date], [name] wrote:" - Gmail, Apple Mail
  /^On\s+.+\s+wrote:\s*$/i,
  // "On [date] at [time], [name] wrote:"
  /^On\s+.+\s+at\s+.+\s+wrote:\s*$/i,
  // "[date], [name] wrote:"
  /^.+\s+wrote:\s*$/i,
  // "From: [email]" - Forward headers
  /^From:\s+.+$/i,
  // "Sent:" header
  /^Sent:\s+.+$/i,
  // "[name] <[email]> wrote:"
  /^.+<.+@.+>\s+wrote:\s*$/i,
];

// Patterns for quote separators
const QUOTE_SEPARATOR_PATTERNS = [
  // "-----Original Message-----"
  /^-{3,}\s*Original\s+Message\s*-{3,}$/i,
  // "___" separator lines (Outlook)
  /^_{10,}$/,
  // "---" separator
  /^-{10,}$/,
  // "***" separator
  /^\*{10,}$/,
  // "Forwarded message" header
  /^-{2,}\s*Forwarded\s+message\s*-{2,}$/i,
  // "Begin forwarded message:"
  /^Begin\s+forwarded\s+message:\s*$/i,
];

/**
 * Check if a text line looks like a quote attribution
 */
const isQuoteAttribution = (text) => {
  const trimmed = (text || '').trim();
  return QUOTE_ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(trimmed));
};

/**
 * Check if a text line is a quote separator
 */
const isQuoteSeparator = (text) => {
  const trimmed = (text || '').trim();
  return QUOTE_SEPARATOR_PATTERNS.some((pattern) => pattern.test(trimmed));
};

/**
 * Check if text starts with quote markers (> character)
 */
const hasQuoteMarkers = (text) => {
  return /^[>\s]*>/.test(text || '');
};

/**
 * Process HTML content and wrap quoted sections in collapsible containers
 *
 * @param {string} html - The HTML content to process
 * @param {object} options - Processing options
 * @param {boolean} options.collapseByDefault - Whether quotes should be collapsed by default (true)
 * @returns {string} - Processed HTML with collapsible quote sections
 */
export function processQuotedContent(html, options = {}) {
  const { collapseByDefault = true } = options;

  if (!html || typeof html !== 'string') {
    return html || '';
  }

  // Use DOMParser if available (browser environment)
  if (typeof DOMParser === 'undefined') {
    return html;
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    let hasQuotes = false;

    // 1. Find known quote containers and attribution prefixes FIRST, each
    //    grouped with the quote siblings that follow it. Order matters twice
    //    over here, and both lessons were learned from shipped misformats:
    //    - A Thunderbird reply is a moz-cite-prefix div FOLLOWED BY a sibling
    //      blockquote. Wrapping bare blockquotes first left the prefix to be
    //      wrapped on its own, stacking two collapse toggles per reply.
    //    - A Gmail reply nests its blockquote INSIDE div.gmail_quote. Wrapping
    //      the inner blockquote first and the container second produced a
    //      wrapper inside a wrapper, with a second toggle hidden in the
    //      collapsed content.
    const containerQuotes = doc.querySelectorAll(
      '.gmail_quote, .gmail_extra, [class*="gmail_quote"], .yahoo_quoted, .moz-cite-prefix, .OutlookMessageHeader, [class*="quoted"]',
    );
    containerQuotes.forEach((quote) => {
      if (quote.closest('.fe-quote-wrapper')) return;
      // Only OUTERMOST quote boundaries get a toggle. A title or attribution
      // line already inside a blockquote (or inside another client's quote
      // container) is part of that quote's content; wrapping it separately
      // plants a second collapsible inside the first.
      if (
        quote.parentElement?.closest(
          'blockquote, .gmail_quote, .gmail_extra, [class*="gmail_quote"], .yahoo_quoted, [class*="quoted"]',
        )
      ) {
        return;
      }
      hasQuotes = true;
      const group = [quote, ...collectQuotedSiblings(quote)];
      wrapElementsInCollapsible(group, doc, collapseByDefault);
    });

    // 2. Wrap any remaining bare <blockquote> elements (cite quotes from
    //    clients without a recognized container or prefix).
    const blockquotes = doc.querySelectorAll('blockquote');
    blockquotes.forEach((bq) => {
      // Skip if already wrapped
      if (bq.closest('.fe-quote-wrapper')) return;

      // Skip if it's our own reply/forward quote (from compose)
      if (bq.classList.contains('fe-reply-quote') || bq.classList.contains('fe-forward-quote')) {
        return;
      }

      hasQuotes = true;
      wrapInCollapsible(bq, doc, collapseByDefault);
    });

    // 4. Look for text-based quote patterns in the content
    // Find paragraphs or divs that contain attribution lines
    const allElements = doc.body.querySelectorAll('p, div');
    allElements.forEach((el) => {
      if (el.closest('.fe-quote-wrapper')) return;

      const text = el.textContent || '';

      // Check for attribution line followed by quoted content
      if (isQuoteAttribution(text) || isQuoteSeparator(text)) {
        // Try to find all following siblings that are part of the quote
        const quotedElements = collectQuotedSiblings(el);
        if (quotedElements.length > 0) {
          hasQuotes = true;
          wrapElementsInCollapsible([el, ...quotedElements], doc, collapseByDefault);
        }
      }
    });

    // 5. Handle plain text quotes (lines starting with >)
    processPlainTextQuotes(doc, collapseByDefault);

    if (!hasQuotes) {
      return html;
    }

    // If the message is entirely quoted content, expand it instead of collapsing.
    const bodyClone = doc.body.cloneNode(true);
    bodyClone.querySelectorAll('.fe-quote-wrapper').forEach((el) => el.remove());
    const hasNonQuoteContent = (bodyClone.textContent || '').trim().length > 0;
    if (!hasNonQuoteContent) {
      doc.querySelectorAll('.fe-quote-wrapper.fe-quote-collapsed').forEach((wrapper) => {
        wrapper.classList.remove('fe-quote-collapsed');
        const label = wrapper.querySelector('.fe-quote-label');
        if (label) label.textContent = 'Hide quoted text';
      });
    }

    return doc.body.innerHTML;
  } catch (err) {
    warn('[quote-collapse] Failed to process quoted content:', err);
    return html;
  }
}

/**
 * Wrap an element in a collapsible quote container
 */
function wrapInCollapsible(element, doc, collapsed) {
  const wrapper = doc.createElement('div');
  wrapper.className = `fe-quote-wrapper${collapsed ? ' fe-quote-collapsed' : ''}`;

  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'fe-quote-toggle';
  toggle.setAttribute('data-action', 'toggle-quote');
  toggle.innerHTML = `<span class="fe-quote-dots">...</span><span class="fe-quote-label">${collapsed ? 'Show quoted text' : 'Hide quoted text'}</span>`;

  const content = doc.createElement('div');
  content.className = 'fe-quote-content';

  // Move the element into the content container
  element.parentNode.insertBefore(wrapper, element);
  content.appendChild(element);
  wrapper.appendChild(toggle);
  wrapper.appendChild(content);
}

/**
 * Wrap multiple elements in a single collapsible container
 */
function wrapElementsInCollapsible(elements, doc, collapsed) {
  if (!elements.length) return;

  const firstElement = elements[0];
  const wrapper = doc.createElement('div');
  wrapper.className = `fe-quote-wrapper${collapsed ? ' fe-quote-collapsed' : ''}`;

  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'fe-quote-toggle';
  toggle.setAttribute('data-action', 'toggle-quote');
  toggle.innerHTML = `<span class="fe-quote-dots">...</span><span class="fe-quote-label">${collapsed ? 'Show quoted text' : 'Hide quoted text'}</span>`;

  const content = doc.createElement('div');
  content.className = 'fe-quote-content';

  // Insert wrapper before first element
  firstElement.parentNode.insertBefore(wrapper, firstElement);

  // Move all elements into content
  elements.forEach((el) => {
    content.appendChild(el);
  });

  wrapper.appendChild(toggle);
  wrapper.appendChild(content);
}

/**
 * Collect sibling elements that appear to be part of quoted content
 */
function collectQuotedSiblings(startElement) {
  const siblings = [];
  let current = startElement.nextElementSibling;
  let foundQuotedContent = false;

  while (current) {
    // Stop if we hit another quote wrapper
    if (current.classList?.contains('fe-quote-wrapper')) break;

    // Check if this looks like quoted content
    const isBlockquote = current.tagName === 'BLOCKQUOTE';
    const hasQuoteClass =
      current.classList?.contains('gmail_quote') ||
      current.classList?.contains('yahoo_quoted') ||
      current.classList?.contains('moz-cite-prefix');
    const textStartsWithMarker = hasQuoteMarkers(current.textContent);

    if (isBlockquote || hasQuoteClass || textStartsWithMarker) {
      foundQuotedContent = true;
      siblings.push(current);
    } else if (foundQuotedContent) {
      // Once we've found quoted content, include subsequent elements
      // until we hit a clear break (empty line or new content)
      const text = (current.textContent || '').trim();
      if (!text) {
        // Empty element, might be spacing - include it
        siblings.push(current);
      } else if (isQuoteAttribution(text) || isQuoteSeparator(text)) {
        // Another quote section starts
        siblings.push(current);
      } else {
        // Real content after quote, stop here
        break;
      }
    } else {
      // Check if we're still in the attribution area
      const text = (current.textContent || '').trim();
      if (!text || text.length < 100) {
        // Short content after attribution, might be part of header
        siblings.push(current);
      } else {
        break;
      }
    }

    current = current.nextElementSibling;
  }

  return siblings;
}

/**
 * Process plain text quotes (lines starting with >)
 */
function processPlainTextQuotes(doc, collapsed) {
  // Find <pre> or plain text blocks with > markers
  const preBlocks = doc.querySelectorAll('pre');
  preBlocks.forEach((pre) => {
    if (pre.closest('.fe-quote-wrapper')) return;

    const lines = pre.textContent.split('\n');
    let hasQuotedLines = false;
    let firstQuotedIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      if (hasQuoteMarkers(lines[i])) {
        hasQuotedLines = true;
        if (firstQuotedIndex === -1) firstQuotedIndex = i;
      }
    }

    if (hasQuotedLines && firstQuotedIndex > -1) {
      // Split content into non-quoted and quoted parts
      const beforeQuote = lines.slice(0, firstQuotedIndex).join('\n');
      const quotedPart = lines.slice(firstQuotedIndex).join('\n');

      if (quotedPart.trim()) {
        // Create new structure
        const container = doc.createElement('div');

        if (beforeQuote.trim()) {
          const beforePre = doc.createElement('pre');
          beforePre.textContent = beforeQuote;
          container.appendChild(beforePre);
        }

        const wrapper = doc.createElement('div');
        wrapper.className = `fe-quote-wrapper${collapsed ? ' fe-quote-collapsed' : ''}`;

        const toggle = doc.createElement('button');
        toggle.type = 'button';
        toggle.className = 'fe-quote-toggle';
        toggle.setAttribute('data-action', 'toggle-quote');
        toggle.innerHTML = `<span class="fe-quote-dots">...</span><span class="fe-quote-label">${collapsed ? 'Show quoted text' : 'Hide quoted text'}</span>`;

        const content = doc.createElement('div');
        content.className = 'fe-quote-content';
        const quotedPre = doc.createElement('pre');
        quotedPre.textContent = quotedPart;
        content.appendChild(quotedPre);

        wrapper.appendChild(toggle);
        wrapper.appendChild(content);
        container.appendChild(wrapper);

        pre.parentNode.replaceChild(container, pre);
      }
    }
  });
}

/**
 * Initialize quote toggle handlers on a container element
 * Call this after inserting processed HTML into the DOM
 *
 * @param {HTMLElement} container - The container element with quote wrappers
 */
export function initQuoteToggles(container) {
  if (!container) return;

  container.querySelectorAll('.fe-quote-toggle').forEach((toggle) => {
    // Remove existing listener to avoid duplicates
    toggle.removeEventListener('click', handleQuoteToggle);
    toggle.addEventListener('click', handleQuoteToggle);
  });
}

/**
 * Handle quote toggle click
 */
function handleQuoteToggle(event) {
  event.preventDefault();
  event.stopPropagation();

  const toggle = event.currentTarget;
  const wrapper = toggle.closest('.fe-quote-wrapper');
  if (!wrapper) return;

  const isCollapsed = wrapper.classList.contains('fe-quote-collapsed');
  wrapper.classList.toggle('fe-quote-collapsed');

  const label = toggle.querySelector('.fe-quote-label');
  if (label) {
    label.textContent = isCollapsed ? 'Hide quoted text' : 'Show quoted text';
  }
}

/**
 * Expand all quotes in a container
 */
export function expandAllQuotes(container) {
  if (!container) return;
  container.querySelectorAll('.fe-quote-wrapper.fe-quote-collapsed').forEach((wrapper) => {
    wrapper.classList.remove('fe-quote-collapsed');
    const label = wrapper.querySelector('.fe-quote-label');
    if (label) label.textContent = 'Hide quoted text';
  });
}

/**
 * Collapse all quotes in a container
 */
export function collapseAllQuotes(container) {
  if (!container) return;
  container.querySelectorAll('.fe-quote-wrapper:not(.fe-quote-collapsed)').forEach((wrapper) => {
    wrapper.classList.add('fe-quote-collapsed');
    const label = wrapper.querySelector('.fe-quote-label');
    if (label) label.textContent = 'Show quoted text';
  });
}
