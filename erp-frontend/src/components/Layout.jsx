import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import Topbar from './Topbar'
import ToastHost from './Toast'

export default function Layout() {
  const [navOpen, setNavOpen] = useState(false)

  return (
    <div className="min-h-screen bg-oscenia">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="lg:pl-72">
        <Topbar onMenu={() => setNavOpen(true)} />
        <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-[1400px] mx-auto">
          <Outlet />
        </main>
      </div>
      <ToastHost />
    </div>
  )
}
