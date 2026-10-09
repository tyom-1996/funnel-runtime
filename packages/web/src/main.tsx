import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { FunnelPage } from './funnel/FunnelPage';
import { AdminPage } from './admin/AdminPage';
import { DashboardPage } from './dashboard/DashboardPage';
import { I18nProvider, LanguageSwitch } from './i18n';
import './styles.css';

function Nav() {
  const { pathname } = useLocation();
  // the switch only affects admin/dashboard chrome; funnel texts come from the config
  const showLang = pathname === '/admin' || pathname === '/dashboard';
  const item = (to: string, label: string) => (
    <Link to={to} className={pathname === to ? 'nav-link active' : 'nav-link'}>
      {label}
    </Link>
  );
  return (
    <nav className="nav">
      <Link to="/" className="brand">
        <span className="brand-mark" aria-hidden />
        <span>funnel-runtime</span>
      </Link>
      <div className="nav-right">
        <div className="nav-links">
          {item('/', 'Funnel')}
          {item('/admin', 'Admin')}
          {item('/dashboard', 'Dashboard')}
        </div>
        {showLang && <LanguageSwitch />}
      </div>
    </nav>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <BrowserRouter>
        <Nav />
        <Routes>
          <Route path="/" element={<FunnelPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
        </Routes>
      </BrowserRouter>
    </I18nProvider>
  </React.StrictMode>,
);
