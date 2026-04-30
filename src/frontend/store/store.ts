import { create } from "zustand";
import type {
  Agent,
  AppNotification,
  DiffResult,
  GitBranchInfo,
  RemoteConfig,
  Ticket,
  TicketStatus,
} from "../types";
import { api } from "../lib/api";

// Registered by NavigateFnRegistrar in App.tsx so the store can trigger navigation.
let _navigate: ((path: string) => void) | null = null;
export function registerNavigate(fn: (path: string) => void) {
  _navigate = fn;
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

  // UI — single concept: "active ticket" opens both terminal + diff
  activeTicketId: string | null;
  isCreateModalOpen: boolean;
  isConnected: boolean;
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

  // Agent actions
  setAgent: (agent: Agent) => void;
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  fetchAgentForTicket: (ticketId: string) => Promise<void>;

  // Notification actions
  addNotification: (n: Omit<AppNotification, "id" | "timestamp">) => void;
  dismissNotification: (id: string) => void;

  // Git state actions
  setCurrentBranch: (branch: string | null) => void;
  setAgentDiff: (agentId: string, diff: DiffResult) => void;

  // Branch actions
  fetchBranches: () => Promise<void>;

  // UI actions
  openTicket: (ticketId: string) => void;
  closeTicket: () => void;
  openCreateModal: () => void;
  closeCreateModal: () => void;
  setConnected: (connected: boolean) => void;
  setRemoteConfig: (config: RemoteConfig | null) => void;
}

let notifCounter = 0;

export const useStore = create<AppState>((set, get) => ({
  tickets: [],
  agents: {},
  notifications: [],
  remoteConfig: null,
  currentBranch: null,
  agentDiffs: {},
  branches: [],
  activeTicketId: null,
  isCreateModalOpen: false,
  isConnected: false,
  isFetchingTickets: false,

  getActiveTicket: () => {
    const { activeTicketId, tickets } = get();
    return activeTicketId ? (tickets.find((t) => t.id === activeTicketId) ?? null) : null;
  },

  getActiveAgent: () => {
    const ticket = get().getActiveTicket();
    if (!ticket?.agentId) return null;
    return get().agents[ticket.agentId] ?? null;
  },

  fetchTickets: async () => {
    set({ isFetchingTickets: true });
    try {
      const tickets = await api.tickets.list();
      set({ tickets });
      // Also load agents for any in-progress or review tickets
      const needAgents = tickets.filter(
        (t) => t.agentId && (t.status === "in-progress" || t.status === "review"),
      );
      await Promise.all(needAgents.map((t) => get().fetchAgentForTicket(t.id)));
    } catch (err) {
      get().addNotification({
        type: "error",
        message: `Failed to load tickets: ${(err as Error).message}`,
      });
    } finally {
      set({ isFetchingTickets: false });
    }
  },

  fetchAgentForTicket: async (ticketId) => {
    const ticket = get().tickets.find((t) => t.id === ticketId);
    if (!ticket?.agentId) return;
    try {
      const agent = await api.agents.get(ticket.agentId);
      set((s) => ({ agents: { ...s.agents, [agent.id]: agent } }));
    } catch {
      // agent may not exist yet — that's OK
    }
  },

  addTicket: (ticket) => set((s) => ({ tickets: [...s.tickets, ticket] })),

  updateTicket: (id, updates) =>
    set((s) => ({
      tickets: s.tickets.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),

  removeTicket: (id) => set((s) => ({ tickets: s.tickets.filter((t) => t.id !== id) })),

  discardTicket: async (ticketId) => {
    const { tickets, agents, activeTicketId, closeTicket } = get();
    const ticket = tickets.find((t) => t.id === ticketId);
    if (!ticket) return;

    // Close panel if this ticket is open
    if (activeTicketId === ticketId) closeTicket();

    // Kill the agent if one is running
    if (ticket.agentId && agents[ticket.agentId]) {
      await api.agents.kill(ticket.agentId).catch(() => {});
    }

    // Optimistic removal
    set((s) => ({ tickets: s.tickets.filter((t) => t.id !== ticketId) }));

    try {
      await api.tickets.delete(ticketId);
    } catch (err) {
      // Rollback
      set((s) => ({ tickets: [...s.tickets, ticket] }));
      get().addNotification({ type: "error", message: `Delete failed: ${(err as Error).message}` });
    }
  },

  moveTicket: async (ticketId, newStatus) => {
    const prev = get().tickets.find((t) => t.id === ticketId);
    if (!prev || prev.status === newStatus) return;

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
    } catch (err) {
      set((s) => ({
        tickets: s.tickets.map((t) => (t.id === ticketId ? prev : t)),
      }));
      get().addNotification({ type: "error", message: `Move failed: ${(err as Error).message}` });
    }
  },

  setAgent: (agent) => set((s) => ({ agents: { ...s.agents, [agent.id]: agent } })),

  updateAgent: (id, updates) =>
    set((s) => ({
      agents: {
        ...s.agents,
        ...(s.agents[id] ? { [id]: { ...s.agents[id], ...updates } } : {}),
      },
    })),

  addNotification: (n) => {
    const id = `notif-${++notifCounter}`;
    const notif: AppNotification = { ...n, id, timestamp: Date.now() };
    set((s) => ({ notifications: [notif, ...s.notifications].slice(0, 20) }));
    if (n.type === "info" || n.type === "agent-done") {
      setTimeout(() => get().dismissNotification(id), 5000);
    }
  },

  dismissNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),

  openTicket: (ticketId) => {
    set({ activeTicketId: ticketId });
    _navigate?.(`/agent/${ticketId}`);
  },
  closeTicket: () => {
    set({ activeTicketId: null });
    _navigate?.("/");
  },
  openCreateModal: () => set({ isCreateModalOpen: true }),
  closeCreateModal: () => set({ isCreateModalOpen: false }),
  fetchBranches: async () => {
    try {
      const { branches } = await api.remote.listBranches();
      set({ branches });
    } catch {
      // ignore transient errors
    }
  },

  setConnected: (isConnected) => set({ isConnected }),
  setRemoteConfig: (remoteConfig) => set({ remoteConfig }),
  setCurrentBranch: (currentBranch) => set({ currentBranch }),
  setAgentDiff: (agentId, diff) =>
    set((s) => ({ agentDiffs: { ...s.agentDiffs, [agentId]: diff } })),
}));

export const selectTicketsByStatus = (status: TicketStatus) => (s: AppState) =>
  s.tickets.filter((t) => t.status === status);
