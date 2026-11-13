type SortBy = "" | "priority" | "due" | "expires";

interface FilterPanelProps {
  agents: [string, string][]; agent: string; kinds: string[]; kind: string;
  projects: string[]; project: string; priorityMax: string; sortBy: SortBy;
  snoozedOnly: boolean; filtersOn: number;
  setFilter: (update: () => void) => void;
  setAgent: (value: string) => void; setKind: (value: string) => void;
  setProject: (value: string) => void; setPriorityMax: (value: string) => void;
  setSortBy: (value: SortBy) => void; setSnoozedOnly: (value: boolean) => void;
  setHistory: (value: boolean) => void; clearFilters: () => void;
}

export function FilterPanel({ agents, agent, kinds, kind, projects, project, priorityMax, sortBy, snoozedOnly, filtersOn, setFilter, setAgent, setKind, setProject, setPriorityMax, setSortBy, setSnoozedOnly, setHistory, clearFilters }: FilterPanelProps) {
  const fieldLabelClass = "mb-1 ml-0.5 block text-xs font-semibold text-muted-foreground";
  const selectClass = "h-11 w-full min-w-0 rounded-xl border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const toggleClass = "flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-border px-3 text-sm font-medium aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  // A popover under the row, right-aligned under Filter, over the cards.
  const popoverClass = "absolute right-0 top-full z-30 mt-2 w-[300px] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-border bg-card p-3.5 text-card-foreground shadow-[0_12px_32px_-12px_rgb(0_0_0/0.35)]";
  return <div id="home-feed-filters" role="group" aria-label="Filter" className={popoverClass}>
    {agents.length > 1 && <label className="mb-2.5 block"><span className={fieldLabelClass}>Agent</span>
      <select aria-label="Filter by agent" className={selectClass} value={agent} onChange={(event) => { const value = event.target.value; setFilter(() => setAgent(value)); }}><option value="">All agents</option>{agents.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>}
    <div className="grid grid-cols-2 gap-2">
      <label className="mb-2.5 block min-w-0"><span className={fieldLabelClass}>Type</span>
        <select aria-label="Filter by type" className={selectClass} value={kind} onChange={(event) => { const value = event.target.value; setFilter(() => setKind(value)); }}><option value="">All types</option>{kinds.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      {projects.length > 0 && <label className="mb-2.5 block min-w-0"><span className={fieldLabelClass}>Project</span>
        <select aria-label="Filter by project" className={selectClass} value={project} onChange={(event) => { const value = event.target.value; setFilter(() => setProject(value)); }}><option value="">All projects</option>{projects.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
      <label className="mb-2.5 block min-w-0"><span className={fieldLabelClass}>Priority</span>
        <select aria-label="Filter by priority" className={selectClass} value={priorityMax} onChange={(event) => { const value = event.target.value; setFilter(() => setPriorityMax(value)); }}>
          <option value="">Any priority</option>{[0, 1, 2, 3, 4].map((level) => <option key={level} value={level}>{level === 0 ? "P0 only" : `P0 to P${level}`}</option>)}
        </select></label>
      <label className="mb-2.5 block min-w-0"><span className={fieldLabelClass}>Order</span>
        <select aria-label="Order" className={selectClass} value={sortBy} onChange={(event) => setSortBy(event.target.value as SortBy)}>
          <option value="">Usual order</option><option value="priority">Priority first</option><option value="due">Due first</option><option value="expires">Expires first</option>
        </select></label>
    </div>
    <div className="mb-3 mt-1 h-px bg-border" />
    <div className="flex gap-2">
      <button type="button" aria-pressed={snoozedOnly} onClick={() => setFilter(() => { setSnoozedOnly(!snoozedOnly); setHistory(false); })} className={toggleClass}>Snoozed</button>
      {!!filtersOn && <button type="button" className={toggleClass} onClick={clearFilters}>Clear filter</button>}
    </div>
  </div>;
}
