import { useCallback, useEffect, useMemo, useState } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";

import { ArchiveDrawer } from "./components/ArchiveDrawer";
import { CreateTicketModal } from "./components/CreateTicketModal";
import { IntegrationsModal } from "./components/IntegrationsModal";
import { KanbanBoard } from "./components/kanban-board/KanbanBoard";
import { Header } from "./components/layout/Header";
import { TicketListView } from "./components/list-view/TicketListView";
import { NotificationToast } from "./components/NotificationToast";
import { ShellTerminal } from "./components/ShellTerminal";
import { SessionSocketProvider } from "./hooks/useSessionSocket";
import { AgentPage } from "./pages/AgentPage";
import { PlanningPage } from "./pages/PlanningPage";
import { registerNavigate, useStore } from "./store";

function NavigateFnRegistrar() {
  const navigate = useNavigate();
  useEffect(() => {
    registerNavigate(navigate);
  }, [navigate]);
  return null;
}

function KanbanPage() {
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const { isArchiveOpen, openArchive, closeArchive, viewMode } = useStore();
  const openIntegrations = useCallback(() => setIntegrationsOpen(true), []);
  const closeIntegrations = useCallback(() => setIntegrationsOpen(false), []);

  return (
    <div className="h-full flex flex-col bg-forge-black overflow-hidden">
      <Header onOpenIntegrations={openIntegrations} onOpenArchive={openArchive} />
      <main className="flex-1 overflow-hidden">
        {viewMode === "list" ? <TicketListView /> : <KanbanBoard />}
      </main>
      <CreateTicketModal />
      <IntegrationsModal open={integrationsOpen} onClose={closeIntegrations} />
      {isArchiveOpen && <ArchiveDrawer onClose={closeArchive} />}
    </div>
  );
}

export function App() {
  const { fetchTickets, fetchBranches, isShellOpen, closeShell } = useStore();

  useEffect(() => {
    fetchTickets();
    fetchBranches();
  }, [fetchTickets, fetchBranches]);

  const kanbanElement = useMemo(() => <KanbanPage />, []);
  const agentElement = useMemo(() => <AgentPage />, []);
  const planningElement = useMemo(() => <PlanningPage />, []);

  return (
    <SessionSocketProvider>
      <NavigateFnRegistrar />
      <Routes>
        <Route path="/" element={kanbanElement} />
        <Route path="/agent/:ticketId" element={agentElement} />
        <Route path="/plan" element={planningElement} />
      </Routes>
      {/* Rendered here, not inside KanbanPage: ShellTerminal holds a live PTY that is
          killed on unmount. If it only rendered on the "/" route, navigating to an
          agent or the planning route — including via an OS notification's deep link —
          would silently kill an open shell. It is a viewport-fixed overlay (see its own
          `fixed bottom-0` styling), so rendering it here works unchanged over any route. */}
      {isShellOpen && <ShellTerminal onClose={closeShell} />}
      <NotificationToast />
    </SessionSocketProvider>
  );
}
