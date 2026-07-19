import { create } from "zustand";

import { api } from "../lib/api";
import type {
  Agent,
  AcpAgentState,
  AppNotification,
  DiffResult,
  GitBranchInfo,
  PlanningSessionState,
  RemoteConfig,
  Ticket,
  TicketStatus,
} from "../types";

// Registered by NavigateFnRegistrar in App.tsx so the store can trigger navigation.
let navigateFn: ((path: string) => void) | null = null;
export function registerNavigate(fn: (path: string) => void) {
  navigateFn = fn;
}

interface AppState {
  // Data
  tickets: Ticket[];
  agents: Record<string, Agent>;
  notifications: AppNotification[];
  remoteConfig: RemoteConfig | null;
  currentBranch: string | null;
  agentDiffs: Record<string, DiffResult>;
  branches: GitBranchInfo[];
  acpStates: Record<string, AcpAgentState>;
  /** One planning session at a time, unlike agents which are per-ticket and concurrent. */
  planningState: PlanningSessionState | null;

  // UI — single concept: "active ticket" opens both terminal + diff
  activeTicketId: string | null;
  isCreateModalOpen: boolean;
  isFetchingTickets: boolean;

  // Derived helpers (computed from activeTicketId)
  getActiveTicket: () => Ticket | null;
  getActiveAgent: () => Agent | null;

  // Ticket actions
  fetchTickets: () => Promise<void>;
  addTicket: (ticket: Ticket) => void;
  updateTicket: (id: string, updates: Partial<Ticket>) => void;
  removeTicket: (id: string) => void;
  moveTicket: (ticketId: string, newStatus: TicketStatus) => Promise<void>;
  discardTicket: (ticketId: string) => Promise<void>;
  archiveTicket: (ticketId: string) => Promise<void>;
  unarchiveTicket: (ticketId: string) => Promise<void>;

  // Archive state
  archivedTickets: Ticket[];
  isArchiveOpen: boolean;
  isFetchingArchived: boolean;
  fetchArchivedTickets: () => Promise<void>;
  openArchive: () => void;
  closeArchive: () => void;

  // Agent actions
  setAgent: (agent: Agent) => void;
  updateAgent: (id: string, updates: Partial<Agent>) => void;

  // Notification actions
  addNotification: (n: Omit<AppNotification, "id" | "timestamp">) => void;
  dismissNotification: (id: string) => void;

  // Git state actions
  setCurrentBranch: (branch: string | null) => void;
  setAgentDiff: (agentId: string, diff: DiffResult) => void;
  setAcpState: (agentId: string, state: AcpAgentState) => void;
  setPlanningState: (state: PlanningSessionState) => void;

  // Branch actions
  fetchBranches: () => Promise<void>;

  // UI actions
  openTicket: (ticketId: string) => void;
  closeTicket: () => void;
  openCreateModal: () => void;
  closeCreateModal: () => void;
  setRemoteConfig: (config: RemoteConfig | null) => void;
}

let notifCounter = 0;
let branchFetchId = 0;

