const InitialJumpUtils = globalThis.ChatGPTInitialJumpUtils;

class TimelineManager {
    constructor() {
        this.scrollContainer = null;
        this.conversationContainer = null;
        this.markers = [];
        this.activeTurnId = null;
        this.ui = { timelineBar: null, tooltip: null };
        this.isScrolling = false;

        this.mutationObserver = null;
        this.resizeObserver = null;
        this.intersectionObserver = null;
        this.themeObserver = null; // observe theme class changes to refresh geometry
        this.visibleUserTurns = new Set();
        this.onTimelineBarClick = null;
        this.onScroll = null;
        this.onTimelineBarOver = null;
        this.onTimelineBarOut = null;
        this.onTimelineBarFocusIn = null;
        this.onTimelineBarFocusOut = null;
        this.onWindowResize = null;
        this.onTimelineWheel = null;
        this.onTimelinePointerMove = null;
        this.scrollRafId = null;
        this.smoothScrollRafId = null;
        this.smoothScrollSession = 0;
        this.scrollCorrectionRafId = null;
        this.scrollCorrectionSession = 0;
        this.initialJumpRafId = null;
        this.initialJumpReady = false;
        this.initialJumpStableFrames = 0;
        this.initialJumpMetrics = null;
        this.initialJumpStartedAt = 0;
        this.initialJumpReadyDeadline = 0;
        this.pendingInitialJump = null;
        this.scrollAnchoringRestoreValue = null;
        this.scrollAnchoringLockCount = 0;
        this.lastActiveChangeTime = 0;
        this.minActiveChangeInterval = 120; // ms
        this.pendingActiveId = null;
        this.activeChangeTimer = null;
        this.tooltipHideDelay = 100;
        this.tooltipHideTimer = null;
        this.measureEl = null; // legacy DOM measurer (kept as fallback)
        this.truncateCache = new Map();
        this.measureCanvas = null;
        this.measureCtx = null;
        this.showRafId = null;
        this.tooltipMoveRafId = null;
        this.pendingTooltipDot = null;
        // Long-canvas scrollable track (Linked mode)
        this.ui.track = null;
        this.ui.trackContent = null;
        this.scale = 1;
        this.contentHeight = 0;
        this.timelineTrackOffset = 0;
        this.yPositions = [];
        this.timelineHitTop = NaN;
        this.hoverDistanceThreshold = 42;
        this.hoverWidths = [36, 28, 21, 15, 9];
        this.hoverOpacities = [1, 0.88, 0.72, 0.56, 0.42];
        this.hoverEffectRadius = this.hoverWidths.length - 1;
        this.markerScrollPositions = [];
        this.visibleRange = { start: 0, end: -1 };
        this.firstUserTurnOffset = 0;
        this.contentSpanPx = 1;
        this.usePixelTop = true; // Codex-style compact layout uses explicit pixel positions.
        this._cssVarTopSupported = true;
        this.markersVersion = 0;
        this.markerPositionsDirty = true;
        this.markerPositionsLastRefreshAt = 0;
        this.summaryRefreshTimer = null;
        this.summaryRefreshDelay = 900;
        // Debug perf
        this.debugPerf = false;
        try { this.debugPerf = (localStorage.getItem('chatgptTimelineDebugPerf') === '1'); } catch {}
        this.onVisualViewportResize = null;
        
        this.debouncedRecalculateAndRender = this.debounce(this.recalculateAndRenderMarkers, 350);

        // Summary cache: retain text when ChatGPT virtualizes off-screen elements
        this.summaryCache = new Map();
        // Star/Highlight feature state
        this.starred = new Set();
        this.markerMap = new Map();
        this.hoveredMarkerIndex = -1;
        this.tooltipMarkerId = null;
        this.conversationId = this.extractConversationIdFromPath(location.pathname);
        // Long-press gesture state
        this.longPressDuration = 550; // ms
        this.longPressMoveTolerance = 6; // px
        this.longPressTimer = null;
        this.longPressTriggered = false;
        this.pressStartPos = null;
        this.pressTargetDot = null;
        this.suppressClickUntil = 0;
        this.suppressActiveUntil = 0;
        // Cross-tab sync
        this.onStorage = null;
        this.hoverPaintedIndices = new Set();
    }

    perfStart(name) {
        if (!this.debugPerf) return;
        try { performance.mark(`tg-${name}-start`); } catch {}
    }

    perfEnd(name) {
        if (!this.debugPerf) return;
        try {
            performance.mark(`tg-${name}-end`);
            performance.measure(`tg-${name}`, `tg-${name}-start`, `tg-${name}-end`);
            const entries = performance.getEntriesByName(`tg-${name}`).slice(-1)[0];
            if (entries) console.debug(`[TimelinePerf] ${name}: ${Math.round(entries.duration)}ms`);
        } catch {}
    }

    async init() {
        const elementsFound = await this.findCriticalElements();
        if (!elementsFound) return;
        
        this.injectTimelineUI();
        this.setupEventListeners();
        this.setupObservers();
        // Force an immediate first build so dots appear without waiting for mutations
        try { this.recalculateAndRenderMarkers(); } catch {}
        // Load persisted star markers for current conversation
        this.conversationId = this.extractConversationIdFromPath(location.pathname);
        this.loadStars();
        // After loading stars, sync current markers/dots to reflect star state immediately
        try {
            for (let i = 0; i < this.markers.length; i++) {
                const m = this.markers[i];
                const want = this.starred.has(m.id);
                if (m.starred !== want) {
                    m.starred = want;
                    if (m.dotElement) {
                        try {
                            m.dotElement.classList.toggle('starred', m.starred);
                            m.dotElement.setAttribute('aria-pressed', m.starred ? 'true' : 'false');
                        } catch {}
                    }
                }
            }
        } catch {}
        // Initial rendering will be triggered by observers; avoid duplicate delayed re-render
        this.startInitialJumpReadinessWatch();
    }

    async findCriticalElements() {
        const firstTurn = await this.waitForElement('[data-turn-id]');
        if (!firstTurn) return false;

        // Find lowest common ancestor that contains ALL turn elements
        const allTurns = document.querySelectorAll('[data-turn-id]');
        let root = firstTurn.parentElement;
        while (root && root !== document.body) {
            let allInside = true;
            for (let i = 0; i < allTurns.length; i++) {
                if (!root.contains(allTurns[i])) { allInside = false; break; }
            }
            if (allInside) break;
            root = root.parentElement;
        }
        this.conversationContainer = root || firstTurn.parentElement;
        if (!this.conversationContainer) return false;

        this.scrollContainer = this.getScrollableAncestor(this.conversationContainer);
        return this.scrollContainer !== null;
    }
    
    injectTimelineUI() {
        // Idempotent: ensure bar exists, then ensure track + content exist
        let timelineBar = document.querySelector('.chatgpt-timeline-bar');
        if (!timelineBar) {
            timelineBar = document.createElement('div');
            timelineBar.className = 'chatgpt-timeline-bar';
            document.body.appendChild(timelineBar);
        }
        this.ui.timelineBar = timelineBar;
        // Track + content
        let track = this.ui.timelineBar.querySelector('.timeline-track');
        if (!track) {
            track = document.createElement('div');
            track.className = 'timeline-track';
            this.ui.timelineBar.appendChild(track);
        }
        let trackContent = track.querySelector('.timeline-track-content');
        if (!trackContent) {
            trackContent = document.createElement('div');
            trackContent.className = 'timeline-track-content';
            track.appendChild(trackContent);
        }
        this.ui.track = track;
        this.ui.trackContent = trackContent;
        this.enforceTimelineNoScrollbarStyles();
        if (!this.ui.tooltip) {
            const tip = document.createElement('div');
            tip.className = 'timeline-tooltip';
            tip.setAttribute('role', 'tooltip');
            tip.id = 'chatgpt-timeline-tooltip';
            document.body.appendChild(tip);
            this.ui.tooltip = tip;
            // Hidden measurement node for legacy DOM truncation (fallback)
            if (!this.measureEl) {
                const m = document.createElement('div');
                m.setAttribute('aria-hidden', 'true');
                m.style.position = 'fixed';
                m.style.left = '-9999px';
                m.style.top = '0px';
                m.style.visibility = 'hidden';
                m.style.pointerEvents = 'none';
                const cs = getComputedStyle(tip);
                Object.assign(m.style, {
                    backgroundColor: cs.backgroundColor,
                    color: cs.color,
                    fontFamily: cs.fontFamily,
                    fontSize: cs.fontSize,
                    lineHeight: cs.lineHeight,
                    padding: cs.padding,
                    border: cs.border,
                    borderRadius: cs.borderRadius,
                    whiteSpace: 'normal',
                    wordBreak: 'break-word',
                    maxWidth: 'none',
                    display: 'block',
                    transform: 'none',
                    transition: 'none'
                });
                // Ensure no clamping interferes with measurement
                try { m.style.webkitLineClamp = 'unset'; } catch {}
                document.body.appendChild(m);
                this.measureEl = m;
            }
            // Create canvas for text layout based truncation (primary)
            if (!this.measureCanvas) {
                this.measureCanvas = document.createElement('canvas');
                this.measureCtx = this.measureCanvas.getContext('2d');
            }
        }
    }

    recalculateAndRenderMarkers() {
        this.perfStart('recalc');
        if (!this.conversationContainer || !this.ui.timelineBar || !this.scrollContainer) return;

        const allTurnElements = Array.from(this.conversationContainer.querySelectorAll('[data-turn-id]'));
        const userTurnElements = allTurnElements.filter(el => el?.dataset?.turn === 'user');
        // Reset visible window to avoid cleaning with stale indices after rebuild
        this.visibleRange = { start: 0, end: -1 };
        // If the conversation is transiently empty (branch switching), don't wipe UI immediately
        if (userTurnElements.length === 0) {
            if (!this.zeroTurnsTimer) {
                this.zeroTurnsTimer = setTimeout(() => {
                    this.zeroTurnsTimer = null;
                    this.recalculateAndRenderMarkers();
                }, 350);
            }
            return;
        }
        if (this.zeroTurnsTimer) { try { clearTimeout(this.zeroTurnsTimer); } catch {} this.zeroTurnsTimer = null; }
        // Extract React fiber text for virtualized elements before building markers
        try { this.extractFiberTexts(); } catch {}
        // Clear old dots from track/content (now that we know content exists)
        (this.ui.trackContent || this.ui.timelineBar).querySelectorAll('.timeline-dot').forEach(n => n.remove());

        const turnElements = Array.from(userTurnElements);
        const measuredPositions = turnElements.map(el => this.getElementScrollAnchorTop(el));
        const firstTurnOffset = measuredPositions[0] || 0;
        const lastTurnOffset = measuredPositions[measuredPositions.length - 1] || firstTurnOffset;
        const contentSpan = Math.max(1, lastTurnOffset - firstTurnOffset);
        const markerRatios = turnElements.map((_, index) => {
            if (turnElements.length <= 1) return 0.5;
            return index / Math.max(1, turnElements.length - 1);
        });

        // Cache for scroll mapping
        this.firstUserTurnOffset = firstTurnOffset;
        this.contentSpanPx = contentSpan;
        this.markerScrollPositions = measuredPositions;
        this.markerPositionsDirty = false;
        this.markerPositionsLastRefreshAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        // Build markers with normalized position along conversation
        this.markerMap.clear();
        this.markers = turnElements.map((el, index) => {
            let n = markerRatios[index];
            n = Math.max(0, Math.min(1, n));
            const pair = this.resolveTurnPairSummary(el, allTurnElements);
            const m = {
                id: el.dataset.turnId,
                element: el,
                summary: pair.question,
                answerSummary: pair.answer,
                tooltipLabel: this.composeTooltipLabel(pair.question, pair.answer),
                n,
                baseN: n,
                dotElement: null,
                starred: false,
            };
            try { m.starred = this.starred.has(m.id); } catch {}
            this.markerMap.set(m.id, m);
            return m;
        });
        // Bump version after markers are rebuilt to invalidate concurrent passes
        this.markersVersion++;
        if (this.hoveredMarkerIndex >= this.markers.length) {
            this.hoveredMarkerIndex = -1;
            this.hoverPaintedIndices.clear();
        } else if (this.hoveredMarkerIndex >= 0) {
            this.hoverPaintedIndices = new Set(this.getHoverPaintIndices(this.hoveredMarkerIndex));
        } else {
            this.hoverPaintedIndices.clear();
        }

        // Compute geometry and virtualize render
        this.updateTimelineGeometry();
        if (!this.activeTurnId && this.markers.length > 0) {
            this.activeTurnId = this.markers[this.markers.length - 1].id;
        }
        this.syncTimelineTrackToMain();
        this.updateVirtualRangeAndRender();
        // Ensure active class is applied after dots are created
        this.updateActiveDotUI();
        this.scheduleScrollSync();
        this.perfEnd('recalc');
    }

