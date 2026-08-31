import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  teamAtlasApi,
  type ChatMemoryStatus,
  type TeamAtlasIR,
  type TeamAtlasMode,
  type TeamAtlasNode,
  type TeamAtlasNodeType,
  type TeamAtlasRelation,
} from '../../lib/api/team-atlas';
import { useBackendStore, useTeams } from '../../stores/backend';
import {
  atlasCanvasSize,
  atlasContentBounds,
  atlasFitArea,
  atlasFitViewport,
  atlasGraphHeight,
  atlasInteractionEdges,
  atlasManagementPath,
  createAtlasEpochGuard,
  createAtlasRequestGate,
  directVisualNodeIds,
  edgeGeometry,
  formatAtlasCount,
  isAtlasNodeOwnedByCurrent,
  isAtlasActivationKey,
  isActiveAtlasTeam,
  layoutAtlas,
  projectAtlas,
  reconcileAtlasTeamSelection,
  summarizeAtlas,
  taskFactCounts,
  taskLineageEdgeIds,
} from './atlas-graph';
import './team-atlas.css';

const ASSET_OPTIONS: Array<TeamAtlasNodeType | 'all'> = [
  'all',
  'skill',
  'llm_wiki',
  'code_graph',
  'chat_memory',
];
const RELATIONS: TeamAtlasRelation[] = [
  'member_of',
  'belongs_to',
  'created_by',
  'owns',
  'planned_for',
  'used_in_session',
  'records_to',
  'contains_task_l0',
  'initialized_by',
  'initialized_on',
  'fixed_binding',
  'recalled_from',
];
const STATUS_CACHE_MS = 30_000;
const MAX_SELECTED_TEAMS = 4;

function nodeClass(node: TeamAtlasNode, owned: boolean): string {
  return `team-atlas-node team-atlas-node--${node.type}${owned ? ' team-atlas-node--owned' : ''}`;
}

function statusText(status: ChatMemoryStatus | undefined): string {
  if (!status) return '—';
  if (status.availability === 'not_applicable') return 'N/A';
  const counts = status.layer_counts;
  return `L0 ${counts.L0_messages ?? '?'} · L1 ${counts.L1 ?? '?'} · L2 ${counts.L2 ?? '?'} · L3 ${counts.L3 ?? '?'}`;
}