export const useStore = create<AppState>((set, get) => ({
  acpStates: {},
  planningState: null,
  activeTicketId: null,
  archivedTickets: [],
  isArchiveOpen: false,
  isFetchingArchived: false,
  addNotification: (n) => {
    const id = `notif-${(notifCounter += 1)}`;
    const notif: AppNotification = { ...n, id, timestamp: Date.now() };
    set((s) => ({ notifications: [notif, ...s.notifications].slice(0, 20) }));
    if (n.type === "info" || n.type === "agent-done") {
      setTimeout(() => get().dismissNotification(id), 5000);
    }
  },
  addTicket: (ticket) => set((s) => ({ tickets: [...s.tickets, ticket] })),
  agentDiffs: {},
  agents: {},
  branches: [],
  closeCreateModal: () => set({ isCreateModalOpen: false }),
  closeTicket: () => {
    set({ activeTicketId: null });
    navigateFn?.("/");
  },
  currentBranch: null,
  discardTicket: async (ticketId) => {
    const { tickets, agents, activeTicketId, closeTicket } = get();
    const ticket = tickets.find((t) => t.id === ticketId);
    if (!ticket) {
      return;
    }

    // Close panel if this ticket is open
    if (activeTicketId === ticketId) {
      closeTicket();
    }

    // Kill the agent if one is running
    if (ticket.agentId && agents[ticket.agentId]) {
      await api.agents.kill(ticket.agentId).catch(() => {
        /* empty */
      });
    }

    // Optimistic removal
    set((s) => ({ tickets: s.tickets.filter((t) => t.id !== ticketId) }));

    try {
      await api.tickets.delete(ticketId);
    } catch (error) {
      // Rollback
      set((s) => ({ tickets: [...s.tickets, ticket] }));
      get().addNotification({
        type: "error",
        message: `Delete failed: ${(error as Error).message}`,
      });
    }
  },
  archiveTicket: async (ticketId) => {
    const { tickets, activeTicketId, closeTicket } = get();
    const ticket = tickets.find((t) => t.id === ticketId);
    if (!ticket) return;

    if (activeTicketId === ticketId) closeTicket();

    // Optimistic removal from kanban
    set((s) => ({ tickets: s.tickets.filter((t) => t.id !== ticketId) }));

    try {
      const archived = await api.tickets.archive(ticketId);
      set((s) => ({ archivedTickets: [archived, ...s.archivedTickets] }));
    } catch (error) {
      set((s) => ({ tickets: [...s.tickets, ticket] }));
      get().addNotification({
        type: "error",
        message: `Archive failed: ${(error as Error).message}`,
      });
    }
  },
  closeArchive: () => set({ isArchiveOpen: false }),
  dismissNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
  fetchArchivedTickets: async () => {
    set({ isFetchingArchived: true });
    try {
      const archivedTickets = await api.tickets.listArchived();
      set({ archivedTickets });
    } catch (error) {
      get().addNotification({
        type: "error",
        message: `Failed to load archive: ${(error as Error).message}`,
      });
    } finally {
      set({ isFetchingArchived: false });
    }
  },
  openArchive: () => {
    set({ isArchiveOpen: true });
    get().fetchArchivedTickets();
  },
  unarchiveTicket: async (ticketId) => {
    const { archivedTickets } = get();
    const ticket = archivedTickets.find((t) => t.id === ticketId);
    if (!ticket) return;

    // Optimistic removal from archive list
    set((s) => ({ archivedTickets: s.archivedTickets.filter((t) => t.id !== ticketId) }));

    try {
      const restored = await api.tickets.unarchive(ticketId);
      set((s) => ({ tickets: [restored, ...s.tickets] }));
    } catch (error) {
      set((s) => ({ archivedTickets: [ticket, ...s.archivedTickets] }));
      get().addNotification({
        type: "error",
        message: `Restore failed: ${(error as Error).message}`,
      });
    }
  },
  fetchBranches: async () => {
    const id = (branchFetchId += 1);
    try {
      const { branches } = await api.remote.listBranches();
      if (id === branchFetchId) {
        set({ branches });
      }
    } catch {
      // ignore transient errors
    }
  },
  fetchTickets: async () => {
    set({ isFetchingTickets: true });
    try {
      // One call each, not one per ticket: `agents.list` mirrors `tickets.list` (both
      // exclude archived), so this hydrates every agent the board can show. Previously
      // this fanned out an `agents.get` per ticket with history — 20 tickets meant 20
      // IPC round-trips on every mount.
      const [tickets, agentList] = await Promise.all([api.tickets.list(), api.agents.list()]);
      // Merged, not replaced: this is a hydrate, so it must not evict an agent the store
      // already holds (one pushed by an `agent-updated` event, or one whose ticket was
      // archived while its detail panel is open — both are absent from the lists above).
      set((s) => ({
        agents: { ...s.agents, ...Object.fromEntries(agentList.map((a) => [a.id, a])) },
        tickets,
      }));
    } catch (error) {
      get().addNotification({
        type: "error",
        message: `Failed to load tickets: ${(error as Error).message}`,
      });
    } finally {
      set({ isFetchingTickets: false });
    }
  },
  getActiveAgent: () => {
    const ticket = get().getActiveTicket();
    if (!ticket?.agentId) {
      return null;
    }
    return get().agents[ticket.agentId] ?? null;
  },
  getActiveTicket: () => {
    const { activeTicketId, tickets } = get();
    return activeTicketId ? (tickets.find((t) => t.id === activeTicketId) ?? null) : null;
  },
  isCreateModalOpen: false,
  isFetchingTickets: false,
  moveTicket: async (ticketId, newStatus) => {
    const prev = get().tickets.find((t) => t.id === ticketId);
    if (!prev || prev.status === newStatus) {
      return;
    }

    set((s) => ({
      tickets: s.tickets.map((t) =>
        t.id === ticketId ? { ...t, status: newStatus, updatedAt: Date.now() } : t,
      ),
    }));

    try {
      const updated = await api.tickets.updateStatus(ticketId, newStatus);
      set((s) => ({
        tickets: s.tickets.map((t) => (t.id === ticketId ? updated : t)),
      }));
      if (newStatus === "in-progress") {
        get().openTicket(ticketId);
      }
    } catch (error) {
      set((s) => ({
        tickets: s.tickets.map((t) => (t.id === ticketId ? prev : t)),
      }));
      get().addNotification({
        type: "error",
        message: `Move failed: ${(error as Error).message}`,
      });
    }
  },
  notifications: [],
  openCreateModal: () => set({ isCreateModalOpen: true }),
  openTicket: (ticketId) => {
    set({ activeTicketId: ticketId });
    navigateFn?.(`/agent/${ticketId}`);
  },
  remoteConfig: null,
  removeTicket: (id) => set((s) => ({ tickets: s.tickets.filter((t) => t.id !== id) })),
  setAcpState: (agentId, state) =>
    set((s) => {
      const current = s.acpStates[agentId];
      if (current && current.updatedAt > state.updatedAt) {
        return s;
      }
      return { acpStates: { ...s.acpStates, [agentId]: state } };
    }),
  setPlanningState: (state) =>
    set((s) => {
      // Same staleness guard as setAcpState: a planning turn streams many updates and
      // ordering is not guaranteed, so an older snapshot must not clobber a newer one.
      if (s.planningState && s.planningState.updatedAt > state.updatedAt) {
        return s;
      }
      return { planningState: state };
    }),
  setAgent: (agent) => set((s) => ({ agents: { ...s.agents, [agent.id]: agent } })),
  setAgentDiff: (agentId, diff) =>
    set((s) => ({ agentDiffs: { ...s.agentDiffs, [agentId]: diff } })),
  setCurrentBranch: (currentBranch) => set({ currentBranch }),
  setRemoteConfig: (remoteConfig) => set({ remoteConfig }),
  tickets: [],
  updateAgent: (id, updates) =>
    set((s) => ({
      agents: {
        ...s.agents,
        ...(s.agents[id] ? { [id]: { ...s.agents[id], ...updates } } : {}),
      },
    })),
  updateTicket: (id, updates) =>
    set((s) => ({
      tickets: s.tickets.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),
}));

export const selectTicketsByStatus = (status: TicketStatus) => (s: AppState) =>
  s.tickets.filter((t) => t.status === status);