    markMarkerPositionsDirty() {
        this.markerPositionsDirty = true;
    }

    scheduleSummaryRefresh() {
        if (this.summaryRefreshTimer) {
            try { clearTimeout(this.summaryRefreshTimer); } catch {}
        }
        this.summaryRefreshTimer = setTimeout(() => {
            this.summaryRefreshTimer = null;
            this.refreshMarkerSummaries();
            this.markMarkerPositionsDirty();
            this.scheduleScrollSync();
        }, this.summaryRefreshDelay);
    }

    enforceTimelineNoScrollbarStyles() {
        try {
            const styleId = 'chatgpt-timeline-no-scrollbar-style';
            if (!document.getElementById(styleId)) {
                const style = document.createElement('style');
                style.id = styleId;
                style.textContent = `
.chatgpt-timeline-bar .timeline-track,
.chatgpt-timeline-bar .timeline-track-content {
  overflow: hidden !important;
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
  scrollbar-gutter: auto !important;
}
.chatgpt-timeline-bar .timeline-track::-webkit-scrollbar,
.chatgpt-timeline-bar .timeline-track::-webkit-scrollbar-button,
.chatgpt-timeline-bar .timeline-track::-webkit-scrollbar-thumb,
.chatgpt-timeline-bar .timeline-track::-webkit-scrollbar-track,
.chatgpt-timeline-bar .timeline-track-content::-webkit-scrollbar,
.chatgpt-timeline-bar .timeline-track-content::-webkit-scrollbar-button,
.chatgpt-timeline-bar .timeline-track-content::-webkit-scrollbar-thumb,
.chatgpt-timeline-bar .timeline-track-content::-webkit-scrollbar-track {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
  min-width: 0 !important;
  min-height: 0 !important;
  background: transparent !important;
}
`;
                (document.head || document.documentElement || document.body)?.appendChild(style);
            }
        } catch {}

        for (const el of [this.ui.track, this.ui.trackContent]) {
            if (!el) continue;
            try {
                el.style.setProperty('overflow', 'hidden', 'important');
                el.style.setProperty('overflow-x', 'hidden', 'important');
                el.style.setProperty('overflow-y', 'hidden', 'important');
                el.style.setProperty('scrollbar-width', 'none', 'important');
                el.style.setProperty('-ms-overflow-style', 'none', 'important');
                el.style.setProperty('scrollbar-gutter', 'auto', 'important');
                el.scrollTop = 0;
                el.scrollLeft = 0;
            } catch {}
        }
    }
    
    setupObservers() {
        this.mutationObserver = new MutationObserver((mutations) => {
            const impact = InitialJumpUtils.classifyTimelineMutationRecords(mutations);
            if (!impact.needsRebuild) {
                if (impact.needsSummaryRefresh) this.scheduleSummaryRefresh();
                this.scheduleScrollSync();
                return;
            }

            this.markMarkerPositionsDirty();
            try { this.ensureContainersUpToDate(); } catch {}
            this.debouncedRecalculateAndRender();
            this.updateIntersectionObserverTargets();
        });
        this.mutationObserver.observe(this.conversationContainer, { childList: true, subtree: true });
        // Resize: update long-canvas geometry and virtualization
        this.resizeObserver = new ResizeObserver(() => {
            this.updateTimelineGeometry();
            this.syncTimelineTrackToMain();
            this.updateVirtualRangeAndRender();
        });
        if (this.ui.timelineBar) {
            this.resizeObserver.observe(this.ui.timelineBar);
        }

        this.intersectionObserver = new IntersectionObserver(entries => {
            // Maintain which user turns are currently visible
            entries.forEach(entry => {
                const target = entry.target;
                if (entry.isIntersecting) {
                    this.visibleUserTurns.add(target);
                } else {
                    this.visibleUserTurns.delete(target);
                }
            });

            // Defer active state decision to scroll-based computation
            this.scheduleScrollSync();
        }, { 
            root: this.scrollContainer,
            threshold: 0.1,
            rootMargin: "-40% 0px -59% 0px"
        });

        this.updateIntersectionObserverTargets();

        // Observe theme toggles (e.g., html.dark) to refresh geometry immediately
        try {
            if (!this.themeObserver) {
                this.themeObserver = new MutationObserver(() => {
                    this.markMarkerPositionsDirty();
                    this.updateTimelineGeometry();
                    this.syncTimelineTrackToMain();
                    this.updateVirtualRangeAndRender();
                });
            }
            this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        } catch {}
    }

    // Ensure our conversation/scroll containers are still current after DOM replacements
    ensureContainersUpToDate() {
        const first = document.querySelector('[data-turn-id]');
        if (!first) return;
        // Find lowest common ancestor containing all turns (same logic as findCriticalElements)
        const allTurns = document.querySelectorAll('[data-turn-id]');
        let newConv = first.parentElement;
        while (newConv && newConv !== document.body) {
            let allInside = true;
            for (let i = 0; i < allTurns.length; i++) {
                if (!newConv.contains(allTurns[i])) { allInside = false; break; }
            }
            if (allInside) break;
            newConv = newConv.parentElement;
        }
        if (newConv && newConv !== this.conversationContainer) {
            // Rebind observers and listeners to the new conversation root
            this.rebindConversationContainer(newConv);
        }
    }

