<script lang="ts" module>
  // Measured heights by message, shared by every instance and kept across
  // remounts (the reader skeleton, a desktop tab switch, the threaded view),
  // so reopening a message reserves its real height instead of starting at
  // the default and snapping.
  const heightCache = new Map<string, number>();
  const HEIGHT_CACHE_MAX = 500;

  function rememberHeight(key: string, height: number) {
    heightCache.delete(key);
    heightCache.set(key, height);
    if (heightCache.size > HEIGHT_CACHE_MAX) {
      const oldest = heightCache.keys().next().value;
      if (oldest !== undefined) heightCache.delete(oldest);
    }
  }

  let documentCounter = 0;
</script>

<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { buildIframeSrcdoc } from '../../utils/iframe-srcdoc';
  import { htmlToPlainText } from '../../utils/sanitize.js';
  import { isTauri, isTauriDesktop } from '../../utils/platform.js';
  import { describeLinkTarget, type LinkPreview } from '../../utils/link-preview';
  import { portal } from '../../utils/portal';

  interface Props {
    html: string;
    messageId: string;
    plainText?: boolean;
    onLinkClick?: (url: string, isMailto: boolean) => void;
    onHeightChange?: (height: number) => void;
    onFormSubmit?: (action: string, method: string, data: Record<string, unknown>) => void;
    onSwipe?: (phase: 'start' | 'move' | 'end', detail: Record<string, unknown>) => void;
  }

  let {
    html,
    messageId,
    plainText = false,
    onLinkClick,
    onHeightChange,
    onFormSubmit,
    onSwipe,
  }: Props = $props();

  // State declarations
  let iframeRef: HTMLIFrameElement | null = $state(null);
  let iframeHeight = $state(600);
  let isDarkMode = $state(false);
  let mounted = $state(false);

  // Track message changes for theme-based recreation
  let themeVersion = $state(0);

  // Link under the pointer (or keyboard focus) inside the iframe, relayed by
  // the runtime. Shown in a status bar pinned to the bottom of the window,
  // where browsers put it. Desktop app only: in a browser the browser's own
  // status bar already shows the target, and two bars in the same corner
  // fight each other. Rendered with text only: the href and link text are
  // untrusted email data.
  const showLinkPreview = isTauriDesktop;
  let linkPreview: LinkPreview | null = $state(null);

  // Track which messages we've already attempted recovery for (prevents loops)
  const recoveryAttempted = new Set<string>();
  let recoveryTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // Detect app's dark mode by checking if body has 'light-mode' class
  function detectDarkMode(): boolean {
    if (typeof document === 'undefined') return false;
    return !document.body.classList.contains('light-mode');
  }

  // Content signature determines when iframe is recreated. Content presence
  // is deliberately NOT part of it: the iframe must survive the body-load
  // clear->refill cycle so a cached revisit updates srcdoc in place instead
  // of tearing down the iframe (which re-fetches every remote image).
  // - messageId: a new frame per message. Swapping one message's document
  //   into the frame of another could leave the frame running the earlier
  //   document while the reader waited on the new one.
  // - themeVersion: recreate on theme change
  // - plainText: recreate to re-measure height for the new rendering mode
  const contentSignature = $derived(`${messageId}:${themeVersion}:${plainText}`);

  const heightKey = $derived(`${messageId}:${plainText ? 'text' : 'html'}`);

  // Build srcdoc — reactively updates when html, dark mode, or plain-text
  // mode changes. The runtime script is loaded from /email-iframe.js (parent
  // origin) and uses `*` as postMessage target; we validate event.source on
  // receive. Each document gets a token the runtime echoes back, so a late
  // height from a document already replaced is not applied. A document that
  // would come out the same keeps its token, so the frame does not reload.
  let lastDoc: { key: string; token: string } | null = null;
  const frameDoc = $derived.by(() => {
    const darkMode = mounted ? isDarkMode : detectDarkMode();
    const source = html || '';
    const key = `${plainText ? 'text' : 'html'}:${darkMode ? 'dark' : 'light'}:${source}`;
    const token = lastDoc?.key === key ? lastDoc.token : `${++documentCounter}`;
    lastDoc = { key, token };
    const doc = plainText
      ? buildIframeSrcdoc(htmlToPlainText(source), darkMode, true, token)
      : buildIframeSrcdoc(source, darkMode, false, token);
    return { doc, token, hasContent: source.length > 0 };
  });
  const srcdoc = $derived(frameDoc.doc);

  // The token of the document that last said it is ready or reported a height
  let readyToken = '';
  let heightToken = '';

  // Measure iframe content height directly via contentDocument.
  // Returns 0 if cross-origin restrictions prevent access.
  //
  // Measure .fe-email-viewport, not .fe-email-content: when the runtime
  // scales a desktop-width email down to fit, the viewport carries the
  // painted height while the content keeps its unscaled layout height.
  function measureIframeHeight(): number {
    if (!iframeRef) return 0;
    try {
      const doc = iframeRef.contentDocument;
      if (!doc) return 0;
      const box = doc.querySelector('.fe-email-viewport') || doc.querySelector('.fe-email-content');
      const boxHeight = box ? box.getBoundingClientRect().height : 0;
      // Not the root element's scrollHeight, which is at least the frame's own
      // height and so never lets the frame shrink (see email-iframe.js).
      return Math.max(
        Math.ceil(boxHeight),
        doc.body?.scrollHeight || 0,
        doc.body?.offsetHeight || 0,
      );
    } catch {
      return 0;
    }
  }

  // Check if iframe has rendered content properly
  function checkIframeRendered(): boolean {
    if (!iframeRef) return false;

    // The current document said it is ready or reported its height
    if (readyToken === frameDoc.token || heightToken === frameDoc.token) return true;

    // Try to measure content directly
    return measureIframeHeight() > 10;
  }

  // Attempt recovery by forcing iframe recreation or measuring height directly
  function attemptRecovery() {
    if (!mounted) return;

    const currentMsgId = messageId;
    const currentHtml = html;

    // Skip if no content to render
    if (!currentHtml || currentHtml.length < 100) return;

    // Skip if already attempted recovery for this message
    if (recoveryAttempted.has(currentMsgId)) return;

    // If postMessage height reporting failed but content is actually there,
    // measure directly (works when srcdoc iframe is same-origin-ish, e.g. in
    // WRY/Tauri where postMessage targetOrigin may be silently rejected).
    if (iframeHeight <= 150) {
      const measured = measureIframeHeight();
      if (measured > 50) {
        iframeHeight = measured;
        onHeightChange?.(iframeHeight);
        // Set up a polling fallback since postMessage isn't working
        startHeightPolling();
        return;
      }
    }

    // Check if content actually rendered
    if (checkIframeRendered()) return;

    // Mark recovery attempted and force recreation
    recoveryAttempted.add(currentMsgId);
    console.warn(
      '[EmailIframe] Content not rendered after delay, forcing recreation for message:',
      currentMsgId,
    );
    themeVersion++;
  }

  // Polling fallback for environments where postMessage from srcdoc fails
  let heightPollInterval: ReturnType<typeof setInterval> | null = null;

  function startHeightPolling() {
    if (heightPollInterval) return; // Already polling
    heightPollInterval = setInterval(() => {
      if (!mounted || !iframeRef) {
        stopHeightPolling();
        return;
      }
      const measured = measureIframeHeight();
      if (measured > 50 && measured !== iframeHeight) {
        iframeHeight = measured;
        onHeightChange?.(iframeHeight);
      }
    }, 500);
  }

  function stopHeightPolling() {
    if (heightPollInterval) {
      clearInterval(heightPollInterval);
      heightPollInterval = null;
    }
  }

  // Schedule recovery check when message changes
  function scheduleRecoveryCheck() {
    // Clear any existing timeout
    if (recoveryTimeoutId) {
      clearTimeout(recoveryTimeoutId);
      recoveryTimeoutId = null;
    }

    // Schedule a single recovery check after 500ms
    recoveryTimeoutId = setTimeout(() => {
      attemptRecovery();
    }, 500);
  }

  // Effect to handle message changes
  $effect(() => {
    // Revisiting a message reserves its measured height. A new one keeps
    // the current height, clamped, so the reader does not collapse and
    // regrow while the body loads.
    const cached = heightCache.get(heightKey);
    const current = untrack(() => iframeHeight);
    iframeHeight = cached ?? Math.min(Math.max(current, 200), 800);
    stopHeightPolling();
  });

  // The recovery check runs from when a document with content is set, not
  // from when the message changed: a cached body that lands a few hundred ms
  // into the load used to get almost no time before the check tore it down.
  $effect(() => {
    if (!frameDoc.hasContent) return;
    void frameDoc.token;
    if (untrack(() => mounted)) scheduleRecoveryCheck();
  });

  // Handle postMessage events from iframe
  function handleMessage(event: MessageEvent) {
    // Validate origin: accept our own origin or null/empty (srcdoc iframes).
    // srcdoc iframes report origin as the string "null" in most browsers,
    // but WRY (Tauri's WebKit webview) may report actual null or empty string.
    // The event.source check below is the primary security gate.
    const origin = event.origin;
    if (origin && origin !== 'null' && origin !== window.location.origin) {
      return;
    }

    // Only accept messages from our own iframe to prevent cross-contamination
    // when multiple EmailIframe instances exist (e.g., conversation view)
    if (iframeRef && event.source !== iframeRef.contentWindow) {
      return;
    }

    // Validate message structure - must match our expected format
    const data = event.data;
    if (!data || typeof data !== 'object' || !data.type) {
      return;
    }

    // Only accept messages with our known types
    const validTypes = ['height', 'link', 'link-hover', 'link-hover-end', 'form', 'ready', 'swipe'];
    if (!validTypes.includes(data.type)) {
      return;
    }

    // Process the message based on type
    // A message from a document already replaced (the previous email) is
    // stale: it must not reveal the frame or set the new email's height.
    // Runtimes that predate tokens send none; those are taken as current.
    const token = typeof data.payload?.token === 'string' ? data.payload.token : null;
    if (token !== null && token !== '' && token !== frameDoc.token) return;

    switch (data.type) {
      case 'ready':
        readyToken = frameDoc.token;
        // Iframe has initialized - cancel recovery since it's working
        if (recoveryTimeoutId) {
          clearTimeout(recoveryTimeoutId);
          recoveryTimeoutId = null;
        }
        break;

      case 'height':
        if (typeof data.payload?.height === 'number' && data.payload.height > 0) {
          const newHeight = Math.max(data.payload.height, 50);
          heightToken = frameDoc.token;
          if (frameDoc.hasContent) rememberHeight(heightKey, newHeight);
          // Only update if height actually changed to avoid unnecessary re-renders
          if (newHeight !== iframeHeight) {
            iframeHeight = newHeight;
            onHeightChange?.(iframeHeight);

            // Cancel recovery check - we got a height, content is rendering
            if (recoveryTimeoutId) {
              clearTimeout(recoveryTimeoutId);
              recoveryTimeoutId = null;
            }
          }
        }
        break;

      case 'link':
        linkPreview = null;
        if (typeof data.payload?.url === 'string') {
          onLinkClick?.(data.payload.url, data.payload.isMailto === true);
        }
        break;

      case 'link-hover':
        if (showLinkPreview && typeof data.payload?.url === 'string') {
          const preview = describeLinkTarget(
            data.payload.url,
            typeof data.payload.text === 'string' ? data.payload.text : '',
          );
          linkPreview = preview.kind === 'unsupported' ? null : preview;
        }
        break;

      case 'link-hover-end':
        linkPreview = null;
        break;

      case 'form':
        if (data.payload) {
          onFormSubmit?.(
            data.payload.action || '',
            data.payload.method || 'get',
            data.payload.data || {},
          );
        }
        break;

      case 'swipe':
        if (data.payload?.phase) {
          onSwipe?.(data.payload.phase, data.payload);
        }
        break;
    }
  }

  let themeObserver: MutationObserver | null = null;

  // Android WebView can swallow touch events inside iframes before they
  // reach document-level listeners in the srcdoc. Since we use
  // allow-same-origin on Tauri, attach touch listeners directly on the
  // iframe's contentDocument from the parent as a reliable fallback.
  let swipeState = {
    startX: 0,
    startY: 0,
    active: false,
    direction: null as 'left' | 'right' | null,
  };

  const onIframeTouchStart = (e: TouchEvent) => {
    if (!e.touches || e.touches.length !== 1) return;
    swipeState.startX = e.touches[0].clientX;
    swipeState.startY = e.touches[0].clientY;
    swipeState.active = false;
    swipeState.direction = null;
    onSwipe?.('start', { x: swipeState.startX, y: swipeState.startY });
  };

  const onIframeTouchMove = (e: TouchEvent) => {
    if (!e.touches || e.touches.length !== 1 || !swipeState.startX) return;
    const dx = e.touches[0].clientX - swipeState.startX;
    const dy = e.touches[0].clientY - swipeState.startY;
    if (!swipeState.active && Math.abs(dx) > 15 && Math.abs(dx) > Math.abs(dy) * 2) {
      swipeState.active = true;
      swipeState.direction = dx > 0 ? 'right' : 'left';
    }
    if (swipeState.active) {
      onSwipe?.('move', { dx, dy });
    }
  };

  const onIframeTouchEnd = () => {
    onSwipe?.('end', { active: swipeState.active, direction: swipeState.direction });
    swipeState.startX = 0;
    swipeState.startY = 0;
    swipeState.active = false;
    swipeState.direction = null;
  };

  // A touch the system took over (a scroll the browser claimed, Control
  // Center, the home bar) ends the swipe without acting on it.
  const onIframeTouchCancel = () => {
    onSwipe?.('end', { active: false, direction: null, cancelled: true });
    swipeState.startX = 0;
    swipeState.startY = 0;
    swipeState.active = false;
    swipeState.direction = null;
  };

  let attachedDoc: Document | null = null;

  const attachIframeTouchListeners = () => {
    if (!iframeRef) return;
    try {
      const doc = iframeRef.contentDocument;
      if (!doc || doc === attachedDoc) return;
      // Clean up previous listeners
      if (attachedDoc) {
        attachedDoc.removeEventListener('touchstart', onIframeTouchStart, true);
        attachedDoc.removeEventListener('touchmove', onIframeTouchMove, true);
        attachedDoc.removeEventListener('touchend', onIframeTouchEnd, true);
        attachedDoc.removeEventListener('touchcancel', onIframeTouchCancel, true);
      }
      doc.addEventListener('touchstart', onIframeTouchStart, { passive: true, capture: true });
      doc.addEventListener('touchmove', onIframeTouchMove, { passive: true, capture: true });
      doc.addEventListener('touchend', onIframeTouchEnd, { passive: true, capture: true });
      doc.addEventListener('touchcancel', onIframeTouchCancel, { passive: true, capture: true });
      attachedDoc = doc;
    } catch {
      // Cross-origin iframe — fall back to postMessage from the srcdoc
    }
  };

  onMount(() => {
    mounted = true;
    window.addEventListener('message', handleMessage);

    // Set initial dark mode state
    isDarkMode = detectDarkMode();

    // Observe body class changes to detect theme switches
    themeObserver = new MutationObserver(() => {
      const newDarkMode = detectDarkMode();
      if (newDarkMode !== isDarkMode) {
        isDarkMode = newDarkMode;
        // Theme changed - increment version to force iframe recreation
        // This ensures CSS is properly applied
        themeVersion++;
      }
    });
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
  });

  onDestroy(() => {
    mounted = false;
    linkPreview = null;
    window.removeEventListener('message', handleMessage);
    themeObserver?.disconnect();
    stopHeightPolling();

    // Detach iframe touch listeners
    if (attachedDoc) {
      attachedDoc.removeEventListener('touchstart', onIframeTouchStart, true);
      attachedDoc.removeEventListener('touchmove', onIframeTouchMove, true);
      attachedDoc.removeEventListener('touchend', onIframeTouchEnd, true);
      attachedDoc.removeEventListener('touchcancel', onIframeTouchCancel, true);
      attachedDoc = null;
    }

    // Clear any pending recovery timeout
    if (recoveryTimeoutId) {
      clearTimeout(recoveryTimeoutId);
      recoveryTimeoutId = null;
    }
  });
