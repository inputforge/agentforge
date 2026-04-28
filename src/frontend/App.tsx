import { useCallback, useEffect, useMemo, useState } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { CreateTicketModal } from "./components/CreateTicketModal";
import { IntegrationsModal } from "./components/IntegrationsModal";
import { KanbanBoard } from "./components/kanban-board/KanbanBoard";
import { ShellTerminal } from "./components/ShellTerminal";
import { Header } from "./components/layout/Header";
import { NotificationToast } from "./components/NotificationToast";
import { SessionSocketProvider } from "./hooks/useSessionSocket";
import { AgentPage } from "./pages/AgentPage";
import { registerNavigate, useStore } from "./store";

function NavigateFnRegistrar() {
  const navigate = useNavigate();
  useEffect(() => {
    registerNavigate(navigate);
  }, [navigate]);
  return null;
}

function KanbanPage() {
  const [shellOpen, setShellOpen] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const openShell = useCallback(() => setShellOpen(true), []);
  const closeShell = useCallback(() => setShellOpen(false), []);
  const openIntegrations = useCallback(() => setIntegrationsOpen(true), []);
  const closeIntegrations = useCallback(() => setIntegrationsOpen(false), []);

  return (
    <div className="h-full flex flex-col bg-forge-black overflow-hidden">
      <Header onOpenShell={openShell} onOpenIntegrations={openIntegrations} />
      <main className="flex-1 overflow-hidden">
        <KanbanBoard />
      </main>
      <CreateTicketModal />
      <IntegrationsModal open={integrationsOpen} onClose={closeIntegrations} />
      <NotificationToast />
      {shellOpen && <ShellTerminal onClose={closeShell} />}
    </div>
  );
}

export function App() {
  const { fetchTickets } = useStore();

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const kanbanElement = useMemo(() => <KanbanPage />, []);
  const agentElement = useMemo(() => <AgentPage />, []);

  return (
    <SessionSocketProvider>
      <NavigateFnRegistrar />
      <Routes>
        <Route path="/" element={kanbanElement} />
        <Route path="/agent/:ticketId" element={agentElement} />
      </Routes>
    </SessionSocketProvider>
  );
}