    rebindConversationContainer(newConv) {
        // Detach old listeners
        if (this.scrollContainer && this.onScroll) {
            try { this.scrollContainer.removeEventListener('scroll', this.onScroll); } catch {}
        }
        try { this.mutationObserver?.disconnect(); } catch {}
        try { this.intersectionObserver?.disconnect(); } catch {}
        try { this.themeObserver?.disconnect(); } catch {}

        this.conversationContainer = newConv;

        this.scrollContainer = this.getScrollableAncestor(newConv);
        this.markMarkerPositionsDirty();
        // Reattach scroll listener
        this.onScroll = () => {
            this.scheduleScrollSync();
        };
        this.scrollContainer.addEventListener('scroll', this.onScroll, { passive: true });

        // Recreate IntersectionObserver with new root
        this.intersectionObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                const target = entry.target;
                if (entry.isIntersecting) { this.visibleUserTurns.add(target); }
                else { this.visibleUserTurns.delete(target); }
            });
            this.scheduleScrollSync();
        }, { root: this.scrollContainer, threshold: 0.1, rootMargin: "-40% 0px -59% 0px" });
        this.updateIntersectionObserverTargets();

        // Re-observe mutations on the new conversation container
        this.mutationObserver.observe(this.conversationContainer, { childList: true, subtree: true });

        // Force a recalc right away to rebuild markers
        this.recalculateAndRenderMarkers();
    }

    updateIntersectionObserverTargets() {
        if (!this.intersectionObserver || !this.conversationContainer) return;
        this.intersectionObserver.disconnect();
        this.visibleUserTurns.clear();
        const userTurns = this.conversationContainer.querySelectorAll('[data-turn="user"][data-turn-id]');
        userTurns.forEach(el => this.intersectionObserver.observe(el));
    }

    setupEventListeners() {
        this.onTimelineBarClick = (e) => {
            const dot = this.getDotFromPointerEvent(e, true);
            if (dot) {
                const now = Date.now();
                if (now < (this.suppressClickUntil || 0)) {
                    try { e.preventDefault(); e.stopPropagation(); } catch {}
                    return;
                }
                const targetId = dot.dataset.targetTurnId;
                const targetElement = this.conversationContainer.querySelector(`[data-turn-id="${targetId}"]`);
                if (targetElement) {
                    // Only scroll; let scroll-based computation set active to avoid double-flash
                    this.queueOrRunTimelineJump(targetId);
                }
            }
        };
        this.ui.timelineBar.addEventListener('click', this.onTimelineBarClick);
        // Long-press gesture on dots (delegated on bar)
        this.onPointerDown = (ev) => {
            const dot = this.getDotFromPointerEvent(ev, true);
            if (!dot) return;
            if (typeof ev.button === 'number' && ev.button !== 0) return; // left button only
            this.cancelLongPress();
            this.pressTargetDot = dot;
            this.pressStartPos = { x: ev.clientX, y: ev.clientY };
            try { dot.classList.add('holding'); } catch {}
            this.longPressTriggered = false;
            this.longPressTimer = setTimeout(() => {
                this.longPressTimer = null;
                if (!this.pressTargetDot) return;
                const id = this.pressTargetDot.dataset.targetTurnId;
                this.toggleStar(id);
                this.longPressTriggered = true;
                this.suppressClickUntil = Date.now() + 350;
                // If tooltip is visible for this dot, refresh immediately to reflect ★ prefix change
                try { this.refreshTooltipForDot(this.pressTargetDot); } catch {}
                try { this.pressTargetDot.classList.remove('holding'); } catch {}
            }, this.longPressDuration);
        };
        this.onPointerMove = (ev) => {
            if (!this.pressTargetDot || !this.pressStartPos) return;
            const dx = ev.clientX - this.pressStartPos.x;
            const dy = ev.clientY - this.pressStartPos.y;
            if ((dx * dx + dy * dy) > (this.longPressMoveTolerance * this.longPressMoveTolerance)) {
                this.cancelLongPress();
            }
        };
        this.onPointerUp = () => { this.cancelLongPress(); };
        this.onPointerCancel = () => { this.cancelLongPress(); };
        this.onPointerLeave = (ev) => {
            const dot = this.getDotFromPointerEvent(ev, true);
            if (dot && dot === this.pressTargetDot) this.cancelLongPress();
        };
        try {
            this.ui.timelineBar.addEventListener('pointerdown', this.onPointerDown);
            window.addEventListener('pointermove', this.onPointerMove, { passive: true });
            window.addEventListener('pointerup', this.onPointerUp, { passive: true });
            window.addEventListener('pointercancel', this.onPointerCancel, { passive: true });
            this.ui.timelineBar.addEventListener('pointerleave', this.onPointerLeave);
        } catch {}
        // Listen to container scroll to keep marker active state in sync
        this.onScroll = () => {
            this.scheduleScrollSync();
        };
        this.scrollContainer.addEventListener('scroll', this.onScroll, { passive: true });

        // Tooltip interactions (delegated)
        this.onTimelineBarOver = (e) => {
            const index = this.findNearestMarkerIndexByClientY(e.clientY);
            if (index < 0) return;
            this.applyHoverProximityForIndex(index);
            const dot = this.markers[index]?.dotElement || this.getDotFromPointerEvent(e, true);
            if (dot) this.scheduleTooltipForDot(dot);
        };
        this.onTimelinePointerMove = (e) => {
            const index = this.findNearestMarkerIndexByClientY(e.clientY);
            if (index < 0) {
                this.hideTooltip();
                this.clearHoverProximity();
                return;
            }
            this.applyHoverProximityForIndex(index);
            const marker = this.markers[index];
            const dot = marker?.dotElement;
            if (dot && this.tooltipMarkerId !== marker.id) {
                this.scheduleTooltipForDot(dot);
            }
        };
        this.onTimelineBarOut = (e) => {
            const fromDot = e.target.closest('.timeline-dot');
            const toDot = e.relatedTarget?.closest?.('.timeline-dot');
            const stillInBar = e.relatedTarget && this.ui.timelineBar?.contains?.(e.relatedTarget);
            if (fromDot && !toDot && !stillInBar) {
                this.hideTooltip();
                this.clearHoverProximity();
            }
        };
        this.onTimelineBarFocusIn = (e) => {
            const dot = this.getDotFromPointerEvent(e);
            if (!dot) return;
            this.applyHoverProximityForDot(dot);
            this.showTooltipForDot(dot);
        };
        this.onTimelineBarFocusOut = (e) => {
            const dot = this.getDotFromPointerEvent(e);
            if (dot) {
                this.hideTooltip();
                this.clearHoverProximity();
            }
        };
        this.ui.timelineBar.addEventListener('mouseover', this.onTimelineBarOver);
        this.ui.timelineBar.addEventListener('pointermove', this.onTimelinePointerMove, { passive: true });
        this.ui.timelineBar.addEventListener('mouseout', this.onTimelineBarOut);
        this.ui.timelineBar.addEventListener('focusin', this.onTimelineBarFocusIn);
        this.ui.timelineBar.addEventListener('focusout', this.onTimelineBarFocusOut);

        this.onBarLeave = () => { this.hideTooltip(); this.clearHoverProximity(); };
        try {
            this.ui.timelineBar.addEventListener('pointerleave', this.onBarLeave);
        } catch {}

        // Reposition tooltip on resize
        this.onWindowResize = () => {
            if (this.ui.tooltip?.classList.contains('visible') && this.tooltipMarkerId) {
                const marker = this.markerMap.get(this.tooltipMarkerId);
                if (marker?.dotElement) this.refreshTooltipForDot(marker.dotElement);
            }
            // Update long-canvas geometry and virtualization
            this.markMarkerPositionsDirty();
            this.updateTimelineGeometry();
            this.syncTimelineTrackToMain();
            this.updateVirtualRangeAndRender();
        };
        window.addEventListener('resize', this.onWindowResize);
        // VisualViewport resize can fire on zoom on some platforms; schedule correction
        if (window.visualViewport) {
            this.onVisualViewportResize = () => {
                this.markMarkerPositionsDirty();
                this.updateTimelineGeometry();
                this.syncTimelineTrackToMain();
                this.updateVirtualRangeAndRender();
            };
            try { window.visualViewport.addEventListener('resize', this.onVisualViewportResize); } catch {}
        }

        // Scroll wheel on the timeline controls the main scroll container (Linked mode)
        this.onTimelineWheel = (e) => {
            // Prevent page from attempting to scroll anything else
            try { e.preventDefault(); } catch {}
            const delta = e.deltaY || 0;
            this.scrollContainer.scrollTop += delta;
            // Keep markers in sync on next frame
            this.scheduleScrollSync();
        };
        this.ui.timelineBar.addEventListener('wheel', this.onTimelineWheel, { passive: false });

        // Cross-tab star sync via localStorage 'storage' event
        this.onStorage = (e) => {
            try {
                if (!e || e.storageArea !== localStorage) return;
                const cid = this.conversationId;
                if (!cid) return;
                const expectedKey = `chatgptTimelineStars:${cid}`;
                if (e.key !== expectedKey) return;

                // Parse new star set
                let nextArr = [];
                try { nextArr = JSON.parse(e.newValue || '[]') || []; } catch { nextArr = []; }
                const nextSet = new Set(nextArr.map(x => String(x)));

                // Fast no-op check: if sizes match and all entries exist, skip
                if (nextSet.size === this.starred.size) {
                    let same = true;
                    for (const id of this.starred) { if (!nextSet.has(id)) { same = false; break; } }
                    if (same) return;
                }

                // Apply to in-memory set
                this.starred = nextSet;

                // Update markers and any visible dots
                for (let i = 0; i < this.markers.length; i++) {
                    const m = this.markers[i];
                    const want = this.starred.has(m.id);
                    if (m.starred !== want) {
                        m.starred = want;
                        if (m.dotElement) {
                            try {
                                m.dotElement.classList.toggle('starred', m.starred);
                                m.dotElement.setAttribute('aria-pressed', m.starred ? 'true' : 'false');
                            } catch {}
                        }
                    }
                }

                // If a tooltip is currently visible over any dot, refresh it to reflect ★
                try {
                    if (this.ui.tooltip?.classList.contains('visible')) {
                        const currentDot = this.ui.timelineBar.querySelector('.timeline-dot:hover, .timeline-dot:focus');
                        if (currentDot) this.refreshTooltipForDot(currentDot);
                    }
                } catch {}
            } catch {}
        };
        try { window.addEventListener('storage', this.onStorage); } catch {}
    }
    
    cancelSmoothScroll() {
        this.smoothScrollSession++;
        if (this.smoothScrollRafId !== null) {
            try { cancelAnimationFrame(this.smoothScrollRafId); } catch {}
            this.smoothScrollRafId = null;
        }
        this.isScrolling = false;
        this.unlockScrollAnchoring();
    }

    cancelScrollCorrection() {
        this.scrollCorrectionSession = (Number(this.scrollCorrectionSession) || 0) + 1;
        if (this.scrollCorrectionRafId !== null) {
            try { cancelAnimationFrame(this.scrollCorrectionRafId); } catch {}
            this.scrollCorrectionRafId = null;
        }
        this.unlockScrollAnchoring();
    }

    cancelInitialJumpReadinessWatch() {
        if (this.initialJumpRafId !== null) {
            try { cancelAnimationFrame(this.initialJumpRafId); } catch {}
            this.initialJumpRafId = null;
        }
    }

    lockScrollAnchoring() {
        if (!this.scrollContainer) return;
        this.scrollAnchoringLockCount = Math.max(0, Number(this.scrollAnchoringLockCount) || 0) + 1;
        if (this.scrollAnchoringLockCount > 1) return;
        try {
            this.scrollAnchoringRestoreValue = this.scrollContainer.style.overflowAnchor || '';
            this.scrollContainer.style.overflowAnchor = InitialJumpUtils.resolveScrollAnchoring({
                active: true,
                fallback: this.scrollAnchoringRestoreValue
            });
        } catch {}
    }

    isElementScrollable(el) {
        if (!el) return false;
        try {
            const style = window.getComputedStyle(el);
            const overflowY = String(style.overflowY || '').toLowerCase();
            const allowed = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
            const isDocument = el === document.scrollingElement || el === document.documentElement || el === document.body;
            if (!allowed && !isDocument) return false;
            if ((el.scrollHeight - el.clientHeight) > 4) return true;
            const previous = el.scrollTop;
            el.scrollTop = previous + 1;
            const changed = el.scrollTop !== previous;
            el.scrollTop = previous;
            return changed;
        } catch {
            return false;
        }
    }

    getScrollableAncestor(startEl) {
        const candidates = [];
        let node = startEl;
        let depth = 0;
        while (node && node !== document.body) {
            if (this.isElementScrollable(node)) {
                candidates.push({
                    element: node,
                    overflow: Math.max(0, (node.scrollHeight || 0) - (node.clientHeight || 0)),
                    isDocument: false,
                    depth
                });
            }
            node = node.parentElement;
            depth++;
        }
        const documentScroll = document.scrollingElement || document.documentElement || document.body;
        if (this.isElementScrollable(documentScroll)) {
            candidates.push({
                element: documentScroll,
                overflow: Math.max(0, (documentScroll.scrollHeight || 0) - (documentScroll.clientHeight || 0)),
                isDocument: true,
                depth: Number.MAX_SAFE_INTEGER
            });
        }
        const best = InitialJumpUtils.pickBestScrollableCandidate(candidates);
        return best?.element || documentScroll;
    }

    unlockScrollAnchoring() {
        if (!this.scrollContainer) {
            this.scrollAnchoringLockCount = 0;
            this.scrollAnchoringRestoreValue = null;
            return;
        }
        this.scrollAnchoringLockCount = Math.max(0, Number(this.scrollAnchoringLockCount) || 0);
        if (this.scrollAnchoringLockCount === 0) return;
        this.scrollAnchoringLockCount--;
        if (this.scrollAnchoringLockCount > 0) return;
        try {
            this.scrollContainer.style.overflowAnchor = InitialJumpUtils.resolveScrollAnchoring({
                active: false,
                fallback: this.scrollAnchoringRestoreValue
            });
            if (!this.scrollAnchoringRestoreValue) {
                try { this.scrollContainer.style.removeProperty('overflow-anchor'); } catch {}
            }
        } catch {}
        this.scrollAnchoringRestoreValue = null;
    }

    resolvePendingJumpTarget(pending = this.pendingInitialJump) {
        const targetId = String(pending?.targetId || '').trim();
        if (!targetId || !this.conversationContainer) return null;
        const turnElement = this.conversationContainer.querySelector(`[data-turn-id="${CSS.escape(targetId)}"]`);
        const targetElement = this.resolveTurnScrollAnchor(turnElement);
        if (!targetElement) return null;
        return { targetId, turnElement, targetElement };
    }

    resolveTurnScrollAnchor(turnElement) {
        if (!turnElement) return null;
        const textSelectors = [
            '.whitespace-pre-wrap',
            '[dir="auto"]',
            '.markdown',
            'p',
            'pre'
        ];
        let textAnchor = null;
        for (const selector of textSelectors) {
            try {
                const candidates = Array.from(turnElement.querySelectorAll(selector));
                for (const candidate of candidates) {
                    const text = String(candidate.innerText || candidate.textContent || '').replace(/\s+/g, ' ').trim();
                    if (!text) continue;
                    textAnchor = candidate;
                    break;
                }
            } catch {}
            if (textAnchor) break;
        }
        if (!textAnchor) return turnElement;

        let bubbleAnchor = textAnchor;
        let node = textAnchor;
        while (node && node !== turnElement) {
            try {
                const style = getComputedStyle(node);
                const backgroundColor = String(style.backgroundColor || '').trim().toLowerCase();
                const hasBackground = backgroundColor && backgroundColor !== 'rgba(0, 0, 0, 0)' && backgroundColor !== 'transparent';
                const radius = parseFloat(style.borderTopLeftRadius || '0') || 0;
                const hasBorder = (parseFloat(style.borderTopWidth || '0') || 0) > 0;
                const hasPadding = ((parseFloat(style.paddingTop || '0') || 0) + (parseFloat(style.paddingBottom || '0') || 0)) > 0;
                if ((hasBackground || hasBorder) && (radius > 0 || hasPadding)) {
                    bubbleAnchor = node;
                }
            } catch {}
            node = node.parentElement;
        }
        return bubbleAnchor || textAnchor || turnElement;
    }

    getTargetScrollTop(targetElement) {
        if (!this.scrollContainer || !targetElement) return NaN;
        const containerRect = this.scrollContainer.getBoundingClientRect();
        const targetRect = targetElement.getBoundingClientRect();
        const rawTop = targetRect.top - containerRect.top + this.scrollContainer.scrollTop;
        return InitialJumpUtils.resolveScrollTarget({
            rawTop,
            focusOffset: this.getScrollFocusOffset()
        });
    }

    readComputedPixelValue(...values) {
        for (const value of values) {
            const text = String(value || '').trim();
            if (!text) continue;
            const n = parseFloat(text);
            if (Number.isFinite(n)) return n;
        }
        return 0;
    }

    getScrollFocusOffset() {
        if (!this.scrollContainer) return 2;
        try {
            const style = getComputedStyle(this.scrollContainer);
            const containerScrollPaddingTop = this.readComputedPixelValue(
                style.getPropertyValue?.('scroll-padding-top'),
                style.getPropertyValue?.('--sticky-padding-top')
            );
            return InitialJumpUtils.resolveScrollFocusOffset({
                containerScrollPaddingTop,
                fallbackOffset: 2,
                gapOffset: 12
            });
        } catch {
            return 14;
        }
    }

    getActiveReferenceY(scrollTop = this.scrollContainer?.scrollTop || 0) {
        return InitialJumpUtils.resolveActiveReferenceY({
            scrollTop,
            focusOffset: this.getScrollFocusOffset(),
            epsilon: 2
        });
    }

    getElementScrollAnchorTop(targetElement) {
        const anchorElement = this.resolveTurnScrollAnchor(targetElement);
        const top = this.getTargetScrollTop(anchorElement);
        if (Number.isFinite(top)) return top;
        try { return Number(targetElement?.offsetTop) || 0; } catch { return 0; }
    }

    refreshMarkerScrollPositions(options = {}) {
        if (!this.markers.length) {
            this.markerScrollPositions = [];
            this.markerPositionsDirty = false;
            return this.markerScrollPositions;
        }
        const force = !!options.force;
        if (!force && !this.markerPositionsDirty && this.markerScrollPositions.length === this.markers.length) {
            return this.markerScrollPositions;
        }
        const positions = this.markers.map(marker => this.getElementScrollAnchorTop(marker.element));
        this.markerScrollPositions = positions;
        const first = positions[0] || 0;
        const last = positions[positions.length - 1] || first;
        this.firstUserTurnOffset = first;
        this.contentSpanPx = Math.max(1, last - first);
        this.markerPositionsDirty = false;
        this.markerPositionsLastRefreshAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        return positions;
    }

    captureInitialJumpMetrics() {
        if (!this.scrollContainer) return null;
        const pendingTarget = this.resolvePendingJumpTarget();
        let anchorTop = pendingTarget?.targetElement ? this.getTargetScrollTop(pendingTarget.targetElement) : NaN;
        if (!Number.isFinite(anchorTop)) {
            const probeTarget = this.markers[0]?.element || this.conversationContainer?.querySelector?.('[data-turn="user"][data-turn-id]');
            anchorTop = this.getTargetScrollTop(probeTarget);
        }
        return {
            scrollTop: Number(this.scrollContainer.scrollTop) || 0,
            scrollHeight: Number(this.scrollContainer.scrollHeight) || 0,
            anchorTop: Number.isFinite(anchorTop) ? anchorTop : 0
        };
    }

    markInitialJumpReady(reason = 'stable') {
        if (this.initialJumpReady) return;
        this.initialJumpReady = true;
        this.initialJumpStableFrames = 0;
        this.initialJumpMetrics = null;
        this.initialJumpStartedAt = 0;
        this.initialJumpReadyDeadline = 0;
        this.cancelInitialJumpReadinessWatch();
        if (!this.pendingInitialJump) return;
        const pending = this.resolvePendingJumpTarget();
        this.pendingInitialJump = null;
        if (pending?.targetElement) {
            this.activeTurnId = pending.targetId;
            this.pendingActiveId = null;
            this.updateActiveDotUI();
            this.smoothScrollTo(pending.targetElement);
        }
    }

    startInitialJumpReadinessWatch() {
        if (this.initialJumpReady || !this.scrollContainer) return;
        if (!this.initialJumpReadyDeadline) {
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            this.initialJumpStartedAt = now;
            this.initialJumpReadyDeadline = now + 1600;
        }
        if (this.initialJumpRafId !== null) return;

        const tick = () => {
            this.initialJumpRafId = null;
            if (this.initialJumpReady || !this.scrollContainer) return;
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const currentMetrics = this.captureInitialJumpMetrics();
            const previousMetrics = this.initialJumpMetrics;
            this.initialJumpMetrics = currentMetrics;
            const readiness = InitialJumpUtils.evaluateInitialJumpReadiness({
                stableFrames: this.initialJumpStableFrames,
                previousScrollTop: previousMetrics?.scrollTop,
                currentScrollTop: currentMetrics?.scrollTop,
                previousScrollHeight: previousMetrics?.scrollHeight,
                currentScrollHeight: currentMetrics?.scrollHeight,
                previousAnchorTop: previousMetrics?.anchorTop,
                currentAnchorTop: currentMetrics?.anchorTop,
                elapsedMs: now - (this.initialJumpStartedAt || now),
                minReadyMs: 250
            });
            this.initialJumpStableFrames = readiness.stableFrames;
            if (readiness.ready) {
                this.markInitialJumpReady('stable-frames');
                return;
            }
            if (now >= this.initialJumpReadyDeadline) {
                this.markInitialJumpReady('deadline');
                return;
            }
            this.initialJumpRafId = requestAnimationFrame(tick);
        };

        this.initialJumpRafId = requestAnimationFrame(tick);
    }

    queueOrRunTimelineJump(targetId) {
        const resolved = this.resolvePendingJumpTarget({ targetId });
        if (!resolved?.targetElement) return;
        if (!InitialJumpUtils.shouldRunTimelineJump({
            targetId: resolved.targetId,
            activeTurnId: this.activeTurnId,
            initialJumpReady: this.initialJumpReady
        })) {
            this.pendingInitialJump = null;
            return;
        }
        this.activeTurnId = resolved.targetId;
        this.pendingActiveId = null;
        this.updateActiveDotUI();
        if (!this.initialJumpReady) {
            this.pendingInitialJump = { targetId };
            this.startInitialJumpReadinessWatch();
            return;
        }
        this.pendingInitialJump = null;
        this.smoothScrollTo(resolved.targetElement);
    }

    smoothScrollTo(targetElement, duration = 600) {
        this.cancelSmoothScroll();
        this.cancelScrollCorrection();
        this.lockScrollAnchoring();
        const session = this.smoothScrollSession;
        const container = this.scrollContainer;
        const nowBase = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        this.suppressActiveUntil = nowBase + duration + 1800;
        const startPosition = this.scrollContainer.scrollTop;
        const targetPosition = this.getTargetScrollTop(targetElement);
        if (!Number.isFinite(targetPosition) || Math.abs(targetPosition - startPosition) <= 1) {
            this.isScrolling = false;
            this.smoothScrollRafId = null;
            this.suppressActiveUntil = 0;
            this.unlockScrollAnchoring();
            this.scheduleScrollSync();
            return;
        }
        let startTime = null;
        const animation = (currentTime) => {
            if (session !== this.smoothScrollSession || !this.scrollContainer || this.scrollContainer !== container) return;
            this.isScrolling = true;
            if (startTime === null) startTime = currentTime;
            const timeElapsed = currentTime - startTime;
            const liveTargetPosition = this.getTargetScrollTop(targetElement);
            const effectiveTarget = Number.isFinite(liveTargetPosition) ? liveTargetPosition : targetPosition;
            const liveDistance = effectiveTarget - startPosition;
            const run = this.easeInOutQuad(timeElapsed, startPosition, liveDistance, duration);
            this.scrollContainer.scrollTop = run;
            if (timeElapsed < duration) {
                this.smoothScrollRafId = requestAnimationFrame(animation);
            } else {
                const finalTargetPosition = this.getTargetScrollTop(targetElement);
                this.scrollContainer.scrollTop = Number.isFinite(finalTargetPosition) ? finalTargetPosition : effectiveTarget;
                this.correctScrollPositionNow(targetElement, 6);
                this.isScrolling = false;
                this.smoothScrollRafId = null;
                this.beginScrollCorrection(targetElement, {
                    reason: 'timeline-click'
                });
            }
        };
        this.smoothScrollRafId = requestAnimationFrame(animation);
    }

    correctScrollPositionNow(targetElement, maxWrites = 6) {
        if (!this.scrollContainer || !targetElement) return false;
        let wrote = false;
        for (let i = 0; i < maxWrites; i++) {
            const targetTop = this.getTargetScrollTop(targetElement);
            if (!Number.isFinite(targetTop)) break;
            const delta = targetTop - this.scrollContainer.scrollTop;
            if (Math.abs(delta) <= 1) break;
            this.scrollContainer.scrollTop = targetTop;
            wrote = true;
            try { targetElement.getBoundingClientRect(); } catch {}
        }
        return wrote;
    }

    beginScrollCorrection(targetElement, options = {}) {
        if (!this.scrollContainer || !targetElement) return;
        this.cancelScrollCorrection();
        this.lockScrollAnchoring();
        const session = this.scrollCorrectionSession;
        const wantedTurnId = String(options.wantedTurnId || targetElement?.closest?.('[data-turn-id]')?.dataset?.turnId || '').trim() || null;
        const nowBase = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const deadline = nowBase + Math.max(400, Number(options.durationMs) || 1800);
        let stableFrames = 0;
        this.suppressActiveUntil = deadline;

        const tick = () => {
            if (session !== this.scrollCorrectionSession || !this.scrollContainer) return;
            if (!targetElement?.isConnected) {
                this.scrollCorrectionRafId = null;
                this.suppressActiveUntil = 0;
                this.unlockScrollAnchoring();
                return;
            }
            const targetTop = this.getTargetScrollTop(targetElement);
            if (!Number.isFinite(targetTop)) {
                this.scrollCorrectionRafId = null;
                this.suppressActiveUntil = 0;
                this.unlockScrollAnchoring();
                return;
            }
            const currentTop = this.scrollContainer.scrollTop;
            const delta = targetTop - currentTop;
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const decision = InitialJumpUtils.evaluateScrollCorrection({
                delta,
                stableFrames,
                now,
                deadline
            });
            if (decision.needsWrite) {
                this.scrollContainer.scrollTop = targetTop;
                stableFrames = 0;
            } else {
                stableFrames++;
            }

            if (wantedTurnId) {
                this.activeTurnId = wantedTurnId;
                this.pendingActiveId = null;
                this.updateActiveDotUI();
            }
            this.refreshMarkerScrollPositions();
            this.syncTimelineTrackToMain();
            this.updateVirtualRangeAndRender();

            if (decision.shouldContinue) {
                this.scrollCorrectionRafId = requestAnimationFrame(tick);
                return;
            }

            this.scrollCorrectionRafId = null;
            this.suppressActiveUntil = 0;
            this.unlockScrollAnchoring();
            this.scheduleScrollSync();
        };

        this.scrollCorrectionRafId = requestAnimationFrame(tick);
    }
    
    easeInOutQuad(t, b, c, d) {
        t /= d / 2;
        if (t < 1) return c / 2 * t * t + b;
        t--;
        return -c / 2 * (t * (t - 2) - 1) + b;
    }

    updateActiveDotUI() {
        this.markers.forEach(marker => {
            marker.dotElement?.classList.toggle('active', marker.id === this.activeTurnId);
        });
    }

    debounce(func, delay) {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), delay);
        };
    }

    // Read numeric CSS var from the timeline bar element
    getCSSVarNumber(el, name, fallback) {
        const v = getComputedStyle(el).getPropertyValue(name).trim();
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : fallback;
    }

    // Normalize whitespace and trim; remove leading SR-only prefixes like "You said:" / "你说："; no manual ellipsis
    normalizeText(text) {
        try {
            let s = String(text || '').replace(/\s+/g, ' ').trim();
            // Strip only if it appears at the very start
            s = s.replace(/^\s*(you\s*said\s*[:：]?\s*)/i, '');
            s = s.replace(/^\s*((你说|您说|你說|您說)\s*[:：]?\s*)/, '');
            s = s.replace(/^\s*((大模型|模型|助手|助理|ChatGPT|Assistant|AI)\s*(说|說|said)\s*[:：]?\s*)/i, '');
            s = s.replace(/^\s*已\s*思考\s*/i, '思考 ');
            const thinking = this.splitThinkingPrefix(s);
            if (thinking) s = thinking.rest ? `${thinking.prefix} ${thinking.rest}` : thinking.prefix;
            return s;
        } catch {
            return '';
        }
    }

    splitThinkingPrefix(text) {
        try {
            const s = String(text || '').replace(/\s+/g, ' ').trim();
            const durationUnit = '(?:milliseconds?|seconds?|minutes?|hours?|secs?|mins?|hrs?|毫秒|秒钟|秒|分钟|分|小时|时|ms|sec|s|min|m|hr|h)';
            const re = new RegExp(`^(思考\\s*(?:约\\s*)?(?:(?:\\d+(?:\\.\\d+)?\\s*${durationUnit})\\s*)+)(.*)$`, 'i');
            const match = s.match(re);
            if (!match) return null;
            const prefix = match[1].trim().replace(/^思考(?=\S)/, '思考 ');
            const rest = (match[2] || '').trimStart();
            return prefix ? { prefix, rest } : null;
        } catch {
            return null;
        }
    }

    // Trigger the MAIN-world bridge script (fiber-bridge-chatgpt.js) to read React
    // fiber data for virtualized elements. Data flows back via CustomEvent.detail
    // into summaryCache — zero DOM modifications, zero traces on the page.
    extractFiberTexts() {
        try {
            let received = false;
            const handler = (e) => {
                received = true;
                const data = e.detail;
                if (!data || typeof data !== 'object') return;
                for (const id of Object.keys(data)) {
                    const text = this.normalizeText(data[id] || '');
                    if (text) this.summaryCache.set(id, text);
                }
            };
            document.addEventListener('timeline-fiber-result', handler, { once: true });
            document.dispatchEvent(new CustomEvent('timeline-extract-fiber'));
            // DOM events are synchronous — if bridge responded, handler already ran.
            // If not (bridge not loaded yet), clean up the orphaned listener.
            if (!received) {
                document.removeEventListener('timeline-fiber-result', handler);
            }
        } catch {}
    }

    // Two-tier summary resolution: DOM text -> summaryCache (populated by fiber bridge)
    resolveSummary(el) {
        const id = el?.dataset?.turnId;
        if (!id) return '';
        // Priority 1: DOM text (most reliable when element is not virtualized)
        const domText = this.normalizeText(el.textContent || '');
        if (domText) { this.summaryCache.set(id, domText); return domText; }
        // Priority 2: cached value (filled by fiber bridge or previous DOM reads)
        return this.summaryCache.get(id) || '';
    }

    findAssistantAfterUser(userEl, allTurnElements = []) {
        try {
            const turns = Array.isArray(allTurnElements) && allTurnElements.length
                ? allTurnElements
                : Array.from(this.conversationContainer?.querySelectorAll?.('[data-turn-id]') || []);
            const start = turns.indexOf(userEl);
            if (start < 0) return null;
            for (let i = start + 1; i < turns.length; i++) {
                const turn = turns[i];
                const role = turn?.dataset?.turn;
                if (role === 'assistant') return turn;
                if (role === 'user') return null;
            }
        } catch {}
        return null;
    }

    resolveTurnPairSummary(userEl, allTurnElements = []) {
        const question = this.resolveSummary(userEl);
        const assistantEl = this.findAssistantAfterUser(userEl, allTurnElements);
        const answer = assistantEl ? this.resolveSummary(assistantEl) : '';
        return { question, answer };
    }

    refreshMarkerSummaries() {
        if (!this.conversationContainer || !this.markers.length) return;
        try { this.extractFiberTexts(); } catch {}

        const allTurnElements = Array.from(this.conversationContainer.querySelectorAll('[data-turn-id]'));
        let tooltipDot = null;

        for (let i = 0; i < this.markers.length; i++) {
            const marker = this.markers[i];
            if (!marker?.id) continue;

            let userEl = marker.element;
            if (!userEl?.isConnected) {
                userEl = allTurnElements.find(el => el?.dataset?.turnId === marker.id) || null;
                if (userEl) marker.element = userEl;
            }
            if (!userEl) continue;

            const pair = this.resolveTurnPairSummary(userEl, allTurnElements);
            const tooltipLabel = this.composeTooltipLabel(pair.question, pair.answer);
            if (
                marker.summary === pair.question &&
                marker.answerSummary === pair.answer &&
                marker.tooltipLabel === tooltipLabel
            ) {
                continue;
            }

            marker.summary = pair.question;
            marker.answerSummary = pair.answer;
            marker.tooltipLabel = tooltipLabel;

            if (marker.dotElement) {
                try { marker.dotElement.setAttribute('aria-label', this.getMarkerTooltipLabel(marker)); } catch {}
                if (marker.id === this.tooltipMarkerId) tooltipDot = marker.dotElement;
            }
        }

        if (!tooltipDot && this.tooltipMarkerId) {
            const marker = this.markerMap.get(this.tooltipMarkerId);
            tooltipDot = marker?.dotElement || null;
        }
        if (tooltipDot) {
            try { this.refreshTooltipForDot(tooltipDot); } catch {}
        }
    }

    composeTooltipLabel(question, answer) {
        const q = this.normalizeText(question || '');
        const a = this.normalizeText(answer || '');
        if (q && a) return `${q}\n${a}`;
        return q || a || '';
    }

    getMarkerTooltipLabel(marker) {
        if (!marker) return '';
        const label = marker.tooltipLabel || this.composeTooltipLabel(marker.summary, marker.answerSummary);
        return marker.starred ? `★ ${label}` : label;
    }

    renderTooltipContent(tip, marker) {
        if (!tip) return;
        tip.textContent = '';
        const starred = !!marker?.starred;
        const question = this.normalizeText(marker?.summary || marker?.tooltipLabel || '');
        const answer = this.normalizeText(marker?.answerSummary || '');

        const q = document.createElement('div');
        q.className = 'timeline-tooltip-question';
        q.textContent = `${starred ? '★ ' : ''}${question || answer || ''}`;
        tip.appendChild(q);

        if (answer) {
            const a = document.createElement('div');
            a.className = 'timeline-tooltip-answer';
            const thinking = this.splitThinkingPrefix(answer);
            if (thinking) {
                const prefix = document.createElement('span');
                prefix.className = 'timeline-tooltip-thinking';
                prefix.textContent = thinking.prefix;
                a.appendChild(prefix);
                if (thinking.rest) a.appendChild(document.createTextNode(` ${thinking.rest}`));
            } else {
                a.textContent = answer;
            }
            tip.appendChild(a);
        }
    }

    measureTooltipHeight(tip, width) {
        if (!tip) return 0;
        try {
            tip.style.width = `${Math.floor(width)}px`;
            tip.style.height = 'auto';
            const lineH = this.getCSSVarNumber(tip, '--timeline-tooltip-lh', 18);
            const padY = this.getCSSVarNumber(tip, '--timeline-tooltip-pad-y', 10);
            const borderW = this.getCSSVarNumber(tip, '--timeline-tooltip-border-w', 1);
            const maxH = Math.round(5 * lineH + 2 * padY + 2 * borderW + 4);
            const measured = Math.ceil(tip.scrollHeight || tip.offsetHeight || maxH);
            return Math.max(1, Math.min(measured, maxH));
        } catch {
            return 108;
        }
    }

    getTrackPadding() {
        if (!this.ui.timelineBar) return 12;
        return this.getCSSVarNumber(this.ui.timelineBar, '--timeline-track-padding', 12);
    }

    getMinGap() {
        if (!this.ui.timelineBar) return 12;
        return this.getCSSVarNumber(this.ui.timelineBar, '--timeline-min-gap', 12);
    }

    // Enforce a minimum pixel gap between positions while staying within bounds
    applyMinGap(positions, minTop, maxTop, gap) {
        const n = positions.length;
        if (n === 0) return positions;
        const out = positions.slice();
        // Clamp first and forward pass (monotonic increasing)
        out[0] = Math.max(minTop, Math.min(positions[0], maxTop));
        for (let i = 1; i < n; i++) {
            const minAllowed = out[i - 1] + gap;
            out[i] = Math.max(positions[i], minAllowed);
        }
        // If last exceeds max, backward pass
        if (out[n - 1] > maxTop) {
            out[n - 1] = maxTop;
            for (let i = n - 2; i >= 0; i--) {
                const maxAllowed = out[i + 1] - gap;
                out[i] = Math.min(out[i], maxAllowed);
            }
            // Ensure first still within min
            if (out[0] < minTop) {
                out[0] = minTop;
                for (let i = 1; i < n; i++) {
                    const minAllowed = out[i - 1] + gap;
                    out[i] = Math.max(out[i], minAllowed);
                }
            }
        }
        // Final clamp
        for (let i = 0; i < n; i++) {
            if (out[i] < minTop) out[i] = minTop;
            if (out[i] > maxTop) out[i] = maxTop;
        }
        return out;
    }

    // (Removed) Idle min-gap reapply; ChatGPT keeps min-gap solely in updateTimelineGeometry

    showTooltipForDot(dot) {
        if (!this.ui.tooltip || !dot) return;
        this.cancelScheduledTooltip();
        try { if (this.tooltipHideTimer) { clearTimeout(this.tooltipHideTimer); this.tooltipHideTimer = null; } } catch {}
        const marker = this.getMarkerForDot(dot);
        if (!marker) return;

        const tip = this.ui.tooltip;
        tip.classList.remove('visible');
        this.renderTooltipContent(tip, marker);
        const p = this.computePlacementInfo(dot);
        const height = this.measureTooltipHeight(tip, p.width);
        this.placeTooltipAt(dot, p.placement, p.width, height);
        tip.setAttribute('aria-hidden', 'false');
        this.tooltipMarkerId = marker.id;

        if (this.showRafId !== null) {
            try { cancelAnimationFrame(this.showRafId); } catch {}
            this.showRafId = null;
        }
        this.showRafId = requestAnimationFrame(() => {
            this.showRafId = null;
            tip.classList.add('visible');
        });
    }

    scheduleTooltipForDot(dot) {
        if (!this.ui.tooltip || !dot) return;
        this.pendingTooltipDot = dot;
        if (this.tooltipMoveRafId !== null) return;
        this.tooltipMoveRafId = requestAnimationFrame(() => {
            this.tooltipMoveRafId = null;
            const nextDot = this.pendingTooltipDot;
            this.pendingTooltipDot = null;
            if (!nextDot || !nextDot.isConnected) return;
            if (this.ui.tooltip?.classList.contains('visible')) {
                this.refreshTooltipForDot(nextDot);
            } else {
                this.showTooltipForDot(nextDot);
            }
        });
    }

    cancelScheduledTooltip() {
        if (this.tooltipMoveRafId !== null) {
            try { cancelAnimationFrame(this.tooltipMoveRafId); } catch {}
            this.tooltipMoveRafId = null;
        }
        this.pendingTooltipDot = null;
    }

    hideTooltip(immediate = false) {
        if (!this.ui.tooltip) return;
        this.cancelScheduledTooltip();
        const doHide = () => {
            this.ui.tooltip.classList.remove('visible');
            this.ui.tooltip.setAttribute('aria-hidden', 'true');
            this.tooltipMarkerId = null;
            this.tooltipHideTimer = null;
        };
        if (immediate) return doHide();
        try { if (this.tooltipHideTimer) { clearTimeout(this.tooltipHideTimer); } } catch {}
        this.tooltipHideTimer = setTimeout(doHide, this.tooltipHideDelay);
    }

    getMarkerForDot(dot) {
        const id = String(dot?.dataset?.targetTurnId || '').trim();
        if (!id) return null;
        return this.markerMap.get(id) || null;
    }

    getMarkerIndexForDot(dot) {
        const raw = Number(dot?.dataset?.markerIndex);
        if (Number.isInteger(raw) && raw >= 0 && raw < this.markers.length) return raw;
        const marker = this.getMarkerForDot(dot);
        return marker ? this.markers.indexOf(marker) : -1;
    }

    getDotFromPointerEvent(event, preferNearest = false) {
        const targetDot = event?.target?.closest?.('.timeline-dot') || null;
        const y = Number(event?.clientY);
        const nearestDot = Number.isFinite(y) ? this.findNearestVisibleDotByClientY(y) : null;
        return preferNearest ? (nearestDot || targetDot) : (targetDot || nearestDot);
    }

    getTimelineTrackTop() {
        const cached = Number(this.timelineHitTop);
        if (Number.isFinite(cached)) return cached;
        try {
            const top = this.ui.track?.getBoundingClientRect?.().top;
            if (Number.isFinite(top)) {
                this.timelineHitTop = top;
                return top;
            }
        } catch {}
        return NaN;
    }

    getTimelineTrackOffset() {
        const offset = Number(this.timelineTrackOffset);
        return Number.isFinite(offset) ? Math.max(0, offset) : 0;
    }

    setTimelineTrackOffset(value) {
        const trackHeight = Math.max(0, Number(this.ui.track?.clientHeight) || 0);
        const maxOffset = Math.max(0, (Number(this.contentHeight) || 0) - trackHeight);
        const next = Math.round(Math.max(0, Math.min(maxOffset, Number(value) || 0)));
        const changed = Math.abs(this.getTimelineTrackOffset() - next) > 0;
        this.timelineTrackOffset = next;
        try {
            if (this.ui.track) this.ui.track.scrollTop = 0;
            if (this.ui.trackContent) this.ui.trackContent.scrollTop = 0;
        } catch {}
        return changed;
    }

    getMarkerViewportTop(index) {
        const top = Number(this.yPositions[index]);
        if (!Number.isFinite(top)) return 0;
        return Math.round(top - this.getTimelineTrackOffset());
    }

    findNearestMarkerIndexByClientY(clientY) {
        const y = Number(clientY);
        if (!Number.isFinite(y) || !this.yPositions.length || !this.ui.track) return -1;
        const trackTop = this.getTimelineTrackTop();
        if (!Number.isFinite(trackTop)) return -1;
        const contentY = y - trackTop + this.getTimelineTrackOffset();
        return InitialJumpUtils.selectNearestIndexByY({
            positions: this.yPositions,
            value: contentY,
            threshold: this.hoverDistanceThreshold
        });
    }

    findNearestVisibleDotByClientY(clientY) {
        const index = this.findNearestMarkerIndexByClientY(clientY);
        const dot = index >= 0 ? this.markers[index]?.dotElement : null;
        if (dot?.isConnected) return dot;
        if (index < 0) return null;
        return this.findNearestVisibleDotByClientYSlow(clientY);
    }

    findNearestVisibleDotByClientYSlow(clientY) {
        let best = null;
        let bestDistance = Infinity;
        for (let i = 0; i < this.markers.length; i++) {
            const dot = this.markers[i]?.dotElement;
            if (!dot || !dot.isConnected) continue;
            try {
                const rect = dot.getBoundingClientRect();
                const center = rect.top + rect.height / 2;
                const distance = Math.abs(center - clientY);
                if (distance < bestDistance) {
                    best = dot;
                    bestDistance = distance;
                }
            } catch {}
        }
        return bestDistance <= this.hoverDistanceThreshold ? best : null;
    }

    getHoverPaintIndices(center) {
        return InitialJumpUtils.selectHoverPaintIndices({
            center,
            count: this.markers.length,
            radius: this.hoverEffectRadius
        });
    }

    applyHoverStateToDot(dot, index, forcedDistance = null) {
        if (!dot) return;
        const center = Number(this.hoveredMarkerIndex);
        const distance = forcedDistance !== null
            ? Number(forcedDistance)
            : (Number.isInteger(center) && center >= 0 ? Math.abs(index - center) : Infinity);
        const widths = this.hoverWidths;
        const opacities = this.hoverOpacities;
        const inRange = Number.isFinite(distance) && distance >= 0 && distance < widths.length;
        const state = inRange ? distance : -1;
        if (dot.__timelineHoverState === state) return;
        dot.__timelineHoverState = state;
        try {
            dot.classList.toggle('hover-near', inRange);
            dot.classList.toggle('hover-center', distance === 0);
            if (inRange) {
                const maxWidth = Math.max(1, widths[0] || 1);
                dot.style.setProperty('--timeline-hover-scale', String(Math.max(0.01, widths[distance] / maxWidth)));
                dot.style.setProperty('--timeline-hover-opacity', String(opacities[distance]));
            } else {
                dot.style.removeProperty('--timeline-hover-scale');
                dot.style.removeProperty('--timeline-hover-opacity');
            }
        } catch {}
    }

    applyHoverProximityForDot(dot) {
        const index = this.getMarkerIndexForDot(dot);
        this.applyHoverProximityForIndex(index);
    }

    applyHoverProximityForIndex(index) {
        if (!Number.isInteger(index) || index < 0 || index >= this.markers.length) return;
        try { this.ui.timelineBar?.classList.add('timeline-hovering'); } catch {}
        const nextIndices = this.getHoverPaintIndices(index);
        const nextSet = new Set(nextIndices);
        for (const paintedIndex of this.hoverPaintedIndices) {
            if (nextSet.has(paintedIndex)) continue;
            this.applyHoverStateToDot(this.markers[paintedIndex]?.dotElement, paintedIndex, Infinity);
        }
        this.hoveredMarkerIndex = index;
        for (const paintedIndex of nextIndices) {
            this.applyHoverStateToDot(
                this.markers[paintedIndex]?.dotElement,
                paintedIndex,
                Math.abs(paintedIndex - index)
            );
        }
        this.hoverPaintedIndices = nextSet;
    }

    clearHoverProximity() {
        if (this.hoveredMarkerIndex < 0 && this.hoverPaintedIndices.size === 0) return;
        this.hoveredMarkerIndex = -1;
        try { this.ui.timelineBar?.classList.remove('timeline-hovering'); } catch {}
        for (const paintedIndex of this.hoverPaintedIndices) {
            this.applyHoverStateToDot(this.markers[paintedIndex]?.dotElement, paintedIndex, Infinity);
        }
        this.hoverPaintedIndices.clear();
    }

    placeTooltipAt(dot, placement, width, height) {
        if (!this.ui.tooltip) return;
        const tip = this.ui.tooltip;
        const dotRect = dot.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const arrowOut = this.getCSSVarNumber(tip, '--timeline-tooltip-arrow-outside', 6);
        const baseGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-visual', 12);
        const boxGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-box', 8);
        const gap = baseGap + Math.max(0, arrowOut) + Math.max(0, boxGap);
        const viewportPad = 8;

        let left;
        if (placement === 'left') {
            left = Math.round(dotRect.left - gap - width);
            if (left < viewportPad) {
                // Clamp within viewport: switch to right if impossible
                const altLeft = Math.round(dotRect.right + gap);
                if (altLeft + width <= vw - viewportPad) {
                    placement = 'right';
                    left = altLeft;
                } else {
                    // shrink width to fit
                    const fitWidth = Math.max(120, vw - viewportPad - altLeft);
                    left = altLeft;
                    width = fitWidth;
                }
            }
        } else {
            left = Math.round(dotRect.right + gap);
            if (left + width > vw - viewportPad) {
                const altLeft = Math.round(dotRect.left - gap - width);
                if (altLeft >= viewportPad) {
                    placement = 'left';
                    left = altLeft;
                } else {
                    const fitWidth = Math.max(120, vw - viewportPad - left);
                    width = fitWidth;
                }
            }
        }

        let top = Math.round(dotRect.top + dotRect.height / 2 - height / 2);
        top = Math.max(viewportPad, Math.min(vh - height - viewportPad, top));
        tip.style.width = `${Math.floor(width)}px`;
        tip.style.height = `${Math.floor(height)}px`;
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
        tip.setAttribute('data-placement', placement);
    }

    // Refresh the currently visible tooltip for a given dot in place (no hide/show flicker)
    refreshTooltipForDot(dot) {
        if (!this.ui?.tooltip || !dot) return;
        const tip = this.ui.tooltip;
        if (!tip.classList.contains('visible')) return;
        const marker = this.getMarkerForDot(dot);
        if (!marker) return;
        this.renderTooltipContent(tip, marker);
        const p = this.computePlacementInfo(dot);
        const height = this.measureTooltipHeight(tip, p.width);
        this.placeTooltipAt(dot, p.placement, p.width, height);
        this.tooltipMarkerId = marker.id;
    }

    // --- Compact centered geometry and virtualization (Codex-style linked mode) ---
    updateTimelineGeometry() {
        if (!this.ui.timelineBar || !this.ui.trackContent) return;
        this.enforceTimelineNoScrollbarStyles();
        const pad = this.getTrackPadding();
        const minGap = this.getMinGap();
        const N = this.markers.length;
        const viewportH = Math.max(0, Math.floor(window.visualViewport?.height || window.innerHeight || 0));
        const topReserve = 60;
        const bottomReserve = 100;
        const availableH = Math.max(80, viewportH - topReserve - bottomReserve);
        const groupSpan = Math.max(0, N - 1) * minGap;
        const desired = N > 0 ? Math.ceil(groupSpan + 2 * pad) : 0;
        const minShell = N > 0 ? Math.max(28, 2 * pad + 4) : 0;
        const shellH = Math.max(minShell, Math.min(Math.max(desired, minShell), availableH));
        const shellTop = Math.round(topReserve + Math.max(0, (availableH - shellH) / 2));

        try {
            this.ui.timelineBar.style.top = `${shellTop}px`;
            this.ui.timelineBar.style.height = `${Math.round(shellH)}px`;
            this.timelineHitTop = shellTop;
        } catch {}

        const H = this.ui.timelineBar.clientHeight || shellH || 1;
        this.contentHeight = Math.ceil(Math.max(desired, H));
        this.setTimelineTrackOffset(this.getTimelineTrackOffset());
        this.scale = (H > 0) ? (this.contentHeight / H) : 1;
        try { this.ui.trackContent.style.height = `${Math.round(H)}px`; } catch {}

        const centerY = this.contentHeight / 2;
        const startY = N <= 1 ? centerY : Math.max(pad, (this.contentHeight - groupSpan) / 2);
        this.yPositions = this.markers.map((_, index) => {
            if (N <= 1) return centerY;
            return Math.round(startY + index * minGap);
        });

        for (let i = 0; i < N; i++) {
            const top = this.yPositions[i] ?? centerY;
            this.markers[i].n = this.contentHeight > 0 ? Math.max(0, Math.min(1, top / this.contentHeight)) : 0.5;
            if (this.markers[i].dotElement) {
                try { this.markers[i].dotElement.style.top = `${this.getMarkerViewportTop(i)}px`; } catch {}
            }
        }
        this.usePixelTop = true;
    }

    detectCssVarTopSupport(pad, usableC) {
        try {
            if (!this.ui.trackContent) return false;
            const test = document.createElement('button');
            test.className = 'timeline-dot';
            test.style.visibility = 'hidden';
            test.style.pointerEvents = 'none';
            test.setAttribute('aria-hidden', 'true');
            const expected = pad + 0.5 * usableC;
            test.style.setProperty('--n', '0.5');
            this.ui.trackContent.appendChild(test);
            const cs = getComputedStyle(test);
            const topStr = cs.top || '';
            const px = parseFloat(topStr);
            test.remove();
            if (!Number.isFinite(px)) return false;
            return Math.abs(px - expected) <= 2;
        } catch {
            return false;
        }
    }

    syncTimelineTrackToMain() {
        if (!this.ui.track || !this.scrollContainer || !this.contentHeight) return;
        const scrollTop = this.scrollContainer.scrollTop;
        const ref = this.getActiveReferenceY(scrollTop);
        const livePositions = this.refreshMarkerScrollPositions();
        const visualRatios = this.markers.map(marker => marker.baseN ?? marker.n ?? 0);
        const r = InitialJumpUtils.mapLiveReferenceToVisualRatio({
            livePositions,
            visualRatios,
            referenceY: ref
        });
        const maxScroll = Math.max(0, this.contentHeight - (this.ui.track.clientHeight || 0));
        const target = Math.round(r * maxScroll);
        if (Math.abs(this.getTimelineTrackOffset() - target) > 1) {
            this.setTimelineTrackOffset(target);
        }
    }

    updateVirtualRangeAndRender() {
        const localVersion = this.markersVersion;
        if (!this.ui.track || !this.ui.trackContent || this.markers.length === 0) return;
        this.enforceTimelineNoScrollbarStyles();
        const st = this.getTimelineTrackOffset();
        const vh = this.ui.track.clientHeight || 0;
        const buffer = Math.max(100, vh);
        const minY = st - buffer;
        const maxY = st + vh + buffer;
        const start = this.lowerBound(this.yPositions, minY);
        const end = Math.max(start - 1, this.upperBound(this.yPositions, maxY));

        let prevStart = this.visibleRange.start;
        let prevEnd = this.visibleRange.end;
        const len = this.markers.length;
        // Clamp previous indices into current bounds to avoid undefined access
        if (len > 0) {
            prevStart = Math.max(0, Math.min(prevStart, len - 1));
            prevEnd = Math.max(-1, Math.min(prevEnd, len - 1));
        }
        if (prevEnd >= prevStart) {
            for (let i = prevStart; i < Math.min(start, prevEnd + 1); i++) {
                const m = this.markers[i];
                if (m && m.dotElement) { try { m.dotElement.remove(); } catch {} m.dotElement = null; }
            }
            for (let i = Math.max(end + 1, prevStart); i <= prevEnd; i++) {
                const m = this.markers[i];
                if (m && m.dotElement) { try { m.dotElement.remove(); } catch {} m.dotElement = null; }
            }
        } else {
            (this.ui.trackContent || this.ui.timelineBar).querySelectorAll('.timeline-dot').forEach(n => n.remove());
            this.markers.forEach(m => { m.dotElement = null; });
        }

        const frag = document.createDocumentFragment();
        for (let i = start; i <= end; i++) {
            const marker = this.markers[i];
            if (!marker) continue;
            if (!marker.dotElement) {
                const dot = document.createElement('button');
                dot.className = 'timeline-dot';
                dot.dataset.targetTurnId = marker.id;
                dot.dataset.markerIndex = String(i);
                dot.setAttribute('aria-label', this.getMarkerTooltipLabel(marker));
                dot.setAttribute('tabindex', '0');
                dot.setAttribute('type', 'button');
                try { dot.setAttribute('aria-describedby', 'chatgpt-timeline-tooltip'); } catch {}
                try { dot.style.setProperty('--n', String(marker.n || 0)); } catch {}
                if (this.usePixelTop) {
                    dot.style.top = `${this.getMarkerViewportTop(i)}px`;
                }
                // Apply active state immediately if this is the active marker
                try { dot.classList.toggle('active', marker.id === this.activeTurnId); } catch {}
                // Apply starred state and aria
                try {
                    dot.classList.toggle('starred', !!marker.starred);
                    dot.setAttribute('aria-pressed', marker.starred ? 'true' : 'false');
                } catch {}
                this.applyHoverStateToDot(dot, i);
                marker.dotElement = dot;
                frag.appendChild(dot);
            } else {
                try { marker.dotElement.style.setProperty('--n', String(marker.n || 0)); } catch {}
                if (this.usePixelTop) {
                    marker.dotElement.style.top = `${this.getMarkerViewportTop(i)}px`;
                }
                try {
                    marker.dotElement.dataset.markerIndex = String(i);
                    marker.dotElement.setAttribute('aria-label', this.getMarkerTooltipLabel(marker));
                    marker.dotElement.classList.toggle('starred', !!marker.starred);
                    marker.dotElement.setAttribute('aria-pressed', marker.starred ? 'true' : 'false');
                } catch {}
                this.applyHoverStateToDot(marker.dotElement, i);
            }
        }
        if (localVersion !== this.markersVersion) return; // stale pass, abort
        if (frag.childNodes.length) this.ui.trackContent.appendChild(frag);
        this.visibleRange = { start, end };
    }

    lowerBound(arr, x) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < x) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    upperBound(arr, x) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] <= x) lo = mid + 1; else hi = mid;
        }
        return lo - 1;
    }

    computePlacementInfo(dot) {
        const tip = this.ui.tooltip || document.body;
        const dotRect = dot.getBoundingClientRect();
        const vw = window.innerWidth;
        const arrowOut = this.getCSSVarNumber(tip, '--timeline-tooltip-arrow-outside', 6);
        const baseGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-visual', 12);
        const boxGap = this.getCSSVarNumber(tip, '--timeline-tooltip-gap-box', 8);
        const gap = baseGap + Math.max(0, arrowOut) + Math.max(0, boxGap);
        const viewportPad = 8;
        const maxW = this.getCSSVarNumber(tip, '--timeline-tooltip-max', 448);
        const minW = 160;
        const leftAvail = Math.max(0, dotRect.left - gap - viewportPad);
        const rightAvail = Math.max(0, vw - dotRect.right - gap - viewportPad);
        let placement = (rightAvail > leftAvail) ? 'right' : 'left';
        let avail = placement === 'right' ? rightAvail : leftAvail;
        // choose width tier for determinism; primary width is about 30% wider than the old 280px card
        const tiers = [364, 328, 288, 240, 200, 160];
        const hardMax = Math.max(minW, Math.min(maxW, Math.floor(avail)));
        let width = tiers.find(t => t <= hardMax) || Math.max(minW, Math.min(hardMax, 160));
        // if no tier fits (very tight), try switching side
        if (width < minW && placement === 'left' && rightAvail > leftAvail) {
            placement = 'right';
            avail = rightAvail;
            const hardMax2 = Math.max(minW, Math.min(maxW, Math.floor(avail)));
            width = tiers.find(t => t <= hardMax2) || Math.max(120, Math.min(hardMax2, minW));
        } else if (width < minW && placement === 'right' && leftAvail >= rightAvail) {
            placement = 'left';
            avail = leftAvail;
            const hardMax2 = Math.max(minW, Math.min(maxW, Math.floor(avail)));
            width = tiers.find(t => t <= hardMax2) || Math.max(120, Math.min(hardMax2, minW));
        }
        width = Math.max(120, Math.min(width, maxW));
        return { placement, width };
    }

    truncateToThreeLines(text, targetWidth, wantLayout = false) {
        try {
            if (!this.measureEl || !this.ui.tooltip) return wantLayout ? { text, height: 0 } : text;
            const tip = this.ui.tooltip;
            const lineH = this.getCSSVarNumber(tip, '--timeline-tooltip-lh', 18);
            const padY = this.getCSSVarNumber(tip, '--timeline-tooltip-pad-y', 10);
            const borderW = this.getCSSVarNumber(tip, '--timeline-tooltip-border-w', 1);
            const maxH = Math.round(5 * lineH + 2 * padY + 2 * borderW + 4);
            const ell = '…';
            const el = this.measureEl;
            el.style.width = `${Math.max(0, Math.floor(targetWidth))}px`;

            // fast path: full text fits within 5 lines
            el.textContent = String(text || '').replace(/\s+/g, ' ').trim();
            let h = el.offsetHeight;
            if (h <= maxH) {
                return wantLayout ? { text: el.textContent, height: h } : el.textContent;
            }

            // binary search longest prefix that fits
            const raw = el.textContent;
            let lo = 0, hi = raw.length, ans = 0;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                el.textContent = raw.slice(0, mid).trimEnd() + ell;
                h = el.offsetHeight;
                if (h <= maxH) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
            }
            const out = (ans >= raw.length) ? raw : (raw.slice(0, ans).trimEnd() + ell);
            el.textContent = out;
            h = el.offsetHeight;
            return wantLayout ? { text: out, height: Math.min(h, maxH) } : out;
        } catch {
            return wantLayout ? { text, height: 0 } : text;
        }
    }

    scheduleScrollSync() {
        if (this.scrollRafId !== null) return;
        this.scrollRafId = requestAnimationFrame(() => {
            this.scrollRafId = null;
            // Sync long-canvas scroll and virtualized dots before computing active
            this.syncTimelineTrackToMain();
            this.updateVirtualRangeAndRender();
            this.computeActiveByScroll();
        });
    }

    computeActiveByScroll() {
        if (!this.scrollContainer || this.markers.length === 0) return;
        const nowCheck = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (nowCheck < (this.suppressActiveUntil || 0)) return;
        const scrollTop = this.scrollContainer.scrollTop;
        const ref = this.getActiveReferenceY(scrollTop);
        const positions = this.refreshMarkerScrollPositions();
        const activeIndex = InitialJumpUtils.selectActiveIndex({
            positions,
            referenceY: ref
        });
        const activeId = this.markers[activeIndex]?.id || this.markers[0].id;
        if (this.activeTurnId !== activeId) {
            const now = nowCheck;
            const since = now - this.lastActiveChangeTime;
            if (since < this.minActiveChangeInterval) {
                // Coalesce rapid changes during fast scrolling/layout shifts
                this.pendingActiveId = activeId;
                if (!this.activeChangeTimer) {
                    const delay = Math.max(this.minActiveChangeInterval - since, 0);
                    this.activeChangeTimer = setTimeout(() => {
                        this.activeChangeTimer = null;
                        if (this.pendingActiveId && this.pendingActiveId !== this.activeTurnId) {
                            this.activeTurnId = this.pendingActiveId;
                            this.updateActiveDotUI();
                            this.lastActiveChangeTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                        }
                        this.pendingActiveId = null;
                    }, delay);
                }
            } else {
                this.activeTurnId = activeId;
                this.updateActiveDotUI();
                this.lastActiveChangeTime = now;
            }
        }
    }

    waitForElement(selector) {
        return new Promise((resolve) => {
            const element = document.querySelector(selector);
            if (element) return resolve(element);
            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    try { observer.disconnect(); } catch {}
                    resolve(el);
                }
            });
            try { observer.observe(document.body, { childList: true, subtree: true }); } catch {}
            // Guard against long-lived observers on wrong pages
            setTimeout(() => { try { observer.disconnect(); } catch {} resolve(null); }, 5000);
        });
    }

    destroy() {
        try { this.mutationObserver?.disconnect(); } catch {}
        try { this.resizeObserver?.disconnect(); } catch {}
        try { this.intersectionObserver?.disconnect(); } catch {}
        this.visibleUserTurns.clear();
        if (this.ui.timelineBar && this.onTimelineBarClick) {
            try { this.ui.timelineBar.removeEventListener('click', this.onTimelineBarClick); } catch {}
        }
        try { window.removeEventListener('storage', this.onStorage); } catch {}
        try { this.ui.timelineBar?.removeEventListener('pointerdown', this.onPointerDown); } catch {}
        try { window.removeEventListener('pointermove', this.onPointerMove); } catch {}
        try { window.removeEventListener('pointerup', this.onPointerUp); } catch {}
        try { window.removeEventListener('pointercancel', this.onPointerCancel); } catch {}
        try { this.ui.timelineBar?.removeEventListener('pointerleave', this.onPointerLeave); } catch {}
        if (this.scrollContainer && this.onScroll) {
            try { this.scrollContainer.removeEventListener('scroll', this.onScroll); } catch {}
        }
        if (this.ui.timelineBar) {
            try { this.ui.timelineBar.removeEventListener('mouseover', this.onTimelineBarOver); } catch {}
            try { this.ui.timelineBar.removeEventListener('pointermove', this.onTimelinePointerMove); } catch {}
            try { this.ui.timelineBar.removeEventListener('mouseout', this.onTimelineBarOut); } catch {}
            try { this.ui.timelineBar.removeEventListener('focusin', this.onTimelineBarFocusIn); } catch {}
            try { this.ui.timelineBar.removeEventListener('focusout', this.onTimelineBarFocusOut); } catch {}
            try { this.ui.timelineBar.removeEventListener('wheel', this.onTimelineWheel); } catch {}
            // Remove hover handlers with stable refs
            try { this.ui.timelineBar?.removeEventListener('pointerleave', this.onBarLeave); } catch {}
            this.onBarLeave = null;
        }
        if (this.onWindowResize) {
            try { window.removeEventListener('resize', this.onWindowResize); } catch {}
        }
        if (this.onVisualViewportResize && window.visualViewport) {
            try { window.visualViewport.removeEventListener('resize', this.onVisualViewportResize); } catch {}
            this.onVisualViewportResize = null;
        }
        if (this.scrollRafId !== null) {
            try { cancelAnimationFrame(this.scrollRafId); } catch {}
            this.scrollRafId = null;
        }
        if (this.showRafId !== null) {
            try { cancelAnimationFrame(this.showRafId); } catch {}
            this.showRafId = null;
        }
        this.cancelScheduledTooltip();
        this.cancelSmoothScroll();
        this.cancelScrollCorrection();
        this.cancelInitialJumpReadinessWatch();
        try { this.ui.timelineBar?.remove(); } catch {}
        try { this.ui.tooltip?.remove(); } catch {}
        try { this.measureEl?.remove(); } catch {}
        // Remove any slider left behind by older extension builds.
        try {
            const straySlider = document.querySelector('.timeline-left-slider');
            if (straySlider) {
                try { straySlider.style.pointerEvents = 'none'; } catch {}
                try { straySlider.remove(); } catch {}
            }
        } catch {}
        this.ui = { timelineBar: null, tooltip: null };
        this.markers = [];
        this.summaryCache.clear();
        this.activeTurnId = null;
        this.scrollContainer = null;
        this.conversationContainer = null;
        this.initialJumpMetrics = null;
        this.pendingInitialJump = null;
        this.onTimelineBarClick = null;
        this.onTimelineBarOver = null;
        this.onTimelineBarOut = null;
        this.onTimelineBarFocusIn = null;
        this.onTimelineBarFocusOut = null;
        this.onScroll = null;
        this.onWindowResize = null;
        if (this.activeChangeTimer) {
            try { clearTimeout(this.activeChangeTimer); } catch {}
            this.activeChangeTimer = null;
        }
        if (this.tooltipHideTimer) {
            try { clearTimeout(this.tooltipHideTimer); } catch {}
            this.tooltipHideTimer = null;
        }
        if (this.summaryRefreshTimer) {
            try { clearTimeout(this.summaryRefreshTimer); } catch {}
            this.summaryRefreshTimer = null;
        }
        
        this.pendingActiveId = null;
        this.timelineHitTop = NaN;
        this.timelineTrackOffset = 0;
        this.pendingTooltipDot = null;
        this.hoveredMarkerIndex = -1;
        this.hoverPaintedIndices.clear();
        this.tooltipMarkerId = null;
        this.markerPositionsDirty = true;
        this.markerPositionsLastRefreshAt = 0;
    }

    // --- Star/Highlight helpers ---
    extractConversationIdFromPath(pathname = location.pathname) {
        try {
            const segs = String(pathname || '').split('/').filter(Boolean);
            const i = segs.indexOf('c');
            if (i === -1) return null;
            const slug = segs[i + 1];
            if (slug && /^[A-Za-z0-9_-]+$/.test(slug)) return slug;
            return null;
        } catch { return null; }
    }

    loadStars() {
        this.starred.clear();
        const cid = this.conversationId;
        if (!cid) return;
        try {
            const raw = localStorage.getItem(`chatgptTimelineStars:${cid}`);
            if (!raw) return;
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) arr.forEach(id => this.starred.add(String(id)));
        } catch {}
    }

    saveStars() {
        const cid = this.conversationId;
        if (!cid) return;
        try { localStorage.setItem(`chatgptTimelineStars:${cid}`, JSON.stringify(Array.from(this.starred))); } catch {}
    }

    toggleStar(turnId) {
        const id = String(turnId || '');
        if (!id) return;
        if (this.starred.has(id)) this.starred.delete(id); else this.starred.add(id);
        this.saveStars();
        const m = this.markerMap.get(id);
        if (m) {
            m.starred = this.starred.has(id);
            if (m.dotElement) {
                try {
                    m.dotElement.classList.toggle('starred', m.starred);
                    m.dotElement.setAttribute('aria-pressed', m.starred ? 'true' : 'false');
                    m.dotElement.setAttribute('aria-label', this.getMarkerTooltipLabel(m));
                } catch {}
                // If tooltip is visible and anchored to this dot, update immediately
                try { this.refreshTooltipForDot(m.dotElement); } catch {}
            }
        }
    }

    cancelLongPress() {
        if (this.longPressTimer) { try { clearTimeout(this.longPressTimer); } catch {} this.longPressTimer = null; }
        if (this.pressTargetDot) { try { this.pressTargetDot.classList.remove('holding'); } catch {} }
        this.pressTargetDot = null;
        this.pressStartPos = null;
        this.longPressTriggered = false;
    }
}


