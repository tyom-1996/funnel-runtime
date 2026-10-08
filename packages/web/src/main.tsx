import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { FunnelPage } from './funnel/FunnelPage';
import { AdminPage } from './admin/AdminPage';
import { DashboardPage } from './dashboard/DashboardPage';
import './styles.css';

function Nav() {
  const { pathname } = useLocation();
  const item = (to: string, label: string) => (
    <Link to={to} className={pathname === to ? 'nav-link active' : 'nav-link'}>
      {label}
    </Link>
  );
  return (
    <nav className="nav">
      <span className="brand">funnel-runtime</span>
      <div className="nav-links">
        {item('/', 'Funnel')}
        {item('/admin', 'Admin')}
        {item('/dashboard', 'Dashboard')}
      </div>
    </nav>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Nav />
      <Routes>
        <Route path="/" element={<FunnelPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