</script>

{#key contentSignature}
  <div class="fe-email-iframe-container" style="height: {iframeHeight}px;">
    <!-- On Tauri/WRY, sandboxed srcdoc iframes without allow-same-origin
         cannot postMessage to the parent (WebKit limitation). We add
         allow-same-origin on desktop — this is safe because the srcdoc CSP
         blocks all network access (default-src 'none', no connect-src),
         preventing data exfiltration even if email HTML contains scripts.
         Tauri's isolation pattern + WRY provide the real security boundary. -->
    {#if frameDoc.hasContent}
      <iframe
        bind:this={iframeRef}
        {srcdoc}
        sandbox={isTauri ? 'allow-scripts allow-same-origin' : 'allow-scripts'}
        title="Email content"
        class="fe-email-iframe"
        style="height: {iframeHeight}px; color-scheme: {isDarkMode ? 'dark' : 'light'};"
        onload={attachIframeTouchListeners}
      ></iframe>
    {:else}
      <div class="fe-email-loading" aria-hidden="true">
        <div class="fe-email-loading-indicator"></div>
      </div>
    {/if}
  </div>
{/key}

{#if linkPreview}
  <!-- Hoisted to body: inside the reader column a fixed element paints
       underneath the sidebar, which owns the bottom-left of the window. -->
  <div
    use:portal
    class="fe-link-preview"
    class:fe-link-preview-warn={linkPreview.mismatch || linkPreview.isIdn}
    role="status"
    aria-live="polite"
    data-testid="link-preview"
  >
    {#if linkPreview.mismatch}
      <span class="fe-link-preview-note"
        >Text says {linkPreview.mismatch.textHost}, link goes to</span
      >
    {:else if linkPreview.isIdn}
      <span class="fe-link-preview-note">Internationalized domain</span>
    {/if}
    <span class="fe-link-preview-url">
      {#if linkPreview.kind === 'http'}<span class="fe-link-preview-dim">{linkPreview.prefix}</span
        ><span class="fe-link-preview-host">{linkPreview.host}</span><span
          class="fe-link-preview-dim">{linkPreview.suffix}</span
        >{:else}{linkPreview.display}{/if}
    </span>
  </div>
{/if}

<style>
  .fe-email-iframe-container {
    position: relative;
    width: 100%;
    min-height: 100px;
    flex-shrink: 0;
  }

  .fe-email-iframe {
    width: 100%;
    border: none;
    display: block;
    background: transparent;
    /* No height transition — instant resize avoids visible flicker */
  }

  .fe-email-loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 48px;
    background: transparent;
    pointer-events: none;
    /* Most bodies come from the cache in well under this; the spinner only
       shows for a load slow enough to be worth showing. */
    opacity: 0;
    animation: fe-email-loading-in 0.15s ease-out 0.25s forwards;
  }

  @keyframes fe-email-loading-in {
    to {
      opacity: 1;
    }
  }

  .fe-email-loading-indicator {
    width: 24px;
    height: 24px;
    border: 2px solid var(--border-default);
    border-top-color: var(--action-primary-bg);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Status bar for the hovered link. Bottom-left of the window like a
     browser's. Lives on body (see use:portal), so the z-index is against
     the app's own scale: above the shell's z-50 and z-[100] chrome, below
     dialog overlays at 9998 and tooltips at 9999. */
  .fe-link-preview {
    position: fixed;
    left: 0;
    bottom: 0;
    z-index: 1000;
    /* The sidebar it overlaps (aside.fe-folders) is a composited layer: it
       carries a transform with a transition. In Chromium the z-index alone
       keeps the bar on top; WebKit on macOS was seen painting the bar under
       that layer now and then. Promote the bar to its own layer so the
       compositor orders it by z-index rather than by layer creation order. */
    transform: translateZ(0);
    will-change: transform;
    isolation: isolate;
    max-width: min(72vw, 900px);
    padding: 3px 10px;
    border: 1px solid var(--border-default);
    border-left: 0;
    border-bottom: 0;
    border-top-right-radius: 6px;
    background: var(--surface-raised);
    color: var(--text-primary);
    font-size: 12px;
    line-height: 1.5;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
    box-shadow: 0 -1px 6px rgba(0, 0, 0, 0.08);
  }

  .fe-link-preview-warn {
    border-color: var(--state-caution);
    box-shadow: inset 3px 0 0 var(--state-caution);
  }

  .fe-link-preview-note {
    color: var(--state-caution);
    font-family: inherit;
    margin-right: 6px;
  }

  .fe-link-preview-host {
    font-weight: 700;
  }

  .fe-link-preview-dim {
    color: var(--text-muted);
  }

  @media (max-width: 640px) {
    .fe-link-preview {
      max-width: calc(100vw - 16px);
    }
  }
</style>