// --- Entry Point and SPA Navigation Handler ---
let timelineManagerInstance = null;
let currentUrl = location.href;
let initTimerId = null;            // cancellable delayed init
let pageObserver = null;           // page-level MutationObserver (managed)
let routeCheckIntervalId = null;   // lightweight href polling fallback
let routeListenersAttached = false;
let timelineActive = true;         // global on/off
let providerEnabled = true;        // per-provider on/off (chatgpt)

// Accept both /c/<id> and nested routes like /g/.../c/<id>
function isConversationRoute(pathname = location.pathname) {
  // Split path into segments and ensure there's an independent "c" segment
  const segs = pathname.split('/').filter(Boolean);
  const i = segs.indexOf('c');
  if (i === -1) return false;           // no "c" segment → not a conversation route
  const slug = segs[i + 1];             // the segment right after "c" must exist
  // Lightweight validity check: allow letters/digits/_/-
  return typeof slug === 'string' && slug.length > 0 && /^[A-Za-z0-9_-]+$/.test(slug);
}

function attachRouteListenersOnce() {
    if (routeListenersAttached) return;
    routeListenersAttached = true;
    try { window.addEventListener('popstate', handleUrlChange); } catch {}
    try { window.addEventListener('hashchange', handleUrlChange); } catch {}
    // Lightweight polling fallback for pushState-driven SPA changes
    try {
        routeCheckIntervalId = setInterval(() => {
            if (location.href !== currentUrl) handleUrlChange();
        }, 800);
    } catch {}
}

