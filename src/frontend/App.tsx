import { useCallback, useEffect, useMemo, useState } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { CreateTicketModal } from "./components/CreateTicketModal";
import { KanbanBoard } from "./components/kanban-board/KanbanBoard";
import { ShellTerminal } from "./components/ShellTerminal";
import { Header } from "./components/layout/Header";
import { NotificationToast } from "./components/NotificationToast";
import { useNotificationWebSocket } from "./hooks/useWebSocket";
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
  const openShell = useCallback(() => setShellOpen(true), []);
  const closeShell = useCallback(() => setShellOpen(false), []);

  return (
    <div className="scanlines h-full flex flex-col bg-forge-black overflow-hidden">
      <Header onOpenShell={openShell} />
      <main className="flex-1 overflow-hidden">
        <KanbanBoard />
      </main>
      <CreateTicketModal />
      <NotificationToast />
      {shellOpen && <ShellTerminal onClose={closeShell} />}
    </div>
  );
}

export function App() {
  const { fetchTickets } = useStore();

  useNotificationWebSocket();

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const kanbanElement = useMemo(() => <KanbanPage />, []);
  const agentElement = useMemo(() => <AgentPage />, []);

  return (
    <>
      <NavigateFnRegistrar />
      <Routes>
        <Route path="/" element={kanbanElement} />
        <Route path="/agent/:ticketId" element={agentElement} />
      </Routes>
    </>
  );
}