function shortId(value: unknown): string {
  if (typeof value !== 'string' || !value) return '—';
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

export function TeamAtlasPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const setActiveTeamId = useBackendStore((state) => state.setActiveTeamId);
  const { teams, activeTeamId, loading: teamsLoading } = useTeams();
  const activeTeams = useMemo(() => teams.filter(isActiveAtlasTeam), [teams]);
  const [ir, setIr] = useState<TeamAtlasIR | null>(null);
  const [viewMode, setViewMode] = useState<TeamAtlasMode>('actual');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [assetType, setAssetType] = useState<TeamAtlasNodeType | 'all'>('all');
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const [showUnboundAssets, setShowUnboundAssets] = useState(true);
  const [showOtherOwners, setShowOtherOwners] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusTeamId, setFocusTeamId] = useState<string | null>(null);
  const [focusAgentId, setFocusAgentId] = useState<string | null>(null);
  const [isCanvasFullscreen, setIsCanvasFullscreen] = useState(false);
  const [teamOffsets, setTeamOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 10, y: 10 });
  const [canvasViewportHeight, setCanvasViewportHeight] = useState(0);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const teamDragRef = useRef<{
    teamId: string;
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const statusCache = useRef(
    new Map<string, { expires: number; value?: ChatMemoryStatus; error?: string }>(),
  );
  const requestGate = useRef(createAtlasRequestGate()).current;
  const memoryEpochGuard = useRef(createAtlasEpochGuard()).current;
  const initializedTeamSelection = useRef(false);
  const previousActiveTeamId = useRef<string | null>(null);
  const [memoryVersion, setMemoryVersion] = useState(0);
  const activityFacts = useMemo(() => ir?.activities ?? [], [ir]);

  useEffect(() => {
    if (teamsLoading) return;
    const activeChanged = previousActiveTeamId.current !== activeTeamId;
    const firstSelection = !initializedTeamSelection.current;
    previousActiveTeamId.current = activeTeamId;
    initializedTeamSelection.current = true;
    setSelectedTeamIds((current) =>
      reconcileAtlasTeamSelection(
        current,
        activeTeams.map((team) => team.team_id),
        activeTeamId,
        firstSelection || activeChanged,
        MAX_SELECTED_TEAMS,
      ),
    );
  }, [activeTeamId, activeTeams, teamsLoading]);

  const load = useCallback(async () => {
    const sequence = requestGate.begin();
    if (selectedTeamIds.length === 0) {
      setIr(null);
      setLoading(false);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const nextIr = await teamAtlasApi.bootstrap([...selectedTeamIds].sort(), viewMode);
      if (!requestGate.isCurrent(sequence)) return;
      setIr(nextIr);
    } catch (err) {
      if (!requestGate.isCurrent(sequence)) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestGate.isCurrent(sequence)) setLoading(false);
    }
  }, [requestGate, selectedTeamIds, viewMode]);

  const refresh = useCallback(() => {
    memoryEpochGuard.advance();
    statusCache.current.clear();
    setMemoryVersion((version) => version + 1);
    void load();
  }, [load, memoryEpochGuard]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (focusTeamId && !selectedTeamIds.includes(focusTeamId)) {
      setFocusTeamId(null);
      setFocusAgentId(null);
    }
  }, [focusTeamId, selectedTeamIds]);

  const projection = useMemo(
    () =>
      ir
        ? projectAtlas(ir, {
            teamIds: selectedTeamIds,
            focusTeamId,
            focusAgentId,
            query,
            assetType,
            showUnboundAssets,
            showOtherOwners,
          })
        : null,
    [
      ir,
      selectedTeamIds,
      focusTeamId,
      focusAgentId,
      query,
      assetType,
      showUnboundAssets,
      showOtherOwners,
    ],
  );
  const layout = useMemo(() => (projection ? layoutAtlas(projection) : null), [projection]);
  const interactionEdges = useMemo(
    () => (layout ? atlasInteractionEdges(layout.edges) : []),
    [layout],
  );
  const displayedNodes = useMemo(
    () =>
      layout
        ? layout.nodes.map((node) => {
            const offset = node.team_id ? teamOffsets[node.team_id] : undefined;
            return offset ? { ...node, x: node.x + offset.x, y: node.y + offset.y } : node;
          })
        : [],
    [layout, teamOffsets],
  );
  const displayedNodesRef = useRef(displayedNodes);
  displayedNodesRef.current = displayedNodes;
  const canvasSize = useMemo(
    () => (layout ? atlasCanvasSize(layout, displayedNodes) : { width: 1160, height: 620 }),
    [displayedNodes, layout],
  );
  const graphHeight = atlasGraphHeight(canvasSize.height, canvasViewportHeight, isCanvasFullscreen);
  const summaryCards = useMemo(
    () => (ir ? summarizeAtlas(ir, selectedTeamIds) : []),
    [ir, selectedTeamIds],
  );

  const fitCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const svg = svgRef.current;
    if (!canvas || !svg || !layout) return;
    const canvasRect = canvas.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const contentBounds = atlasContentBounds(displayedNodesRef.current);
    if (contentBounds.width === 0 || contentBounds.height === 0) return;
    const viewScale = Math.max(
      0.001,
      Math.min(
        svgRect.width / Math.max(1, viewBox.width),
        svgRect.height / Math.max(1, viewBox.height),
      ),
    );
    const viewOffsetX = (svgRect.width - viewBox.width * viewScale) / 2;
    const viewOffsetY = (svgRect.height - viewBox.height * viewScale) / 2;
    const fitArea = atlasFitArea({
      canvasWidth: canvas.clientWidth,
      canvasHeight: canvas.clientHeight,
      viewportHeight: window.visualViewport?.height ?? window.innerHeight,
      canvasTop: canvasRect.top,
      fullscreen:
        canvas.closest('.team-atlas-workspace')?.classList.contains('is-fullscreen') ?? false,
    });
    const fitted = atlasFitViewport({
      areaWidth: fitArea.width,
      areaHeight: fitArea.height,
      contentWidth: contentBounds.width,
      contentHeight: contentBounds.height,
      viewScale,
    });
    setZoom(fitted.zoom);
    setPan({
      x: (fitted.paddingX - viewOffsetX) / viewScale - contentBounds.minX * fitted.zoom,
      y: (fitted.paddingY - viewOffsetY) / viewScale - contentBounds.minY * fitted.zoom,
    });
    canvas.scrollTo({ left: 0, top: 0 });
  }, [layout]);

  useEffect(() => {
    if (!layout) return;
    const syncCanvasViewport = () => {
      setCanvasViewportHeight(canvasRef.current?.clientHeight ?? 0);
      fitCanvas();
    };
    const frame = window.requestAnimationFrame(syncCanvasViewport);
    const observer = new ResizeObserver(syncCanvasViewport);
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fitCanvas, isCanvasFullscreen, layout]);

  useEffect(() => {
    if (!layout) return;
    let settledFrame = 0;
    const layoutFrame = window.requestAnimationFrame(() => {
      settledFrame = window.requestAnimationFrame(fitCanvas);
    });
    return () => {
      window.cancelAnimationFrame(layoutFrame);
      window.cancelAnimationFrame(settledFrame);
    };
  }, [fitCanvas, graphHeight, isCanvasFullscreen, layout]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setZoom((value) => Math.min(1.6, Math.max(0.2, value + (event.deltaY < 0 ? 0.08 : -0.08))));
    };
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [layout]);
  const activeId = selectedId;
  const activeNode = displayedNodes.find((node) => node.id === activeId) ?? null;
  const logicalActiveId = activeNode?.logical_id ?? activeNode?.id;
  const directNodeIds = useMemo(
    () => directVisualNodeIds(displayedNodes, interactionEdges, activeNode, ir?.mode ?? viewMode),
    [activeNode, displayedNodes, interactionEdges, ir?.mode, viewMode],
  );
  const activeEdgeIds = useMemo(() => {
    if (!activeNode) return new Set<string>();
    if (activeNode.type === 'task') {
      return taskLineageEdgeIds(interactionEdges, activeNode, ir?.mode ?? viewMode);
    }
    return new Set(
      interactionEdges
        .filter((edge) => edge.source === logicalActiveId || edge.target === logicalActiveId)
        .map((edge) => edge.id),
    );
  }, [activeNode, interactionEdges, ir?.mode, logicalActiveId, viewMode]);
  const activeRelations =
    activeNode && layout
      ? layout.edges
          .filter((edge) => edge.source === logicalActiveId || edge.target === logicalActiveId)
          .map((edge) => ({
            edge,
            outgoing: edge.source === logicalActiveId,
            peer: displayedNodes.find(
              (node) =>
                (node.logical_id ?? node.id) ===
                (edge.source === logicalActiveId ? edge.target : edge.source),
            ),
          }))
      : [];
  const activeTaskCounts =
    activeNode?.type === 'task' && ir ? taskFactCounts(ir, activeNode.entity_id) : null;
  const activeTaskActivities =
    activeNode?.type === 'task'
      ? activityFacts.filter((activity) => activity.task_id === activeNode.entity_id)
      : [];
  const memoryEntry =
    activeNode?.type === 'chat_memory' ? statusCache.current.get(activeNode.entity_id) : undefined;
  void memoryVersion;

  const fetchMemoryStatus = useCallback(
    (node: TeamAtlasNode) => {
      if (node.type !== 'chat_memory') return;
      if (node.metadata?.registered === false || node.metadata?.can_read === false) return;
      const cached = statusCache.current.get(node.entity_id);
      if (cached && cached.expires > Date.now()) return;
      const memoryEpoch = memoryEpochGuard.capture();
      statusCache.current.set(node.entity_id, { expires: Date.now() + STATUS_CACHE_MS });
      void teamAtlasApi
        .memoryStatus(node.entity_id)
        .then((value) => {
          if (!memoryEpochGuard.isCurrent(memoryEpoch)) return;
          statusCache.current.set(node.entity_id, { expires: Date.now() + STATUS_CACHE_MS, value });
          setMemoryVersion((version) => version + 1);
        })
        .catch((err) => {
          if (!memoryEpochGuard.isCurrent(memoryEpoch)) return;
          statusCache.current.set(node.entity_id, {
            expires: Date.now() + STATUS_CACHE_MS,
            error: err instanceof Error ? err.message : String(err),
          });
          setMemoryVersion((version) => version + 1);
        });
    },
    [memoryEpochGuard],
  );

  const onNodeClick = useCallback(
    (node: TeamAtlasNode) => {
      setSelectedId(node.id);
      fetchMemoryStatus(node);
    },
    [fetchMemoryStatus],
  );

  const openManagement = useCallback(
    (node: TeamAtlasNode) => {
      if (node.team_id) setActiveTeamId(node.team_id);
      navigate(atlasManagementPath(node.type));
    },
    [navigate, setActiveTeamId],
  );

  const nodeCaption = useCallback(
    (node: TeamAtlasNode) => {
      if (!layout) return '';
      const owner = node.metadata?.owner_user_id;
      if (node.type === 'identity')
        return `${node.entity_id} ${String(node.metadata?.role ?? '—')}`;
      if (node.type === 'team') return `${t('atlas.owner')} ${shortId(owner)}`;
      if (node.type === 'task') {
        const counts = ir ? taskFactCounts(ir, node.entity_id) : null;
        return `${t('atlas.owner')} ${shortId(node.metadata?.creator_user_id)} · L0 ${formatAtlasCount(counts?.messages ?? 0, counts?.countsExact ?? true)}`;
      }
      if (node.type === 'agent') return `${t('atlas.owner')} ${shortId(owner)}`;
      return `${t('atlas.visibility')} ${String(node.metadata?.visibility ?? '—')} · ${t('atlas.owner')} ${shortId(owner)}`;
    },
    [ir, layout, t],
  );

  if (teamsLoading || loading)
    return (
      <section className="team-atlas-state">
        <span className="team-atlas-spinner" />
        {t('atlas.loading')}
      </section>
    );
  if (error)
    return (
      <section className="team-atlas-state team-atlas-state--error">
        <p>{t('atlas.loadFailed')}</p>
        <code>{error}</code>
        <button type="button" onClick={refresh}>
          {t('atlas.retry')}
        </button>
      </section>
    );
  if (selectedTeamIds.length === 0)
    return <section className="team-atlas-state">{t('atlas.noTeams')}</section>;
  if (!ir || !layout || !projection) return null;

  const warningsByNode = new Map<string, TeamAtlasIR['warnings']>();
  for (const warning of ir.warnings) {
    if (!warning.node_id) continue;
    const current = warningsByNode.get(warning.node_id) ?? [];
    current.push(warning);
    warningsByNode.set(warning.node_id, current);
  }
  const partialSources = ir.warnings.filter((warning) => warning.code === 'SOURCE_PARTIAL').length;
  const teamOptions = [...activeTeams].sort((a, b) =>
    (a.name || a.team_id).localeCompare(b.name || b.team_id),
  );
  const selectedTeamLabel =
    selectedTeamIds.length === 1
      ? (teamOptions.find((team) => team.team_id === selectedTeamIds[0])?.name ??
        t('atlas.selectTeams'))
      : t('atlas.selectedTeams', { count: selectedTeamIds.length });
  const toggleTeam = (teamId: string) => {
    setSelectedId(null);
    setFocusTeamId(null);
    setFocusAgentId(null);
    setSelectedTeamIds((current) => {
      if (current.includes(teamId))
        return current.length === 1 ? current : current.filter((id) => id !== teamId);
      if (current.length >= MAX_SELECTED_TEAMS) return current;
      return [...current, teamId].sort();
    });
  };

  return (
    <section className="team-atlas-page" aria-label={t('atlas.title')}>
      <header className="team-atlas-header">
        <div className="team-atlas-summary" aria-label={t('atlas.summary')}>
          {[summaryCards.slice(0, 3), summaryCards.slice(3)].map((row, index) => (
            <div
              key={index}
              className={`team-atlas-summary-row team-atlas-summary-row--${index + 1}`}
            >
              {row.map((card) => (
                <span
                  key={card.type}
                  title={`${t(`atlas.type.${card.type}`)} · ${t('atlas.mineVisible')}`}
                >
                  <strong>
                    <b>{card.mine}</b>
                    <em>/</em>
                    {card.visible}
                  </strong>
                  <small>{t(`atlas.type.${card.type}`)}</small>
                </span>
              ))}
            </div>
          ))}
        </div>
        <div className="team-atlas-toolbar">
          <div className="team-atlas-toolbar-row team-atlas-toolbar-row--primary">
            <div className="team-atlas-mode" role="group" aria-label={t('atlas.mode.label')}>
              {(['actual', 'planned', 'all'] as TeamAtlasMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={viewMode === mode ? 'is-active' : ''}
                  aria-pressed={viewMode === mode}
                  onClick={() => {
                    setSelectedId(null);
                    setViewMode(mode);
                  }}
                >
                  {t(`atlas.mode.${mode}`)}
                </button>
              ))}
            </div>
            <label>
              <span className="sr-only">{t('atlas.search')}</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('atlas.search')}
              />
            </label>
            <label>
              <span className="sr-only">{t('atlas.assetType')}</span>
              <select
                value={assetType}
                onChange={(event) => setAssetType(event.target.value as TeamAtlasNodeType | 'all')}
              >
                {ASSET_OPTIONS.map((type) => (
                  <option key={type} value={type}>
                    {t(`atlas.type.${type}`)}
                  </option>
                ))}
              </select>
            </label>
            <details className="team-atlas-team-picker">
              <summary>{selectedTeamLabel}</summary>
              <div
                className="team-atlas-team-options"
                role="group"
                aria-label={t('atlas.selectTeams')}
              >
                {teamOptions.map((team) => (
                  <label key={team.team_id}>
                    <input
                      type="checkbox"
                      checked={selectedTeamIds.includes(team.team_id)}
                      disabled={
                        !selectedTeamIds.includes(team.team_id) &&
                        selectedTeamIds.length >= MAX_SELECTED_TEAMS
                      }
                      onChange={() => toggleTeam(team.team_id)}
                    />
                    {team.name || team.team_id}
                  </label>
                ))}
              </div>
            </details>
          </div>
          <div className="team-atlas-toolbar-row team-atlas-toolbar-row--secondary">
            <label className="team-atlas-switch">
              <input
                type="checkbox"
                checked={showUnboundAssets}
                onChange={(event) => setShowUnboundAssets(event.target.checked)}
              />
              <span>{t('atlas.showUnboundAssets')}</span>
            </label>
            <label className="team-atlas-switch">
              <input
                type="checkbox"
                checked={showOtherOwners}
                onChange={(event) => {
                  setSelectedId(null);
                  setShowOtherOwners(event.target.checked);
                }}
              />
              <span>{t('atlas.showOtherOwners')}</span>
            </label>
            {(focusTeamId || focusAgentId) && (
              <button
                type="button"
                className="team-atlas-secondary"
                onClick={() => {
                  setSelectedId(null);
                  if (focusAgentId) setFocusAgentId(null);
                  else setFocusTeamId(null);
                }}
              >
                {t(focusAgentId ? 'atlas.backToTeam' : 'atlas.backToOverview')}
              </button>
            )}
            <button type="button" className="team-atlas-secondary" onClick={refresh}>
              {t('atlas.refresh')}
            </button>
            <div className="team-atlas-zoom">
              <button
                type="button"
                aria-label={t('atlas.zoomOut')}
                onClick={() => setZoom((value) => Math.max(0.2, value - 0.1))}
              >
                −
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                aria-label={t('atlas.zoomIn')}
                onClick={() => setZoom((value) => Math.min(1.6, value + 0.1))}
              >
                +
              </button>
              <button type="button" onClick={fitCanvas}>
                {t('atlas.fit')}
              </button>
            </div>
          </div>
        </div>
      </header>

      {ir.completeness === 'partial' && (
        <div className="team-atlas-notice" role="status">
          {t('atlas.partial', { count: partialSources })}
        </div>
      )}
      {projection.truncated && (
        <div className="team-atlas-notice" role="status">
          {t('atlas.aggregated')}
        </div>
      )}
      {activeNode?.type === 'task' && activeNode.metadata?.activity_visibility === 'self_only' && (
        <div className="team-atlas-notice" role="status">
          {t('atlas.selfOnlyActivity')}
        </div>
      )}
      <div className="team-atlas-relation-guide" aria-label={t('atlas.relationGuide')}>
        <strong>{t('atlas.relationGuide')}</strong>
        <span>
          <i className="team-atlas-relation-swatch" />
          {t('atlas.configuredRelation')}
        </span>
        <span>
          <i className="team-atlas-relation-swatch team-atlas-relation-swatch--observed" />
          {t('atlas.observedRelation')}
        </span>
        <small>{t('atlas.relationExplanation')}</small>
      </div>

      <div className={`team-atlas-workspace${isCanvasFullscreen ? ' is-fullscreen' : ''}`}>
        <div ref={canvasRef} className="team-atlas-canvas">
          <div className={`team-atlas-canvas-actions${isCanvasFullscreen ? ' is-fullscreen' : ''}`}>
            {isCanvasFullscreen && (
              <button
                type="button"
                className="team-atlas-fullscreen-fit"
                aria-label={t('atlas.fit')}
                title={t('atlas.fit')}
                onClick={fitCanvas}
              >
                {t('atlas.fit')}
              </button>
            )}
            <button
              type="button"
              className="team-atlas-fullscreen-toggle"
              aria-label={t(isCanvasFullscreen ? 'atlas.exitFullscreen' : 'atlas.enterFullscreen')}
              title={t(isCanvasFullscreen ? 'atlas.exitFullscreen' : 'atlas.enterFullscreen')}
              onClick={() => setIsCanvasFullscreen((value) => !value)}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path
                  d={
                    isCanvasFullscreen
                      ? 'M8 2v6H2M12 2v6h6M8 18v-6H2M12 18v-6h6'
                      : 'M8 2H2v6M12 2h6v6M8 18H2v-6M12 18h6v-6'
                  }
                />
              </svg>
            </button>
          </div>
          <svg
            ref={svgRef}
            className="team-atlas-graph"
            role="img"
            aria-label={t('atlas.graphLabel')}
            viewBox={`0 0 ${canvasSize.width} ${graphHeight}`}
            style={{ width: canvasSize.width, height: graphHeight }}
            onPointerDown={(event) => {
              if (!(event.target as Element).closest('.team-atlas-node')) {
                event.currentTarget.setPointerCapture(event.pointerId);
                dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
              }
            }}
            onPointerMove={(event) => {
              const teamDrag = teamDragRef.current;
              if (teamDrag) {
                setTeamOffsets((current) => ({
                  ...current,
                  [teamDrag.teamId]: {
                    x: teamDrag.offsetX + (event.clientX - teamDrag.x) / zoom,
                    y: teamDrag.offsetY + (event.clientY - teamDrag.y) / zoom,
                  },
                }));
                return;
              }
              const drag = dragRef.current;
              if (drag)
                setPan({
                  x: drag.panX + (event.clientX - drag.x) / zoom,
                  y: drag.panY + (event.clientY - drag.y) / zoom,
                });
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
              teamDragRef.current = null;
              dragRef.current = null;
            }}
            onClick={(event) => {
              if (!(event.target as Element).closest('.team-atlas-node')) setSelectedId(null);
            }}
          >
            <defs>
              {RELATIONS.map((relation) => (
                <marker
                  key={relation}
                  id={`atlas-arrow-${relation}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path
                    className="team-atlas-arrow"
                    fill="context-stroke"
                    d="M 0 0 L 10 5 L 0 10 z"
                  />
                </marker>
              ))}
            </defs>
            <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
              <g className="team-atlas-edges">
                {interactionEdges.map((edge) => {
                  const geometry = edgeGeometry(edge, displayedNodes, interactionEdges);
                  if (!geometry.path) return null;
                  const targetNode = displayedNodes.find(
                    (node) => (node.logical_id ?? node.id) === edge.target,
                  );
                  const targetClass = targetNode
                    ? ` team-atlas-edge--target-${targetNode.type}`
                    : '';
                  const active = activeEdgeIds.has(edge.id);
                  return (
                    <g
                      key={edge.id}
                      className={`team-atlas-edge team-atlas-edge--${edge.type}${targetClass}${active ? ' is-active' : ''}`}
                    >
                      <path d={geometry.path} markerEnd={`url(#atlas-arrow-${edge.type})`} />
                    </g>
                  );
                })}
              </g>
              <g>
                {displayedNodes.map((node) => {
                  const logicalNodeId = node.logical_id ?? node.id;
                  const active = activeId === node.id;
                  const directlyRelated = directNodeIds.has(node.id);
                  const owned = isAtlasNodeOwnedByCurrent(node, ir.scope.user_id);
                  const nodeWarnings = warningsByNode.get(logicalNodeId) ?? [];
                  const caption = nodeCaption(node);
                  return (
                    <g
                      key={node.id}
                      className="team-atlas-node-position"
                      transform={`translate(${node.x} ${node.y})`}
                    >
                      <g
                        role="button"
                        tabIndex={0}
                        aria-label={`${node.type}: ${node.label}`}
                        className={`${nodeClass(node, owned)}${active ? ' is-active' : ''}${directlyRelated ? ' is-direct' : ''}`}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onNodeClick(node);
                        }}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          if (!isAtlasActivationKey(event.key)) return;
                          event.preventDefault();
                          event.stopPropagation();
                          onNodeClick(node);
                        }}
                      >
                        {node.type === 'team' && (
                          <g
                            className="team-atlas-team-drag-handle"
                            transform={`translate(${node.width / 2} -17)`}
                            aria-label={t('atlas.dragTeam')}
                            onPointerDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              svgRef.current?.setPointerCapture(event.pointerId);
                              const offset = teamOffsets[node.entity_id] ?? { x: 0, y: 0 };
                              teamDragRef.current = {
                                teamId: node.entity_id,
                                x: event.clientX,
                                y: event.clientY,
                                offsetX: offset.x,
                                offsetY: offset.y,
                              };
                            }}
                          >
                            <circle r="12" />
                            <path d="M0-8V8M-8 0H8M0-8l-3 3m3-3 3 3M0 8l-3-3m3 3 3-3M-8 0l3-3m-3 3 3 3M8 0 5-3m3 3-3 3" />
                          </g>
                        )}
                        <rect
                          width={node.width}
                          height={node.height}
                          rx={node.type === 'task' ? 8 : 12}
                        />
                        {node.type === 'task' ? (
                          <>
                            <text className="team-atlas-node-type" x="14" y="18">
                              {t('atlas.type.task')}
                              {node.status ? ` · ${node.status}` : ''}
                            </text>
                            <text
                              className="team-atlas-node-label team-atlas-node-label--task"
                              x="14"
                              y="41"
                            >
                              {node.label.length > 27 ? `${node.label.slice(0, 26)}…` : node.label}
                            </text>
                            <text className="team-atlas-node-caption" x="14" y="60">
                              {caption.length > 40 ? `${caption.slice(0, 39)}…` : caption}
                            </text>
                          </>
                        ) : (
                          <>
                            <text className="team-atlas-node-type" x="14" y="18">
                              {t(`atlas.type.${node.type}`)}
                              {node.status ? ` · ${node.status}` : ''}
                            </text>
                            <text className="team-atlas-node-label" x="14" y="41">
                              {node.label.length > 27 ? `${node.label.slice(0, 26)}…` : node.label}
                            </text>
                            <text className="team-atlas-node-caption" x="14" y="60">
                              {caption.length > 40 ? `${caption.slice(0, 39)}…` : caption}
                            </text>
                          </>
                        )}
                        {owned && (
                          <path
                            className="team-atlas-owner-star"
                            transform={`translate(${node.width - 18} 15)`}
                            d="M0-9 2.65-2.78 8.56-2.78 3.78 1.06 5.29 7.28 0 3.6-5.29 7.28-3.78 1.06-8.56-2.78-2.65-2.78Z"
                          />
                        )}
                        {nodeWarnings.length > 0 && (
                          <g
                            className="team-atlas-warning"
                            transform={`translate(${node.width - (owned ? 42 : 18)} 14)`}
                          >
                            <circle r="8" />
                            <text y="4">!</text>
                            <title>
                              {nodeWarnings.map((warning) => warning.message).join('\n')}
                            </title>
                          </g>
                        )}
                        <title>{`${node.label} · ${node.entity_id}`}</title>
                      </g>
                    </g>
                  );
                })}
              </g>
            </g>
          </svg>
        </div>

        <aside className="team-atlas-passport" aria-live="polite">
          <span className="team-atlas-eyebrow">PASSPORT</span>
          {activeNode ? (
            <>
              <h2>{activeNode.label}</h2>
              <span className="team-atlas-pill">{t(`atlas.type.${activeNode.type}`)}</span>
              <dl>
                <dt>ID</dt>
                <dd>{activeNode.entity_id}</dd>
                {activeNode.team_id && (
                  <>
                    <dt>Team</dt>
                    <dd>{activeNode.team_id}</dd>
                  </>
                )}
                {activeNode.status && (
                  <>
                    <dt>{t('atlas.status')}</dt>
                    <dd>{activeNode.status}</dd>
                  </>
                )}
                {activeNode.metadata?.owner_user_id && (
                  <>
                    <dt>{t('atlas.owner')}</dt>
                    <dd>{String(activeNode.metadata.owner_user_id)}</dd>
                  </>
                )}
                {activeNode.metadata?.creator_user_id && (
                  <>
                    <dt>{t('atlas.creator')}</dt>
                    <dd>{String(activeNode.metadata.creator_user_id)}</dd>
                  </>
                )}
                {activeNode.type === 'task' && activeNode.metadata?.source_type && (
                  <>
                    <dt>{t('atlas.source')}</dt>
                    <dd>{String(activeNode.metadata.source_type)}</dd>
                  </>
                )}
                {activeNode.type === 'task' && activeNode.metadata?.last_participated_at && (
                  <>
                    <dt>{t('atlas.lastActivity')}</dt>
                    <dd>{String(activeNode.metadata.last_participated_at)}</dd>
                  </>
                )}
                {activeNode.metadata?.visibility && (
                  <>
                    <dt>{t('atlas.visibility')}</dt>
                    <dd>{String(activeNode.metadata.visibility)}</dd>
                  </>
                )}
              </dl>
              {activeNode.type === 'team' && (
                <div className="team-atlas-passport-counts">
                  <span>Task {String(activeNode.metadata?.tasks ?? 0)}</span>
                  <span>Agent {String(activeNode.metadata?.agents ?? 0)}</span>
                  <span>Asset {String(activeNode.metadata?.assets ?? 0)}</span>
                </div>
              )}
              {activeNode.type === 'task' && activeTaskCounts && (
                <div className="team-atlas-passport-counts">
                  <span>
                    {t('atlas.plannedAgents')}{' '}
                    {formatAtlasCount(
                      activeTaskCounts.plannedAgents,
                      activeTaskCounts.plannedExact,
                    )}
                  </span>
                  <span>
                    {t('atlas.actualUsers')}{' '}
                    {formatAtlasCount(activeTaskCounts.activeUsers, activeTaskCounts.countsExact)}
                  </span>
                  <span>
                    {t('atlas.actualAgents')}{' '}
                    {formatAtlasCount(activeTaskCounts.activeAgents, activeTaskCounts.countsExact)}
                  </span>
                  <span>
                    Session{' '}
                    {formatAtlasCount(activeTaskCounts.sessions, activeTaskCounts.countsExact)}
                  </span>
                  <span>
                    L0 {formatAtlasCount(activeTaskCounts.messages, activeTaskCounts.countsExact)}
                  </span>
                  <span>
                    Init{' '}
                    {formatAtlasCount(
                      activeTaskCounts.participationEvents,
                      activeTaskCounts.countsExact,
                    )}
                  </span>
                </div>
              )}
              {activeNode.type === 'task' && activeTaskActivities.length > 0 && (
                <div className="team-atlas-passport-relations">
                  <strong>{t('atlas.activityEvidence')}</strong>
                  {activeTaskActivities.map((activity) => (
                    <span key={activity.id}>
                      {shortId(activity.user_id)} / {shortId(activity.agent_id)} ·{' '}
                      {activity.evidence} · S{' '}
                      {formatAtlasCount(activity.l0_session_count, activity.counts_exact)} · L0{' '}
                      {formatAtlasCount(activity.l0_message_count, activity.counts_exact)} · Init{' '}
                      {formatAtlasCount(activity.participation_event_count, activity.counts_exact)}
                      {!activity.counts_exact ? ` · ${t('atlas.lowerBound')}` : ''}
                    </span>
                  ))}
                </div>
              )}
              {activeNode.type === 'chat_memory' && (
                <div className="team-atlas-memory-status">
                  <strong>{t('atlas.memoryLayers')}</strong>
                  <span>
                    {memoryEntry?.error
                      ? t('atlas.statusUnavailable')
                      : statusText(memoryEntry?.value)}
                  </span>
                </div>
              )}
              {activeRelations.length > 0 && (
                <div className="team-atlas-passport-relations">
                  <strong>{t('atlas.connections')}</strong>
                  {activeRelations.map(({ edge, outgoing, peer }) => (
                    <span key={edge.id}>
                      <i
                        className={`team-atlas-relation-swatch team-atlas-relation-swatch--${edge.type}`}
                      />
                      {outgoing ? '→' : '←'} {t(`atlas.relation.${edge.type}`)} ·{' '}
                      {peer?.label ?? (outgoing ? edge.target : edge.source)}
                      {edge.metadata?.role_in_task
                        ? ` · ${t('atlas.role')} ${String(edge.metadata.role_in_task)}`
                        : ''}
                      {edge.metadata?.last_seen_at
                        ? ` · ${t('atlas.lastActivity')} ${String(edge.metadata.last_seen_at)}`
                        : ''}
                    </span>
                  ))}
                </div>
              )}
              {logicalActiveId && (warningsByNode.get(logicalActiveId)?.length ?? 0) > 0 && (
                <div className="team-atlas-passport-warnings">
                  {warningsByNode.get(logicalActiveId)?.map((warning) => (
                    <p
                      key={`${warning.code}:${warning.message}`}
                      className="team-atlas-passport-warning"
                    >
                      {warning.message}
                    </p>
                  ))}
                </div>
              )}
              {(activeNode.type === 'team' || activeNode.type === 'agent') &&
                (activeNode.type === 'team'
                  ? focusTeamId !== activeNode.entity_id || focusAgentId !== null
                  : focusAgentId !== activeNode.entity_id) && (
                  <button
                    type="button"
                    className="team-atlas-secondary"
                    onClick={() => {
                      setSelectedId(null);
                      if (activeNode.type === 'team') {
                        setFocusTeamId(activeNode.entity_id);
                        setFocusAgentId(null);
                      } else {
                        setFocusTeamId(activeNode.team_id ?? null);
                        setFocusAgentId(activeNode.entity_id);
                      }
                    }}
                  >
                    {t(activeNode.type === 'team' ? 'atlas.focusTeam' : 'atlas.focusAgent')}
                  </button>
                )}
              {!(activeNode.type === 'chat_memory' && activeNode.metadata?.can_read === false) && (
                <button
                  type="button"
                  className="team-atlas-primary"
                  onClick={() => openManagement(activeNode)}
                >
                  {t('atlas.openManagement')}
                </button>
              )}
            </>
          ) : (
            <p className="team-atlas-empty">{t('atlas.selectHint')}</p>
          )}
        </aside>
      </div>
    </section>
  );
}
