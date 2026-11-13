import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_PANEL_OPEN,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  PANEL_IDS,
  type PanelId,
} from '../config/defaults';
import { readStoredJson, removeStored, STORAGE_KEYS, writeStoredJson } from '../utils/storage';
import { useGlobalResize } from './useGlobalResize';
import { usePersistentState } from './usePersistentState';

function equalWeights(): Record<PanelId, number> {
  return PANEL_IDS.reduce((acc, id) => ({ ...acc, [id]: 1 }), {} as Record<PanelId, number>);
}

function readInitialOpenPanels(): Record<PanelId, boolean> {
  const result = { ...DEFAULT_PANEL_OPEN };
  for (const id of PANEL_IDS) {
    result[id] = readStoredJson<boolean>(STORAGE_KEYS.panelOpen(id), DEFAULT_PANEL_OPEN[id]);
  }
  return result;
}

export function usePanelLayout() {
  const { startSidebarResize, startPairResize } = useGlobalResize();

  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState<boolean>(
    STORAGE_KEYS.sidebarCollapsed,
    false,
  );
  const [sidebarWidth, setSidebarWidth] = usePersistentState<number>(
    STORAGE_KEYS.sidebarWidth,
    DEFAULT_SIDEBAR_WIDTH,
  );
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = usePersistentState<boolean>(
    STORAGE_KEYS.rightSidebarCollapsed,
    false,
  );
  const [panelOrderRaw, setPanelOrderRaw] = usePersistentState<string[]>(
    STORAGE_KEYS.panelOrder,
    [...PANEL_IDS],
  );
  const [openPanels, setOpenPanels] = useState<Record<PanelId, boolean>>(readInitialOpenPanels);

  useEffect(() => {
    const t = setTimeout(() => {
      for (const id of PANEL_IDS) {
        writeStoredJson(STORAGE_KEYS.panelOpen(id), openPanels[id]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [openPanels]);

  const panelOrder = useMemo<PanelId[]>(() => {
    const seen = new Set<PanelId>();
    const clean: PanelId[] = [];
    for (const raw of Array.isArray(panelOrderRaw) ? panelOrderRaw : []) {
      const id = raw as PanelId;
      if (PANEL_IDS.includes(id) && !seen.has(id)) {
        seen.add(id);
        clean.push(id);
      }
    }
    for (const id of PANEL_IDS) {
      if (!seen.has(id)) clean.push(id);
    }
    return clean;
  }, [panelOrderRaw]);

  const visibleOrder = useMemo<PanelId[]>(
    () => panelOrder.filter((id) => openPanels[id]),
    [panelOrder, openPanels],
  );

  const [panelWeights, setPanelWeights] = useState<Record<PanelId, number>>(equalWeights);
  const prevVisibleCountRef = useRef(visibleOrder.length);
  useEffect(() => {
    if (prevVisibleCountRef.current !== visibleOrder.length) {
      prevVisibleCountRef.current = visibleOrder.length;
      setPanelWeights(equalWeights());
    }
  }, [visibleOrder.length]);

  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;

  const setPanelOpen = useCallback((id: PanelId, nextOpen: boolean) => {
    setOpenPanels((prev) => {
      if (prev[id] === nextOpen) return prev;
      if (id === 'chat' && !nextOpen) {
        removeStored(STORAGE_KEYS.activeChatId);
      }
      return { ...prev, [id]: nextOpen };
    });
  }, []);

  const togglePanel = useCallback((id: PanelId) => {
    setOpenPanels((prev) => {
      const next = !prev[id];
      if (id === 'chat' && !next) {
        removeStored(STORAGE_KEYS.activeChatId);
      }
      return { ...prev, [id]: next };
    });
  }, []);

  const handleReorder = useCallback(
    (nextVisible: string[]) => {
      setPanelOrderRaw((prev) => {
        const base: PanelId[] = [];
        const seen = new Set<PanelId>();
        for (const raw of Array.isArray(prev) ? prev : []) {
          const id = raw as PanelId;
          if (PANEL_IDS.includes(id) && !seen.has(id)) {
            seen.add(id);
            base.push(id);
          }
        }
        const hidden = base.filter((p) => !nextVisible.includes(p));
        const result = nextVisible.filter((p): p is PanelId => PANEL_IDS.includes(p as PanelId));
        for (const h of hidden) {
          const oldIdx = base.indexOf(h);
          result.splice(oldIdx < 0 ? result.length : Math.min(oldIdx, result.length), 0, h);
        }
        return result;
      });
    },
    [setPanelOrderRaw],
  );

  const handleMovePanel = useCallback(
    (id: string, dir: -1 | 1) => {
      setPanelOrderRaw((prev) => {
        const base = Array.isArray(prev) ? [...prev] : [...PANEL_IDS];
        const i = base.indexOf(id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= base.length) return base;
        [base[i], base[j]] = [base[j], base[i]];
        return base;
      });
    },
    [setPanelOrderRaw],
  );

  const handleSidebarResizeStart = useCallback(
    (clientX: number) => {
      if (sidebarCollapsed) return;
      startSidebarResize(
        clientX,
        setSidebarWidth,
        sidebarWidthRef,
        MIN_SIDEBAR_WIDTH,
        MAX_SIDEBAR_WIDTH,
      );
    },
    [sidebarCollapsed, startSidebarResize, setSidebarWidth],
  );

  const nudgeSidebarWidth = useCallback(
    (delta: number) => {
      setSidebarWidth((w) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, w + delta)));
    },
    [setSidebarWidth],
  );

  const handlePairResizeStart = useCallback(
    (leftId: PanelId, rightId: PanelId) => (clientX: number) => {
      startPairResize(clientX, leftId, rightId, setPanelWeights);
    },
    [startPairResize],
  );

  const nudgePanelPair = useCallback(
    (leftId: PanelId, rightId: PanelId) => (delta: number) => {
      const totalW = window.innerWidth || 1200;
      setPanelWeights((prev) => {
        const l = prev[leftId] ?? 1;
        const r = prev[rightId] ?? 1;
        const pairSum = l + r;
        const frac = delta / Math.max(totalW, 1);
        const nl = Math.min(pairSum - 0.2, Math.max(0.2, l + frac * pairSum));
        return { ...prev, [leftId]: nl, [rightId]: pairSum - nl };
      });
    },
    [],
  );

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, [setSidebarCollapsed]);

  const toggleRightSidebar = useCallback(() => {
    setRightSidebarCollapsed((prev) => !prev);
  }, [setRightSidebarCollapsed]);

  return {
    sidebarCollapsed,
    sidebarWidth,
    rightSidebarCollapsed,
    openPanels,
    visibleOrder,
    panelWeights,
    setPanelOpen,
    togglePanel,
    handleReorder,
    handleMovePanel,
    handleSidebarResizeStart,
    nudgeSidebarWidth,
    handlePairResizeStart,
    nudgePanelPair,
    toggleSidebar,
    toggleRightSidebar,
  };
}

