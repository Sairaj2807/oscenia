import { Routes, Route, Navigate, Link } from 'react-router-dom'
import { canSee } from './lib/roles'
import { useStore } from './store/useStore'
import { useAuth } from './store/useAuth'
import AuthGate from './components/AuthGate'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import Finance from './pages/Finance'
import Cash from './pages/Cash'
import Receivables from './pages/Receivables'
import Payables from './pages/Payables'
import ProjectPnL from './pages/ProjectPnL'
import CRM from './pages/CRM'
import ClientDetail from './pages/ClientDetail'
import GoogleCalendar from './pages/GoogleCalendar'
import Vendors from './pages/Vendors'
import VendorDetail from './pages/VendorDetail'
import PurchaseOrders from './pages/PurchaseOrders'
import Procurement from './pages/Procurement'
import Warehouse from './pages/Warehouse'
import Payroll from './pages/Payroll'
import Sales from './pages/Sales'
import Quotations from './pages/Quotations'
import Accounting from './pages/Accounting'
import ChartOfAccounts from './pages/ChartOfAccounts'
import FixedAssets from './pages/FixedAssets'
import Simulator from './pages/Simulator'
import Budgeting from './pages/Budgeting'
import Survey from './pages/Survey'
import Cron from './pages/Cron'
import Workspace from './pages/workspace/Workspace'
import WorkspaceProject from './pages/workspace/WorkspaceProject'
import Chat from './pages/Chat'
import Events from './pages/events/Events'
import EventDetail from './pages/events/EventDetail'
import TemplateStudio from './pages/events/TemplateStudio'
import InvitePage from './pages/public/InvitePage'
import InviteEditPage from './pages/public/InviteEditPage'
import WalkInPage from './pages/public/WalkInPage'
import ResetPassword from './pages/public/ResetPassword'
import SurveyPage from './pages/public/SurveyPage'
import Users from './pages/Users'

// Home is the dashboard — unless the role has no dashboard (a team member), who lands in chat.
function Home() {
  const role = useStore((s) => s.role)
  return canSee(role, 'dashboard') ? <Dashboard /> : <Navigate to="/chat" replace />
}

// A page is only reachable by the roles whose sidebar shows it. Hiding the menu entry was the
// only protection before: typing the address opened any screen. The API refuses the data
// regardless; this keeps the screen itself closed too, with a clear answer instead of an
// empty page full of failed requests.
function Guard({ module, children }) {
  // The role as the server reported it; the business store only mirrors it a render later.
  const role = useAuth((s) => s.user?.role) ?? useStore.getState().role
  if (canSee(role, module)) return children
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <h1 className="font-display text-2xl text-white">No access to this page</h1>
      <p className="mt-2 text-sm text-white/50">
        Your role does not include this area. If you need it, ask an administrator.
      </p>
      <Link to="/" className="btn-gold mt-6 inline-flex">Back to start</Link>
    </div>
  )
}

const g = (module, element) => <Guard module={module}>{element}</Guard>

// The gate wraps the staff app's layout rather than the whole router, so a guest-facing page
// (an invitation's RSVP form, a walk-in sign-up) can sit beside it with no sign-in.
export default function App() {
  return (
    <Routes>
      {/* Guest-facing: no sign-in, no ERP layout. */}
      <Route path="invite/:eventId" element={<InvitePage />} />
      <Route path="invite/:eventId/edit" element={<InviteEditPage />} />
      <Route path="walkin/:eventId" element={<WalkInPage />} />
      <Route path="reset-password" element={<ResetPassword />} />
      <Route path="rate/:projectNo" element={<SurveyPage />} />

      <Route
        element={
          <AuthGate>
            <Layout />
          </AuthGate>
        }
      >
        <Route index element={<Home />} />
        <Route path="projects" element={g('projects', <Projects />)} />
        <Route path="projects/:id" element={g('projects', <ProjectDetail />)} />
        <Route path="finance" element={g('finance', <Finance />)} />
        <Route path="cash" element={g('cash', <Cash />)} />
        <Route path="receivables" element={g('receivables', <Receivables />)} />
        <Route path="payables" element={g('payables', <Payables />)} />
        <Route path="pnl" element={g('pnl', <ProjectPnL />)} />
        <Route path="accounting" element={g('accounting', <Accounting />)} />
        <Route path="accounts" element={g('coa', <ChartOfAccounts />)} />
        <Route path="fixed-assets" element={g('fixedassets', <FixedAssets />)} />
        <Route path="budgeting" element={g('budgeting', <Budgeting />)} />
        <Route path="simulator" element={g('simulator', <Simulator />)} />
        <Route path="cron" element={g('cron', <Cron />)} />
        {/* The survey is reached from Crew & Incentives. */}
        <Route path="survey" element={g('payroll', <Survey />)} />
        <Route path="users" element={g('users', <Users />)} />
        <Route path="crm" element={g('crm', <CRM />)} />
        <Route path="crm/:id" element={g('crm', <ClientDetail />)} />
        <Route path="google-calendar" element={g('gcal', <GoogleCalendar />)} />
        <Route path="vendors" element={g('vendors', <Vendors />)} />
        <Route path="vendors/:id" element={g('vendors', <VendorDetail />)} />
        <Route path="purchase-orders" element={g('purchaseorders', <PurchaseOrders />)} />
        <Route path="procurement" element={g('procurement', <Procurement />)} />
        <Route path="warehouse" element={g('warehouse', <Warehouse />)} />
        <Route path="payroll" element={g('payroll', <Payroll />)} />
        <Route path="quotations" element={g('quotations', <Quotations />)} />
        <Route path="sales" element={g('sales', <Sales />)} />
        <Route path="workspace" element={g('workspace', <Workspace />)} />
        <Route path="workspace/:projectId" element={g('workspace', <WorkspaceProject />)} />
        <Route path="chat" element={g('chat', <Chat />)} />
        <Route path="chat/:channelId" element={g('chat', <Chat />)} />
        <Route path="events" element={g('events', <Events />)} />
        {/* Ranked above events/:id by React Router, whatever the order. */}
        <Route path="events/templates" element={g('templates', <TemplateStudio />)} />
        <Route path="events/:id" element={g('events', <EventDetail />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