function detachRouteListeners() {
    if (!routeListenersAttached) return;
    routeListenersAttached = false;
    try { window.removeEventListener('popstate', handleUrlChange); } catch {}
    try { window.removeEventListener('hashchange', handleUrlChange); } catch {}
    try { if (routeCheckIntervalId) { clearInterval(routeCheckIntervalId); routeCheckIntervalId = null; } } catch {}
}

function cleanupGlobalObservers() {
    try { pageObserver?.disconnect(); } catch {}
    pageObserver = null;
}

function initializeTimeline() {
    if (timelineManagerInstance) {
        try { timelineManagerInstance.destroy(); } catch {}
        timelineManagerInstance = null;
    }
    // Remove any leftover UI before creating a new instance
    try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch {}
    try { document.querySelector('.timeline-left-slider')?.remove(); } catch {}
    try { document.getElementById('chatgpt-timeline-tooltip')?.remove(); } catch {}
    timelineManagerInstance = new TimelineManager();
    timelineManagerInstance.init().catch(err => console.error("Timeline initialization failed:", err));
 }

function handleUrlChange() {
    if (location.href === currentUrl) return;
    currentUrl = location.href;

    // Cancel any pending init from previous route
    try { if (initTimerId) { clearTimeout(initTimerId); initTimerId = null; } } catch {}

    if (isConversationRoute() && (timelineActive && providerEnabled)) {
        // Delay slightly to allow DOM to settle; re-check path before init
        initTimerId = setTimeout(() => {
            initTimerId = null;
            if (isConversationRoute() && (timelineActive && providerEnabled)) initializeTimeline();
        }, 300);
    } else {
        if (timelineManagerInstance) {
            try { timelineManagerInstance.destroy(); } catch {}
            timelineManagerInstance = null;
        }
        try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch {}
        try { document.querySelector('.timeline-left-slider')?.remove(); } catch {}
        try { document.getElementById('chatgpt-timeline-tooltip')?.remove(); } catch {}
        cleanupGlobalObservers();
    }
}

