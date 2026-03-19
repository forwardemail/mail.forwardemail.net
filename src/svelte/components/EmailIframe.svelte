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
  }

  let {
    html,
    messageId,
    onLinkClick,
    onHeightChange,
    onFormSubmit,
  }: Props = $props();

  // State declarations
  let iframeRef: HTMLIFrameElement | null = $state(null);
  let iframeHeight = $state(150);
  let isDarkMode = $state(false);
  let mounted = $state(false);

  // Track message changes for theme-based recreation
  let themeVersion = $state(0);

  // Track which messages we've already attempted recovery for (prevents loops)
  const recoveryAttempted = new Set<string>();
  let recoveryTimeoutId: ReturnType<typeof setTimeout> | null = null;

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

  // Build srcdoc - reactively updates when html or dark mode changes
  const srcdoc = $derived.by(() => {
    const darkMode = mounted ? isDarkMode : detectDarkMode();
    // Use '*' as targetOrigin for srcdoc iframes — Tauri's custom scheme
    // (tauri://localhost) is not recognized by postMessage in WRY's webview,
    // causing height reports to be silently dropped. This is safe because:
    // 1. The iframe is sandboxed (sandbox="allow-scripts")
    // 2. We validate event.source === iframeRef.contentWindow on receive
    return buildIframeSrcdoc(html || '', darkMode, '*');
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

    // If we've received a height update > 150, content rendered successfully
    if (iframeHeight > 150) return true;

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
    console.warn('[EmailIframe] Content not rendered after delay, forcing recreation for message:', currentMsgId);
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

    // Schedule a single recovery check after 1.5 seconds
    recoveryTimeoutId = setTimeout(() => {
      attemptRecovery();
    }, 1500);
  }

  // Effect to handle message changes
  $effect(() => {
    // Track messageId for reactivity
    const currentMsgId = messageId;

    // Reset height for new messages
    iframeHeight = 150;
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
    const validTypes = ['height', 'link', 'form', 'ready'];
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
            data.payload.data || {}
          );
        }
        break;
    }
  }

  let themeObserver: MutationObserver | null = null;

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
      attributeFilter: ['class']
    });
  });

  onDestroy(() => {
    mounted = false;
    window.removeEventListener('message', handleMessage);
    themeObserver?.disconnect();
    stopHeightPolling();

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
    /* Smooth height transitions */
    transition: height 0.15s ease-out;
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
