<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { buildIframeSrcdoc } from '../../utils/iframe-srcdoc';
  import { isTauri } from '../../utils/platform.js';

  interface Props {
    html: string;
    messageId: string;
    onLinkClick?: (url: string, isMailto: boolean) => void;
    onHeightChange?: (height: number) => void;
    onFormSubmit?: (action: string, method: string, data: Record<string, unknown>) => void;
    onSwipe?: (phase: 'start' | 'move' | 'end', detail: Record<string, unknown>) => void;
  }

  let { html, messageId, onLinkClick, onHeightChange, onFormSubmit, onSwipe }: Props = $props();

  // State declarations
  let iframeRef: HTMLIFrameElement | null = $state(null);
  let iframeHeight = $state(600);
  let isDarkMode = $state(false);
  let mounted = $state(false);

  // Track message changes for theme-based recreation
  let themeVersion = $state(0);

  // Track which messages we've already attempted recovery for (prevents loops)
  const recoveryAttempted = new Set<string>();
  let recoveryTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // Cache measured heights by messageId to avoid flicker when revisiting
  const heightCache = new Map<string, number>();

  // Detect app's dark mode by checking if body has 'light-mode' class
  function detectDarkMode(): boolean {
    if (typeof document === 'undefined') return false;
    return !document.body.classList.contains('light-mode');
  }

  // Content signature determines when iframe is recreated
  // Includes:
  // - messageId: recreate for new messages
  // - themeVersion: recreate on theme change
  // - hasContent: recreate when content arrives (0 -> N transition)
  // Note: We use boolean hasContent, NOT content length, to avoid loops when content changes slightly
  const hasContent = $derived(html && html.length > 0);
  const contentSignature = $derived(`${messageId}:${themeVersion}:${hasContent}`);

  // Build srcdoc — reactively updates when html or dark mode changes. The
  // runtime script is loaded from /email-iframe.js (parent origin) and uses
  // `*` as postMessage target; we validate event.source on receive.
  const srcdoc = $derived.by(() => {
    const darkMode = mounted ? isDarkMode : detectDarkMode();
    return buildIframeSrcdoc(html || '', darkMode);
  });

  // Measure iframe content height directly via contentDocument.
  // Returns 0 if cross-origin restrictions prevent access.
  function measureIframeHeight(): number {
    if (!iframeRef) return 0;
    try {
      const doc = iframeRef.contentDocument;
      if (!doc) return 0;
      const content = doc.querySelector('.fe-email-content');
      const contentHeight = content ? content.getBoundingClientRect().height : 0;
      return Math.max(
        Math.ceil(contentHeight),
        doc.body?.scrollHeight || 0,
        doc.body?.offsetHeight || 0,
        doc.documentElement?.scrollHeight || 0,
        doc.documentElement?.offsetHeight || 0,
      );
    } catch {
      return 0;
    }
  }

  // Check if iframe has rendered content properly
  function checkIframeRendered(): boolean {
    if (!iframeRef) return false;

    // If we've received a real height update (not the default), content rendered
    if (iframeHeight !== 600 && iframeHeight > 50) return true;

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
    // Track messageId for reactivity
    const currentMsgId = messageId;

    // Use cached height if available (revisiting a message), otherwise
    // use a tall default to avoid visible clipping before measurement
    iframeHeight = heightCache.get(currentMsgId) || 600;
    stopHeightPolling();

    // Schedule recovery check (will be cleared if messageId changes again)
    if (mounted) {
      scheduleRecoveryCheck();
    }
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
    const validTypes = ['height', 'link', 'form', 'ready', 'swipe'];
    if (!validTypes.includes(data.type)) {
      return;
    }

    // Process the message based on type
    switch (data.type) {
      case 'ready':
        // Iframe has initialized - cancel recovery since it's working
        if (recoveryTimeoutId) {
          clearTimeout(recoveryTimeoutId);
          recoveryTimeoutId = null;
        }
        break;

      case 'height':
        if (typeof data.payload?.height === 'number' && data.payload.height > 0) {
          const newHeight = Math.max(data.payload.height, 50);
          // Only update if height actually changed to avoid unnecessary re-renders
          if (newHeight !== iframeHeight) {
            iframeHeight = newHeight;
            heightCache.set(messageId, newHeight);
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
        if (typeof data.payload?.url === 'string') {
          onLinkClick?.(data.payload.url, data.payload.isMailto === true);
        }
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

  let attachedDoc: Document | null = null;

  const attachIframeTouchListeners = () => {
    if (!iframeRef) return;
    try {
      const doc = iframeRef.contentDocument;
      if (!doc || doc === attachedDoc) return;
      // Clean up previous listeners
      if (attachedDoc) {
        attachedDoc.removeEventListener('touchstart', onIframeTouchStart);
        attachedDoc.removeEventListener('touchmove', onIframeTouchMove);
        attachedDoc.removeEventListener('touchend', onIframeTouchEnd);
        attachedDoc.removeEventListener('touchcancel', onIframeTouchEnd);
      }
      doc.addEventListener('touchstart', onIframeTouchStart, { passive: true, capture: true });
      doc.addEventListener('touchmove', onIframeTouchMove, { passive: true, capture: true });
      doc.addEventListener('touchend', onIframeTouchEnd, { passive: true, capture: true });
      doc.addEventListener('touchcancel', onIframeTouchEnd, { passive: true, capture: true });
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

    // Schedule initial recovery check
    scheduleRecoveryCheck();

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
    window.removeEventListener('message', handleMessage);
    themeObserver?.disconnect();
    stopHeightPolling();

    // Detach iframe touch listeners
    if (attachedDoc) {
      attachedDoc.removeEventListener('touchstart', onIframeTouchStart);
      attachedDoc.removeEventListener('touchmove', onIframeTouchMove);
      attachedDoc.removeEventListener('touchend', onIframeTouchEnd);
      attachedDoc.removeEventListener('touchcancel', onIframeTouchEnd);
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
  <div class="fe-email-iframe-container">
    {#if html && html.length > 0}
      <!-- On Tauri/WRY, sandboxed srcdoc iframes without allow-same-origin
           cannot postMessage to the parent (WebKit limitation). We add
           allow-same-origin on desktop — this is safe because the srcdoc CSP
           blocks all network access (default-src 'none', no connect-src),
           preventing data exfiltration even if email HTML contains scripts.
           Tauri's isolation pattern + WRY provide the real security boundary. -->
      <iframe
        bind:this={iframeRef}
        {srcdoc}
        sandbox={isTauri ? 'allow-scripts allow-same-origin' : 'allow-scripts'}
        title="Email content"
        class="fe-email-iframe"
        style="height: {iframeHeight}px;"
        onload={attachIframeTouchListeners}
      ></iframe>
    {:else}
      <!-- Show a minimal placeholder when no content yet -->
      <div class="fe-email-loading" style="min-height: {iframeHeight}px;">
        <div class="fe-email-loading-indicator"></div>
      </div>
    {/if}
  </div>
{/key}

<style>
  .fe-email-iframe-container {
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
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
  }

  .fe-email-loading-indicator {
    width: 24px;
    height: 24px;
    border: 2px solid var(--color-border, #e5e7eb);
    border-top-color: var(--color-primary, #3b82f6);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