const initialObserver = new MutationObserver(() => {
    if (document.querySelector('[data-turn-id]')) {
        if (isConversationRoute() && (timelineActive && providerEnabled)) { initializeTimeline(); }
        try { initialObserver.disconnect(); } catch {}
        // Create a single managed pageObserver
        pageObserver = new MutationObserver(handleUrlChange);
        try { pageObserver.observe(document.body, { childList: true, subtree: true }); } catch {}
        attachRouteListenersOnce();
    }
});
try { initialObserver.observe(document.body, { childList: true, subtree: true }); } catch {}

// Read initial toggles (new keys only) and react to changes
try {
  if (chrome?.storage?.local) {
    chrome.storage.local.get({ timelineActive: true, timelineProviders: {} }, (res) => {
      try { timelineActive = !!res.timelineActive; } catch { timelineActive = true; }
      try {
        const map = res.timelineProviders || {};
        providerEnabled = (typeof map.chatgpt === 'boolean') ? map.chatgpt : true;
      } catch { providerEnabled = true; }

      const enabled = timelineActive && providerEnabled;
      if (!enabled) {
        if (timelineManagerInstance) { try { timelineManagerInstance.destroy(); } catch {} timelineManagerInstance = null; }
        try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch {}
        try { document.querySelector('.timeline-left-slider')?.remove(); } catch {}
        try { document.getElementById('chatgpt-timeline-tooltip')?.remove(); } catch {}
      } else {
        if (isConversationRoute() && document.querySelector('[data-turn-id]')) {
          initializeTimeline();
        }
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes) return;
      let changed = false;
      if ('timelineActive' in changes) {
        timelineActive = !!changes.timelineActive.newValue;
        changed = true;
      }
      if ('timelineProviders' in changes) {
        try {
          const map = changes.timelineProviders.newValue || {};
          providerEnabled = (typeof map.chatgpt === 'boolean') ? map.chatgpt : true;
          changed = true;
        } catch {}
      }
      if (!changed) return;
      const enabled = timelineActive && providerEnabled;
      if (!enabled) {
        if (timelineManagerInstance) { try { timelineManagerInstance.destroy(); } catch {} timelineManagerInstance = null; }
        try { document.querySelector('.chatgpt-timeline-bar')?.remove(); } catch {}
        try { document.querySelector('.timeline-left-slider')?.remove(); } catch {}
        try { document.getElementById('chatgpt-timeline-tooltip')?.remove(); } catch {}
      } else {
        if (isConversationRoute() && document.querySelector('[data-turn-id]')) {
          initializeTimeline();
        }
      }
    });
  }
} catch {}
